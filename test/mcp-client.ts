import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const port = 3100;
const baseUrl = `http://127.0.0.1:${port}`;
let serverProcess: ChildProcess | undefined;

test("Banking RAG MCP interface", async () => {
  const projectRoot = resolve(fileURLToPath(import.meta.url), "../..");
  const tsxEntry = resolve(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
  serverProcess = spawn(process.execPath, [tsxEntry, "src/start.ts"], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  try {
    await waitForHealth();
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok", service: "banking-rag-mcp" });

    const initialized = await mcpRequest("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "banking-rag-mcp-test-client", version: "0.1.0" }
    });
    assert.equal(initialized.error, undefined);

    const tools = await mcpRequest("tools/list");
    const toolNames = (tools.result?.tools as Array<{ name: string }>).map((tool) => tool.name);
    assert.deepEqual(toolNames.sort(), ["get_banking_requirement", "search_banking_knowledge", "search_previous_rca"]);

    const general = await callTool("search_banking_knowledge", { query: "What should happen after a successful money transfer?" });
    assert.match(general, /transaction-reference\.md/);
    assert.match(general, /TRX-REF-001/);
    console.log(`MCP general result: ${general.slice(0, 500)}`);
    console.log("MCP general search: PASS");

    const brd = await callTool("search_banking_knowledge", { query: "What happens after a successful money transfer?", documentType: "BRD" });
    assert.match(brd, /"documentType": "BRD"/);
    assert.doesNotMatch(brd, /"documentType": "RCA"/);
    console.log("MCP BRD filtering: PASS");

    const rca = await callTool("search_banking_knowledge", { query: "Why was the transaction reference missing?", documentType: "RCA" });
    assert.match(rca, /RCA-001\.md/);
    assert.doesNotMatch(rca, /"documentType": "BRD"/);
    console.log("MCP RCA filtering: PASS");

    const previousRca = await callTool("search_previous_rca", { query: "transaction reference missing after successful transfer" });
    assert.match(previousRca, /RCA-001\.md/);
    assert.doesNotMatch(previousRca, /"documentType": "BRD"/);
    console.log(`MCP previous RCA result: ${previousRca.slice(0, 500)}`);
    console.log("MCP previous RCA: PASS");

    const requirement = await callTool("get_banking_requirement", { requirementId: "TRX-REF-001" });
    assert.match(requirement, /"found": true/);
    assert.match(requirement, /transaction-reference\.md/);
    console.log(`MCP requirement result: ${requirement.slice(0, 500)}`);
    console.log("MCP exact requirement: PASS");

    const missing = await callTool("get_banking_requirement", { requirementId: "NONEXISTENT-999" });
    assert.match(missing, /"found": false/);
    console.log("MCP missing requirement: PASS");

    const invalidQuery = await callTool("search_banking_knowledge", { query: "", topK: 5 });
    assert.match(invalidQuery, /invalid|expected|string/i);
    console.log("MCP invalid query: PASS");

    const invalidType = await callTool("search_banking_knowledge", { query: "transaction reference", documentType: "INVALID" });
    assert.match(invalidType, /invalid|enum|BRD|RCA/i);
    console.log("MCP invalid document type: PASS");

    const invalidTopK = await callTool("search_banking_knowledge", { query: "transaction reference", topK: 10000 });
    assert.match(invalidTopK, /invalid|maximum|10/i);
    console.log("MCP invalid topK: PASS");
  } finally {
    serverProcess.kill();
  }
});

async function waitForHealth(): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("MCP server did not become healthy");
}

async function mcpRequest(method: string, params?: Record<string, unknown>): Promise<Record<string, any>> {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: `${method}-${Date.now()}`, method, ...(params ? { params } : {}) })
  });
  return parseMcpResponse(response);
}

async function callTool(name: string, arguments_: Record<string, unknown>): Promise<string> {
  const response = await mcpRequest("tools/call", { name, arguments: arguments_ });
  if (response.error) return JSON.stringify(response.error);
  const content = response.result?.content as Array<{ type: string; text?: string }>;
  return content?.map((item) => item.text ?? "").join("\n") ?? "";
}

async function parseMcpResponse(response: Response): Promise<Record<string, any>> {
  const body = await response.text();
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const data = body.split("\n").find((line) => line.startsWith("data: "));
    return data ? JSON.parse(data.slice(6)) : { error: { message: body } };
  }
  return JSON.parse(body);
}
