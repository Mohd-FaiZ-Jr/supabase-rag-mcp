import { z } from "zod";
import { GeminiEmbeddingService } from "../services/gemini.js";
import { SupabaseService } from "../services/supabase.js";

export const searchInputSchema = {
  query: z.string().trim().min(1).max(2000),
  topK: z.number().int().min(1).max(10).optional(),
  documentType: z.enum(["BRD", "RCA", "UAT", "TEST_CASE", "OPEN_QUESTION"]).optional()
};

export function createSearchHandler(gemini: GeminiEmbeddingService, supabase: SupabaseService, defaultTopK: number) {
  return async ({ query, topK, documentType }: { query: string; topK?: number; documentType?: "BRD" | "RCA" | "UAT" | "TEST_CASE" | "OPEN_QUESTION" }) => {
    const embedding = await gemini.embedQuery(query);
    const results = await supabase.searchDocuments(embedding, topK ?? defaultTopK, documentType);
    const evidence = results.map((result) => toEvidence(result));
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ query, count: evidence.length, results: evidence }, null, 2)
      }]
    };
  };
}

export const previousRcaInputSchema = {
  query: z.string().trim().min(1).max(2000),
  topK: z.number().int().min(1).max(10).optional()
};

export function createPreviousRcaHandler(gemini: GeminiEmbeddingService, supabase: SupabaseService, defaultTopK: number) {
  return async ({ query, topK }: { query: string; topK?: number }) => {
    const embedding = await gemini.embedQuery(query);
    const results = await supabase.searchDocuments(embedding, topK ?? defaultTopK, "RCA");
    const evidence = results.map((result) => toEvidence(result));
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ query, count: evidence.length, results: evidence }, null, 2)
      }]
    };
  };
}

export const requirementInputSchema = {
  requirementId: z.string().trim().min(1).max(100)
};

export function createRequirementHandler(supabase: SupabaseService) {
  return async ({ requirementId }: { requirementId: string }) => {
    const result = await supabase.getRequirement(requirementId);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(result ? { ...result, found: true } : { found: false, requirementId, chunks: [] }, null, 2)
      }]
    };
  };
}

function toEvidence(result: { chunkId: string; documentId: string; content: string; metadata: Record<string, unknown>; similarity: number }) {
  return {
    chunkId: result.chunkId,
    documentId: result.documentId,
    ...(typeof result.metadata.requirement_id === "string" ? { requirementId: result.metadata.requirement_id } : {}),
    ...(typeof result.metadata.document_type === "string" ? { documentType: result.metadata.document_type } : {}),
    ...(typeof result.metadata.section === "string" ? { section: result.metadata.section } : {}),
    ...(typeof result.metadata.github_path === "string" ? { source: result.metadata.github_path } : {}),
    content: result.content,
    similarity: result.similarity,
    metadata: result.metadata
  };
}