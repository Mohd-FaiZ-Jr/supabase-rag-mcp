import assert from "node:assert/strict";
import test from "node:test";
import type { AppConfig } from "../src/config.js";
import { GeminiEmbeddingService } from "../src/services/gemini.js";
import { indexDocument } from "../src/ingestion/index-document.js";

const config: AppConfig = {
  supabaseUrl: "https://example.supabase.co",
  supabaseServiceRoleKey: "test-service-role-key",
  geminiApiKey: "test-gemini-key",
  geminiEmbeddingModel: "gemini-embedding-2",
  embeddingDimension: 1536,
  defaultTopK: 5,
  port: 3000,
  githubToken: "test-github-token",
  githubOwner: "acme",
  githubRepo: "docs",
  githubBranch: "main",
  geminiEmbeddingMinDelayMs: 1
};

function embeddingResponse() {
  return { embeddings: [{ values: Array.from({ length: 1536 }, () => 0.01) }] };
}

function quotaError(retryDelay: string): Error {
  return new Error(JSON.stringify({ code: 429, status: "RESOURCE_EXHAUSTED", details: [{ retryDelay }] }));
}

test("parses retryDelay, waits before retrying, and completes ingestion", async () => {
  let calls = 0;
  const client = {
    embedContent: async () => {
      calls += 1;
      if (calls === 1) throw quotaError("0.03s");
      return embeddingResponse();
    }
  };
  const gemini = new GeminiEmbeddingService(config, client);
  let inserted = 0;
  const supabase = {
    getDocumentByPath: async () => null,
    upsertDocument: async (record: { content_hash: string }) => ({ id: "doc-1", githubPath: "documents/BRD/retry.md", contentHash: record.content_hash }),
    deleteDocumentChunks: async () => undefined,
    getDocumentChunkIndexes: async () => new Set<number>(),
    insertDocumentChunks: async () => { inserted += 1; },
    verifyIndexedDocument: async () => undefined
  };
  const startedAt = Date.now();
  const result = await indexDocument({
    path: "documents/BRD/retry.md",
    filename: "retry.md",
    content: "# Overview\n\nContent",
    owner: "acme",
    repository: "docs",
    branch: "main"
  }, gemini, supabase as never, { log: () => undefined });

  assert.equal(result.status, "indexed");
  assert.equal(calls, 2);
  assert.equal(inserted, 1);
  assert.ok(Date.now() - startedAt >= 30);
});

test("caps persistent RESOURCE_EXHAUSTED retries at three attempts", async () => {
  let calls = 0;
  const client = {
    embedContent: async () => {
      calls += 1;
      throw quotaError("0.01s");
    }
  };
  const gemini = new GeminiEmbeddingService(config, client);
  await assert.rejects(() => gemini.embedQuery("quota test"), /Gemini embedding request failed/);
  assert.equal(calls, 3);
});

test("reuses persisted chunks after a later embedding failure", async () => {
  let calls = 0;
  let insertedChunks: number[] = [];
  const client = {
    embedContent: async () => {
      calls += 1;
      if (calls === 2) throw new Error("temporary Gemini failure");
      return embeddingResponse();
    }
  };
  const gemini = new GeminiEmbeddingService({ ...config, geminiEmbeddingMinDelayMs: 1 }, client);
  const document = {
    path: "documents/BRD/resume.md",
    filename: "resume.md",
    content: "# First\n\nOne\n\n# Second\n\nTwo",
    owner: "acme",
    repository: "docs",
    branch: "main"
  };
  let stored = false;
  let storedHash = "";
  const supabase = {
    getDocumentByPath: async () => stored ? { id: "doc-1", githubPath: document.path, contentHash: storedHash } : null,
    upsertDocument: async (record: { content_hash: string }) => { stored = true; storedHash = record.content_hash; return { id: "doc-1", githubPath: document.path, contentHash: record.content_hash }; },
    deleteDocumentChunks: async () => { insertedChunks = []; },
    getDocumentChunkIndexes: async () => new Set(insertedChunks),
    insertDocumentChunks: async (chunks: Array<{ chunk_index: number }>) => { insertedChunks.push(...chunks.map((chunk) => chunk.chunk_index)); },
    verifyIndexedDocument: async (_id: string, expected: number) => {
      if (insertedChunks.length !== expected) throw new Error("incomplete");
    }
  };
  await assert.rejects(() => indexDocument(document, gemini, supabase as never, { log: () => undefined }));
  const resumedGemini = new GeminiEmbeddingService({ ...config, geminiEmbeddingMinDelayMs: 1 }, { embedContent: async () => embeddingResponse() });
  const result = await indexDocument(document, resumedGemini, supabase as never, { log: () => undefined });
  assert.equal(result.status, "indexed");
  assert.deepEqual(insertedChunks, [0, 1]);
});