import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/server.js";

test("health endpoint returns service status without secrets", async () => {
  const app = createApp({ supabaseUrl: "", supabaseServiceRoleKey: "", geminiApiKey: "", geminiEmbeddingModel: "gemini-embedding-2", embeddingDimension: 1536, defaultTopK: 5, port: 3000, githubToken: "", githubOwner: "", githubRepo: "", githubBranch: "main" });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  assert.deepEqual(await response.json(), { status: "ok", service: "banking-rag-mcp" });
  server.close();
});