import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const port = 3200;
const baseUrl = `http://127.0.0.1:${port}`;
const expectedTools = ["get_banking_requirement", "search_banking_knowledge", "search_previous_rca"];
let child: ChildProcess | undefined;
let output = "";

test("Phase 7 MCP integration readiness", async () => {
  const projectRoot = resolve(fileURLToPath(import.meta.url), "../..");
  const tsxEntry = resolve(projectRoot, "node_modules", "tsx", "dist", "cli.mjs");
  child = spawn(process.execPath, [tsxEntry, "src/start.ts"], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.on("data", (chunk) => { output += String(chunk); });
  child.stderr?.on("data", (chunk) => { output += String(chunk); });

  try {
    await waitForHealth();
    console.log("[PASS] health endpoint");

    const initialized = await request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "phase7-contract-client", version: "1.0.0" }
    });
    assert.equal(initialized.error, undefined);
    assert.equal(typeof initialized.result?.protocolVersion, "string");
    assert.equal(initialized.result?.serverInfo?.name, "banking-rag-mcp");
    assert.equal(initialized.result?.serverInfo?.version, "0.1.0");
    console.log(`[PASS] MCP initialize: protocol=${initialized.result.protocolVersion}, server=${initialized.result.serverInfo.name}@${initialized.result.serverInfo.version}`);
    console.log(`[PASS] MCP capabilities: ${JSON.stringify(initialized.result.capabilities)}`);

    const toolsResponse = await request("tools/list");
    assert.equal(toolsResponse.error, undefined);
    const tools = toolsResponse.result?.tools as Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
    assert.equal(tools.length, 3);
    assert.deepEqual(tools.map((tool) => tool.name).sort(), expectedTools);
    for (const tool of tools) {
      assert.ok(tool.description);
      assert.ok(tool.inputSchema);
    }
    console.log("[PASS] tools/list: exactly 3 business tools with descriptions and schemas");
    validateSchema(tools, "search_banking_knowledge", ["query"]);
    validateSchema(tools, "get_banking_requirement", ["requirementId"]);
    validateSchema(tools, "search_previous_rca", ["query"]);
    console.log("[PASS] tool input schemas");

    const general = await callTool("search_banking_knowledge", { query: "What should happen after a money transfer succeeds?" });
    assert.match(general, /TRX-REF-001|transaction-reference\.md/);
    console.log("[PASS] BRD grounding");
    const rca = await callTool("search_previous_rca", { query: "What caused the missing transaction reference issue?" });
    assert.match(rca, /RCA-001\.md/);
    assert.doesNotMatch(rca, /"documentType": "BRD"/);
    console.log("[PASS] RCA grounding");
    const brdFiltered = await callTool("search_banking_knowledge", { query: "transaction reference after successful transfer", documentType: "BRD" });
    assert.doesNotMatch(brdFiltered, /"documentType": "RCA"/);
    console.log("[PASS] BRD filtering");
    const rcaFiltered = await callTool("search_banking_knowledge", { query: "transaction reference issue", documentType: "RCA" });
    assert.doesNotMatch(rcaFiltered, /"documentType": "BRD"/);
    console.log("[PASS] RCA filtering");
    const requirement = await callTool("get_banking_requirement", { requirementId: "TRX-REF-001" });
    const requirementValue = JSON.parse(requirement) as { found: boolean; chunks: unknown[] };
    assert.equal(requirementValue.found, true);
    assert.equal(requirementValue.chunks.length, 5);
    console.log("[PASS] exact requirement: TRX-REF-001 returned 5 chunks");
    const missing = await callTool("get_banking_requirement", { requirementId: "NONEXISTENT-999" });
    assert.equal((JSON.parse(missing) as { found: boolean }).found, false);
    console.log("[PASS] missing requirement");

    const negativeRequests: Array<{ label: string; body: Record<string, unknown> }> = [
      { label: "unknown method", body: rpc("unknown/method") },
      { label: "unknown tool", body: rpc("tools/call", { name: "unknown_tool", arguments: {} }) },
      { label: "missing query", body: rpc("tools/call", { name: "search_banking_knowledge", arguments: {} }) },
      { label: "invalid arguments", body: rpc("tools/call", { name: "search_banking_knowledge", arguments: { query: "", topK: 10000 } }) }
    ];
    for (const negative of negativeRequests) {
      const response = await postRaw(negative.body);
      assert.ok(response.error || response.result?.isError === true || (response.status ?? 0) >= 400, `${negative.label} was accepted`);
      console.log(`[PASS] ${negative.label}`);
      await assertHealthy();
    }
    const malformed = await fetch(`${baseUrl}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{bad json" });
    assert.ok(malformed.status >= 400 && malformed.status < 500);
    assert.match(await malformed.text(), /Invalid JSON request|error/i);
    console.log("[PASS] malformed JSON");
    await assertHealthy();
    console.log("[PASS] health after negative requests");

    for (let index = 0; index < 10; index += 1) {
      const response = index % 3 === 0
        ? await callTool("search_banking_knowledge", { query: "successful money transfer", documentType: "BRD" })
        : index % 3 === 1
          ? await callTool("search_previous_rca", { query: "missing transaction reference" })
          : await callTool("get_banking_requirement", { requirementId: "TRX-REF-001" });
      assert.ok(response.length > 0);
    }
    console.log("[PASS] 10 consecutive MCP requests");

    const secrets = [process.env.GEMINI_API_KEY, process.env.SUPABASE_SERVICE_ROLE_KEY, process.env.GITHUB_TOKEN].filter(Boolean) as string[];
    for (const secret of secrets) assert.equal(output.includes(secret), false);
    for (const name of ["GEMINI_API_KEY", "SUPABASE_SERVICE_ROLE_KEY", "GITHUB_TOKEN"]) assert.equal(output.includes(name), false);
    console.log("[PASS] no credential leakage in server output");
  } finally {
    child.kill();
  }
});

function validateSchema(tools: Array<{ name: string; inputSchema?: Record<string, unknown> }>, name: string, required: string[]): void {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool?.inputSchema);
  const schemaRequired = tool.inputSchema.required as string[] | undefined;
  assert.deepEqual(schemaRequired, required);
}

function rpc(method: string, params?: Record<string, unknown>): Record<string, unknown> {
  return { jsonrpc: "2.0", id: `${method}-${Date.now()}-${Math.random()}`, method, ...(params ? { params } : {}) };
}

async function request(method: string, params?: Record<string, unknown>): Promise<Record<string, any>> {
  return postRaw(rpc(method, params));
}

async function postRaw(body: Record<string, unknown>): Promise<Record<string, any> & { status?: number }> {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  const parsed = parseResponse(response, text);
  return { ...parsed, status: response.status };
}

async function callTool(name: string, arguments_: Record<string, unknown>): Promise<string> {
  const response = await request("tools/call", { name, arguments: arguments_ });
  if (response.error) return JSON.stringify(response.error);
  return (response.result?.content as Array<{ text?: string }>).map((item) => item.text ?? "").join("\n");
}

function parseResponse(response: Response, text: string): Record<string, any> {
  if (response.headers.get("content-type")?.includes("text/event-stream")) {
    const line = text.split("\n").find((candidate) => candidate.startsWith("data: "));
    return line ? JSON.parse(line.slice(6)) : { error: { message: text } };
  }
  return JSON.parse(text);
}

async function waitForHealth(): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("MCP server did not become healthy");
}

async function assertHealthy(): Promise<void> {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { status: string }).status, "ok");
}
