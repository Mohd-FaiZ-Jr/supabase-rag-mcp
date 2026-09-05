import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { chunkMarkdown } from "../src/ingestion/chunker.js";
import { ingestUATObservations } from "../src/ingestion/uat-observation.js";
import { buildUATDocumentContent, parseUATWorkbook } from "../src/parser/uat-excel.js";
import { indexDocument } from "../src/ingestion/index-document.js";
import { createSearchHandler } from "../src/tools/search.js";

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

test("explicitly skips template and dropdown sheets while parsing real observation aliases", () => {
  const result = parseUATWorkbook(workbookBuffer({
    Instructions: [
      ["Test Case ID", "TC-LOGIN-001"],
      ["Application URL", "https://uat.example.test/login"],
      ["Column Mapping", "Observation ID | Observation Title | Expected Behaviour | Actual Behaviour"]
    ],
    _Dropdowns: [["Severity", "Resolution Status", "Expected Behaviour", "Actual Behaviour"], ["High", "Closed", "x", "y"]],
    "UAT Observations": [[
      "S.No", "Observation ID", "Module", "Observation Title", "Expected Behaviour", "Actual Behaviour", "Severity", "Root Cause", "Resolution / Decision Notes", "Resolution Status"
    ], ["1", "OBS-001", "Login", "Invalid password rejected", "User is rejected", "Error is shown", "High", "Validation defect", "Fix validation", "Open"]],
    "Summary Dashboard": [["Test Case ID", "Test Case Title", "Overall Status", "Expected Result", "Actual Result", "Behavioral Delta"], ["TC-LOGIN-001", "Login flow", "Failed", "Login succeeds", "Login fails", "Error displayed"]]
  }), path);
  assert.deepEqual(result.sheets, ["UAT Observations"]);
  assert.equal(result.testCase, "TC-LOGIN-001");
  assert.equal(result.applicationUrl, "https://uat.example.test/login");
  assert.equal(result.observations[0].title, "Invalid password rejected");
  assert.equal(result.observations[0].expectedBehavior, "User is rejected");
  assert.equal(result.summary?.behavioralDelta, "Error displayed");
});

test("renders one chunk per observation and one summary chunk with self-contained context", () => {
  const result = parseUATWorkbook(workbookBuffer({
    Instructions: [["Test Case ID", "TC-LOGIN-001"], ["Application URL", "https://uat.example.test/login"]],
    "UAT Observations": [["Observation ID", "Module", "Observation Title", "Expected Behaviour", "Actual Behaviour", "Severity", "Root Cause", "Resolution/Decision Notes", "Resolution Status"], ["OBS-001", "Login", "Title", "Expected", "Actual", "Medium", "Cause", "Decision", "Closed"]],
    "Summary Dashboard": [["Test Case ID", "Test Case Title", "Overall Status", "Expected Result", "Actual Result", "Behavioral Delta"], ["TC-LOGIN-001", "Login flow", "Failed", "Expected result", "Actual result", "Delta"]]
  }), path);
  const content = buildUATDocumentContent(result);
  const chunks = chunkMarkdown({ path, content, documentType: "UAT" });
  assert.equal(chunks.length, 2);
  assert.match(chunks[0].content, /Test Case: TC-LOGIN-001/);
  assert.match(chunks[0].content, /Application: https:\/\/uat\.example\.test\/login/);
  assert.match(chunks[0].content, /Expected Behaviour: Expected/);
  assert.match(chunks[0].content, /Resolution Status: Closed/);
  assert.match(chunks[1].content, /Test Case Title: Login flow/);
  assert.match(chunks[1].content, /Behavioral Delta: Delta/);
  assert.equal(chunks[0].metadata.document_type, "UAT");
  assert.equal(chunks[1].metadata.document_type, "UAT");
});

test("indexes UAT chunks through the shared path and skips unchanged re-ingestion", async () => {
  const result = parseUATWorkbook(workbookBuffer({
    Instructions: [["Test Case ID", "TC-LOGIN-001"]],
    "UAT Observations": [["Observation ID", "Expected Behaviour", "Actual Behaviour"], ["OBS-001", "Expected", "Actual"]],
    "Summary Dashboard": [["Test Case ID", "Test Case Title", "Overall Status", "Expected Result", "Actual Result", "Behavioral Delta"], ["TC-LOGIN-001", "Login", "Failed", "Expected", "Actual", "Delta"]]
  }), path);
  const document = { path, filename: "uat.xlsx", content: buildUATDocumentContent(result), owner: "acme", repository: "docs", branch: "main" };
  let stored: { id: string; contentHash: string } | undefined;
  let insertedChunks = 0;
  const supabase = {
    getDocumentByPath: async () => stored ? { id: stored.id, githubPath: path, contentHash: stored.contentHash } : null,
    upsertDocument: async (record: { content_hash: string }) => { stored = { id: "uat-document", contentHash: record.content_hash }; return { id: stored.id, githubPath: path, contentHash: stored.contentHash }; },
    deleteDocumentChunks: async () => undefined,
    insertDocumentChunks: async (chunks: unknown[]) => { insertedChunks += chunks.length; },
    verifyIndexedDocument: async () => undefined
  };
  const gemini = { embedDocument: async () => Array.from({ length: 1536 }, () => 0.01) };
  const first = await indexDocument(document, gemini as never, supabase as never);
  const second = await indexDocument(document, gemini as never, supabase as never);
  assert.equal(first.status, "indexed");
  assert.equal(first.chunkCount, 2);
  assert.equal(second.status, "skipped");
  assert.equal(insertedChunks, 2);
});

test("search handler accepts UAT document filtering", async () => {
  let requestedType: string | undefined;
  const handler = createSearchHandler({ embedQuery: async () => [0.01] } as never, {
    searchDocuments: async (_embedding: number[], _count: number, documentType?: string) => { requestedType = documentType; return []; }
  } as never, 5);
  const response = await handler({ query: "login error", documentType: "UAT" });
  assert.equal(requestedType, "UAT");
  assert.match(response.content[0].text, /"count": 0/);
});
