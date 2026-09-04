import assert from "node:assert/strict";
import test from "node:test";
import { chunkMarkdown } from "../src/ingestion/chunker.js";

test("Markdown chunks preserve section context and requirement metadata", () => {
  const chunks = chunkMarkdown({
    path: "documents/BRD/transaction-reference.md",
    documentType: "BRD",
    content: "# Requirement\n\n## Requirement ID\nTRX-REF-001\n\n## Business Rules\nAfter a successful transfer, create a unique reference."
  });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].metadata.requirement_id, "TRX-REF-001");
  assert.equal(chunks[1].metadata.section, "Business Rules");
  assert.match(chunks[1].content, /Requirement > Business Rules/);
});