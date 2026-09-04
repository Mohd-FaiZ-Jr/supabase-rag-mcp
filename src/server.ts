import express, { type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig, type AppConfig } from "./config.js";
import { GeminiEmbeddingService } from "./services/gemini.js";
import { SupabaseService } from "./services/supabase.js";
import { createPreviousRcaHandler, createRequirementHandler, createSearchHandler, previousRcaInputSchema, requirementInputSchema, searchInputSchema } from "./tools/search.js";

export function createMcpServer(config: AppConfig): McpServer {
  const gemini = new GeminiEmbeddingService(config);
  const supabase = new SupabaseService(config);
  const server = new McpServer({ name: "banking-rag-mcp", version: "0.1.0" });
  server.registerTool("search_banking_knowledge", {
    description: "Retrieve relevant banking document chunks as evidence for downstream reasoning.",
    inputSchema: searchInputSchema
  }, createSearchHandler(gemini, supabase, config.defaultTopK));
  server.registerTool("get_banking_requirement", {
    description: "Retrieve all indexed evidence chunks for an exact requirement ID.",
    inputSchema: requirementInputSchema
  }, createRequirementHandler(supabase));
  server.registerTool("search_previous_rca", {
    description: "Search previous Root Cause Analysis documents for similar historical banking issues.",
    inputSchema: previousRcaInputSchema
  }, createPreviousRcaHandler(gemini, supabase, config.defaultTopK));
  return server;
}

export function createApp(config: AppConfig) {
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.get("/health", (_request, response) => response.json({ status: "ok", service: "banking-rag-mcp" }));

  app.post("/mcp", async (request: Request, response: Response) => {
    const server = createMcpServer(config);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    response.on("close", () => void transport.close());
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      if (!response.headersSent) response.status(500).json({ error: "MCP request failed" });
      console.error(error instanceof Error ? error.message : "Unknown MCP error");
    }
  });
  app.use((error: unknown, _request: Request, response: Response, _next: (error?: unknown) => void) => {
    const status = typeof error === "object" && error !== null && "status" in error && typeof error.status === "number" ? error.status : 400;
    response.status(status).json({ error: "Invalid JSON request" });
  });
  return app;
}

