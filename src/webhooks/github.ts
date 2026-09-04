import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import type { AppConfig } from "../config.js";
import { indexDocument } from "../ingestion/index-document.js";
import { GeminiEmbeddingService } from "../services/gemini.js";
import { GithubService } from "../services/github.js";
import { SupabaseService } from "../services/supabase.js";

type RawBodyRequest = Request & { rawBody?: Buffer };
type WebhookLogger = Pick<Console, "log" | "error">;

export type GithubWebhookDependencies = {
  github: Pick<GithubService, "getMarkdownFile">;
  gemini: GeminiEmbeddingService;
  supabase: SupabaseService;
  logger?: WebhookLogger;
};

type PushPayload = {
  ref?: unknown;
  repository?: { name?: unknown; owner?: { login?: unknown } };
  commits?: unknown;
  head_commit?: { added?: unknown; modified?: unknown; removed?: unknown } | null;
};

type FileResult = { path: string; status?: string; reason?: string };

export function createGithubWebhookHandler(config: AppConfig, provided?: GithubWebhookDependencies) {
  let dependencies = provided;
  const getDependencies = (): GithubWebhookDependencies => {
    dependencies ??= {
      github: new GithubService(config),
      gemini: new GeminiEmbeddingService(config),
      supabase: new SupabaseService(config)
    };
    return dependencies;
  };

  return async (request: Request, response: Response): Promise<void> => {
    const event = request.header("x-github-event");
    if (!event) {
      response.status(400).json({ ok: false, error: "missing_event" });
      return;
    }

    const rawBody = (request as RawBodyRequest).rawBody;
    if (!rawBody || !isValidSignature(request.header("x-hub-signature-256"), rawBody, config.githubWebhookSecret ?? "")) {
      response.status(401).json({ ok: false, error: "invalid_signature" });
      return;
    }

    if (event !== "push") {
      response.json({ ok: true, ignored: true, reason: "unsupported_event" });
      return;
    }

    const payload = request.body as PushPayload;
    if (!isPushPayload(payload)) {
      response.status(400).json({ ok: false, error: "malformed_push_payload" });
      return;
    }

    const owner = payload.repository?.owner?.login;
    const repository = payload.repository?.name;
    if (owner !== config.githubOwner || repository !== config.githubRepo) {
      response.json({ ok: true, ignored: true, reason: "repository_mismatch" });
      return;
    }

    const branchRef = `refs/heads/${config.githubBranch}`;
    if (payload.ref !== branchRef) {
      response.json({ ok: true, ignored: true, reason: "branch_mismatch" });
      return;
    }

    const logger = dependencies?.logger ?? console;
    const changed = collectChangedFiles(payload);
    logger.log(`GitHub webhook received: ${owner}/${repository}, changed files: ${changed.size}`);
    const processed: FileResult[] = [];
    const ignored: FileResult[] = [];
    const removed: FileResult[] = [];
    const dependencySet = getDependencies();
    let ingestionFailed = false;

    for (const [path, change] of changed) {
      const classification = classifyPath(path);
      if (change.removed) {
        if (classification === "supported") removed.push({ path, status: "ignored", reason: "deletion_not_supported" });
        else ignored.push({ path, reason: classification });
        continue;
      }
      if (classification !== "supported") {
        ignored.push({ path, reason: classification });
        continue;
      }

      try {
        logger.log(`Ingesting: ${path}`);
        const document = await dependencySet.github.getMarkdownFile(path);
        const result = await indexDocument(document, dependencySet.gemini, dependencySet.supabase, logger);
        processed.push({ path, status: result.status === "skipped" ? "skipped" : "ingested" });
        logger.log(`Ingestion successful: ${path}`);
      } catch (error) {
        ingestionFailed = true;
        processed.push({ path, status: "failed" });
        logger.error("Ingestion failed", {
          path,
          errorName: error instanceof Error ? error.name : "UnknownError",
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
      }
    }

    response.status(ingestionFailed ? 502 : 200).json({
      ok: !ingestionFailed,
      event: "push",
      repository: `${owner}/${repository}`,
      branch: config.githubBranch,
      processed,
      ignored,
      removed
    });
  };
}

function isValidSignature(header: string | undefined, body: Buffer, secret: string): boolean {
  if (!secret || !header) return false;
  const match = /^sha256=([a-f0-9]{64})$/i.exec(header);
  if (!match) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(body).digest("hex"), "utf8");
  const received = Buffer.from(match[1], "utf8");
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function isPushPayload(payload: PushPayload): boolean {
  return Boolean(
    payload &&
      typeof payload === "object" &&
      typeof payload.ref === "string" &&
      payload.repository &&
      typeof payload.repository === "object" &&
      typeof payload.repository.name === "string" &&
      typeof payload.repository.owner?.login === "string"
  );
}

function collectChangedFiles(payload: PushPayload): Map<string, { removed: boolean }> {
  const files = new Map<string, { removed: boolean }>();
  const commits = Array.isArray(payload.commits) && payload.commits.length > 0 ? payload.commits : [payload.head_commit];
  for (const commit of commits) {
    if (!commit || typeof commit !== "object") continue;
    const record = commit as Record<string, unknown>;
    addPaths(files, record.added, false);
    addPaths(files, record.modified, false);
    addPaths(files, record.removed, true);
  }
  return files;
}

function addPaths(files: Map<string, { removed: boolean }>, value: unknown, removed: boolean): void {
  if (!Array.isArray(value)) return;
  for (const path of value) {
    if (typeof path !== "string") continue;
    const normalized = normalizePath(path);
    if (normalized) files.set(normalized, { removed: files.get(normalized)?.removed || removed });
  }
}

function normalizePath(path: string): string | null {
  const normalized = path.replace(/\\/g, "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => part === ".." || part === ".")) return null;
  return normalized;
}

function classifyPath(path: string): string {
  if (!path.startsWith("documents/")) return "outside_documents";
  if (!path.toLowerCase().endsWith(".md")) return "unsupported_file_type";
  if (!/^documents\/(?:BRD|RCA)\/.+\.md$/i.test(path)) return "unsupported_document_path";
  return "supported";
}