import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { ingestUATObservations } from "../src/ingestion/uat-observation.js";
import { parseUATWorkbook } from "../src/parser/uat-excel.js";

const path = "documents/UAT/2026/login/UAT_Observation_Report_TC-LOGIN-001.xlsx";

function workbookBuffer(sheets: Record<string, unknown[][]>): Buffer {
  const workbook = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

const rows = [
  ["UAT execution export"],
  ["Observation ID", "Test Case ID", "Expected Behaviour", "Actual Behaviour", "Evidence Reference", "Root Cause", "Resolution Status"],
  ["OBS-001", "TC-LOGIN-001", "User can log in", "Login returns an error", "screenshot-1.png", "Historical note", "Closed"],
  [],
  ["OBS-002", "TC-LOGIN-001", "User sees dashboard", "Dashboard is blank", "video-2.mp4", "", ""]
];

test("parses multiple observations, skips blanks, and preserves source traceability", () => {
  const result = parseUATWorkbook(workbookBuffer({ "UAT Observations": rows }), path);
  assert.equal(result.observations.length, 2);
  assert.deepEqual(result.observations[0].source, { githubPath: path, sheetName: "UAT Observations", rowNumber: 3 });
  assert.deepEqual(result.observations[0].evidenceReferences, ["screenshot-1.png"]);
  assert.equal(result.observations[0].evaluation?.rootCause, "Historical note");
  assert.equal(result.observations[0].actualBehavior, "Login returns an error");
});

test("discovers multiple observation sheets and does not leak evaluation fields into case input", () => {
  const result = parseUATWorkbook(workbookBuffer({ Notes: [["not a data sheet"]], Login: rows, Payments: [rows[1], ["OBS-003", "TC-PAY-001", "Payment succeeds", "Payment rejected", ""]] }), path);
  assert.deepEqual(result.sheets, ["Login", "Payments"]);
  assert.equal(result.observations[0].evaluation?.resolutionStatus, "Closed");
  assert.equal("rootCause" in result.observations[0], false);
});

test("rejects malformed workbooks and invalid observation rows", () => {
  assert.throws(() => parseUATWorkbook(Buffer.from("not an xlsx"), path), /no recognizable UAT observation sheet/);
  assert.throws(() => parseUATWorkbook(workbookBuffer({ Sheet1: [["Observation ID", "Expected Behaviour"]] }), path), /actualBehavior/);
  assert.throws(() => parseUATWorkbook(workbookBuffer({ Sheet1: [["Observation ID", "Expected Behaviour", "Actual Behaviour"], ["", "expected", "actual"]] }), path), /must include/);
  assert.throws(() => parseUATWorkbook(workbookBuffer({ Sheet1: [["Observation ID", "Expected Behaviour", "Actual Behaviour"], ["OBS-1", "expected", "actual"], ["OBS-1", "expected", "actual"]] }), path), /Duplicate observation ID/);
});

test("re-ingestion creates once, skips unchanged rows, and updates changed rows", async () => {
  const records = new Map<string, { id: string; hash: string }>();
  const supabase = {
    upsertUATObservation: async (record: { source_github_path: string; observation_id: string; content_hash: string }) => {
      const key = `${record.source_github_path}:${record.observation_id}`;
      const existing = records.get(key);
      if (existing?.hash === record.content_hash) return { id: existing.id, created: false, changed: false };
      const id = existing?.id ?? `id-${records.size + 1}`;
      records.set(key, { id, hash: record.content_hash });
      return { id, created: !existing, changed: true };
    },
    upsertUATEvaluation: async () => undefined
  };
  const parsed = parseUATWorkbook(workbookBuffer({ UAT: rows }), path);
  const first = await ingestUATObservations(parsed.observations, parsed.sheets, supabase as never);
  const second = await ingestUATObservations(parsed.observations, parsed.sheets, supabase as never);
  const changed = { ...parsed.observations[0], actualBehavior: "Login now returns a different error" };
  const third = await ingestUATObservations([changed], parsed.sheets, supabase as never);
  assert.equal(first.observationsCreated, 2);
  assert.equal(second.observationsCreated, 0);
  assert.equal(second.observationsUpdated, 0);
  assert.equal(third.observationsUpdated, 1);
});
