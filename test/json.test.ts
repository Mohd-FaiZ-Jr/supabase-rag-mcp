import assert from "node:assert/strict";
import test from "node:test";
import { parseJsonDocument } from "../src/parser/json.js";
import { chunkMarkdown } from "../src/ingestion/chunker.js";
import { indexDocument } from "../src/ingestion/index-document.js";

function file(path: string, value: unknown) {
  return {
    path,
    filename: path.split("/").pop() ?? path,
    content: Buffer.from(JSON.stringify(value)),
    owner: "acme",
    repository: "docs",
    branch: "main"
  };
}

function chunks(path: string, value: unknown) {
  const parsed = parseJsonDocument(file(path, value));
  return { parsed, chunks: chunkMarkdown({ path, content: parsed.document.content, documentType: parsed.documentType }) };
}

test("normalizes a project BRD into six Markdown sections", () => {
  const { parsed, chunks: result } = chunks("documents/BRD/brd.json", { brd: {
    project_overview: "Overview", objectives: ["Objective"], stakeholders: ["Operations"], scope: "Payments", governance: "Change board", success_criteria: ["No defects"]
  } });
  assert.equal(parsed.documentType, "BRD");
  assert.equal(result.length, 6);
  assert.match(result[0].content, /Project Overview/);
});

test("normalizes business rules and preserves status metadata", () => {
  const { parsed, chunks: result } = chunks("documents/BRD/business-rules.json", { business_rules: [{ id: "BR-1", rule: "Approve transfers", priority: "High", status: "draft", source: "Policy", related_roles: ["Maker", "Checker"] }] });
  assert.equal(parsed.documentType, "BRD");
  assert.equal(parsed.chunkMetadata[0].rule_status, "draft");
  assert.match(result[0].content, /Related Roles: Maker, Checker/);
});

test("normalizes requirements with status metadata", () => {
  const { parsed, chunks: result } = chunks("documents/BRD/requirements.json", { requirements: [{ id: "FR-1", description: "Create transfer", functional_behaviour: "Validate account", priority: "High", status: "approved", business_rules: ["BR-1"], data_entities: ["Payment"], scope: "Release 1" }] });
  assert.equal(parsed.documentType, "BRD");
  assert.equal(parsed.chunkMetadata[0].rule_status, "approved");
  assert.match(result[0].content, /Functional Behaviour: Validate account/);
});

test("normalizes acceptance criteria", () => {
  const { parsed, chunks: result } = chunks("documents/BRD/acceptance.json", { acceptance_criteria: [{ id: "AC-1", requirement_id: "FR-1", criterion: "Transfer succeeds" }] });
  assert.equal(parsed.documentType, "BRD");
  assert.match(result[0].content, /Requirement: FR-1/);
});

test("normalizes data entities and fields", () => {
  const { parsed, chunks: result } = chunks("documents/BRD/data-spec.json", { data_entities: [{ name: "Payment", description: "A transfer", fields: [{ name: "amount", type: "decimal", description: "Value", validation: "positive", constraint: "required" }], validations: ["Currency required"] }] });
  assert.equal(parsed.documentType, "BRD");
  assert.match(result[0].content, /amount \(decimal\) - Value; positive; required/);
});

test("normalizes open questions", () => {
  const { parsed, chunks: result } = chunks("documents/OPEN_QUESTIONS/open_questions.json", { open_questions: [{ id: "Q-1", question: "Which limits apply?", status: "open", priority: "High", source: "Workshop" }] });
  assert.equal(parsed.documentType, "OPEN_QUESTION");
  assert.match(result[0].content, /Question: Which limits apply\?/);
});

test("normalizes an empty error catalogue as an open question", () => {
  const { parsed, chunks: result } = chunks("documents/OPEN_QUESTIONS/error_catalogue.json", { errors: [], note: "The catalogue is pending." });
  assert.equal(parsed.documentType, "OPEN_QUESTION");
  assert.match(result[0].content, /No error codes are currently defined\. The catalogue is pending\./);
});

test("normalizes planned UAT cases as TEST_CASE content", () => {
  const { parsed, chunks: result } = chunks("documents/TEST_CASES/uat_cases.json", { uat_cases: [{ id: "TC-1", acceptance_criterion_id: "AC-1", requirement_id: "FR-1", precondition: "Account exists", steps: ["Enter amount", "Submit"], expected_result: "Transfer is created" }] });
  assert.equal(parsed.documentType, "TEST_CASE");
  assert.match(result[0].content, /PLANNED — not yet executed/);
  assert.match(result[0].content, /1\. Enter amount 2\. Submit/);
});

test("rejects malformed JSON with a specific path", () => {
  assert.throws(() => parseJsonDocument({ ...file("documents/BRD/bad.json", {}), content: Buffer.from("{bad") }), /Invalid JSON in documents\/BRD\/bad\.json/);
});

test("skips coverage reports", () => {
  const parsed = parseJsonDocument(file("documents/OPEN_QUESTIONS/coverage.json", { coverage_report: { total: 80 } }));
  assert.equal(parsed.skipped, true);
});

test("unchanged JSON content is skipped on re-ingestion", async () => {
  const parsed = parseJsonDocument(file("documents/BRD/rules.json", { business_rules: [{ id: "BR-1", rule: "Approve", status: "draft" }] }));
  let inserted = 0;
  const supabase = {
    getDocumentByPath: async () => inserted === 0 ? null : { id: "doc-1", githubPath: parsed.document.path, contentHash: parsed.contentHash },
    upsertDocument: async (record: { content_hash: string }) => ({ id: "doc-1", githubPath: parsed.document.path, contentHash: record.content_hash }),
    deleteDocumentChunks: async () => undefined,
    insertDocumentChunks: async () => { inserted += 1; },
    verifyIndexedDocument: async () => undefined
  };
  const gemini = { embedDocument: async () => Array.from({ length: 1536 }, () => 0.01) };
  const options = { documentType: parsed.documentType, contentHash: parsed.contentHash, chunkMetadata: parsed.chunkMetadata };
  const first = await indexDocument(parsed.document, gemini as never, supabase as never, { log: () => undefined }, options);
  const second = await indexDocument(parsed.document, gemini as never, supabase as never, { log: () => undefined }, options);
  assert.equal(first.status, "indexed");
  assert.equal(second.status, "skipped");
  assert.equal(inserted, 1);
});