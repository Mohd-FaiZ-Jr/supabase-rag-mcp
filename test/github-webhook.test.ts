import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import assert from "node:assert/strict";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { createApp } from "../src/server.js";
import type { AppConfig } from "../src/config.js";
import type { GithubWebhookDependencies } from "../src/webhooks/github.js";

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
  githubWebhookSecret: "test-webhook-secret"
};

function createDependencies() {
  const calls: string[] = [];
  const dependencies = {
    github: { getMarkdownFile: async (path: string) => ({ path, filename: path.split("/").pop() ?? path, content: "# Requirement\n\nIndexed content.", owner: "acme", repository: "docs", branch: "main" }) },
    gemini: { embedDocument: async () => Array.from({ length: 1536 }, () => 0.01) },
    supabase: {
      getDocumentByPath: async () => null,
      upsertDocument: async (record: { github_path: string; content_hash: string }) => ({ id: record.github_path, githubPath: record.github_path, contentHash: record.content_hash }),
      deleteDocumentChunks: async () => undefined,
      insertDocumentChunks: async () => undefined,
      verifyIndexedDocument: async () => undefined
    },
    logger: { log: () => undefined, error: () => undefined }
  } as unknown as GithubWebhookDependencies;
  const originalGetMarkdownFile = dependencies.github.getMarkdownFile;
  dependencies.github.getMarkdownFile = async (path: string) => {
    calls.push(path);
    return originalGetMarkdownFile(path);
  };
  return { dependencies, calls };
}

async function requestWebhook(payload: unknown, options: { event?: string; secret?: string; config?: AppConfig; dependencies?: GithubWebhookDependencies; omitSignature?: boolean } = {}) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const secret = options.secret ?? config.githubWebhookSecret ?? "";
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  const app = createApp(options.config ?? config, options.dependencies);
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fetch(`http://127.0.0.1:${port}/webhook/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": options.event ?? "push",
        ...(options.omitSignature ? {} : { "x-hub-signature-256": signature })
      },
      body
    });
  } finally {
    await close(server);
  }
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function pushPayload(files: { added?: string[]; modified?: string[]; removed?: string[] }[], repository = "docs", ref = "refs/heads/main") {
  return {
    ref,
    repository: { name: repository, owner: { login: "acme" } },
    commits: files.map((file) => ({ ...file }))
  };
}

async function json(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

test("valid push ingests Markdown files and deduplicates multiple commits", async () => {
  const { dependencies, calls } = createDependencies();
  const response = await requestWebhook(pushPayload([
    { added: ["documents/BRD/a.md", "documents/BRD/a.md"] },
    { modified: ["documents/BRD/b.md"], added: ["documents/RCA/RCA-001.md", "README.md"] }
  ]), { dependencies });
  const result = await json(response);
  assert.equal(response.status, 200);
  assert.equal(result.ok, true);
  assert.deepEqual(calls.sort(), ["documents/BRD/a.md", "documents/BRD/b.md", "documents/RCA/RCA-001.md"]);
  assert.equal(result.ignored.some((item: any) => item.path === "README.md"), true);
});

test("invalid and missing signatures never invoke ingestion", async () => {
  const { dependencies, calls } = createDependencies();
  const payload = pushPayload([{ added: ["documents/BRD/test.md"] }]);
  const invalid = await requestWebhook(payload, { dependencies, secret: "wrong-secret" });
  assert.equal(invalid.status, 401);
  assert.equal((await json(invalid)).error, "invalid_signature");
  const missing = await requestWebhook(payload, { dependencies, omitSignature: true });
  assert.equal(missing.status, 401);
  assert.equal((await json(missing)).error, "invalid_signature");
  assert.equal(calls.length, 0);
});

test("wrong repository and branch are safely ignored", async () => {
  const { dependencies, calls } = createDependencies();
  const wrongRepository = await requestWebhook(pushPayload([{ added: ["documents/BRD/test.md"] }], "other-docs"), { dependencies });
  assert.equal(wrongRepository.status, 200);
  assert.equal((await json(wrongRepository)).reason, "repository_mismatch");
  const wrongBranch = await requestWebhook(pushPayload([{ added: ["documents/BRD/test.md"] }], "docs", "refs/heads/feature/test"), { dependencies });
  assert.equal(wrongBranch.status, 200);
  assert.equal((await json(wrongBranch)).reason, "branch_mismatch");
  assert.equal(calls.length, 0);
});

test("unsupported events are acknowledged without ingestion", async () => {
  const { dependencies, calls } = createDependencies();
  const response = await requestWebhook({}, { event: "pull_request", dependencies });
  assert.equal(response.status, 200);
  assert.deepEqual(await json(response), { ok: true, ignored: true, reason: "unsupported_event" });
  assert.equal(calls.length, 0);
});

test("malformed JSON is rejected safely", async () => {
  const { dependencies, calls } = createDependencies();
  const response = await requestWebhook("{not-json", { dependencies });
  assert.equal(response.status, 400);
  assert.deepEqual(await json(response), { error: "Invalid JSON request" });
  assert.equal(calls.length, 0);
});

test("ingestion failures log the underlying error and return 502", async () => {
  const logs: unknown[][] = [];
  const dependencies = createDependencies().dependencies;
  dependencies.gemini.embedDocument = async () => {
    throw new Error("Gemini embedding request failed (503)");
  };
  dependencies.logger = { log: () => undefined, error: (...args: unknown[]) => logs.push(args) };

  const response = await requestWebhook(pushPayload([{ added: ["documents/BRD/failing.md"] }]), { dependencies });
  const result = await json(response);
  assert.equal(response.status, 502);
  assert.equal(result.ok, false);
  assert.equal(logs.length, 1);
  assert.equal(logs[0][0], "Ingestion failed");
  assert.deepEqual(logs[0][1], {
    path: "documents/BRD/failing.md",
    errorName: "Error",
    error: "Gemini embedding request failed (503)",
    stack: (logs[0][1] as { stack: string }).stack
  });
  assert.match((logs[0][1] as { stack: string }).stack, /Gemini embedding request failed \(503\)/);
});

test("unsupported formats, unrelated files, unsafe paths, and removals are reported", async () => {
  const { dependencies, calls } = createDependencies();
  const response = await requestWebhook(pushPayload([{
    added: ["documents/BRD/test.csv", "documents/BRD/test.docx", "src/example.ts", "documents/../secrets.md"],
    removed: ["documents/RCA/old.md"]
  }]), { dependencies });
  const result = await json(response);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 0);
  assert.equal(result.ignored.some((item: any) => item.reason === "unsupported_file_type"), true);
  assert.equal(result.ignored.some((item: any) => item.reason === "outside_documents"), true);
  assert.equal(result.removed[0].reason, "deletion_not_supported");
});