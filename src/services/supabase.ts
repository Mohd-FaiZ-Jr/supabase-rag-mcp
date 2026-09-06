import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AppConfig } from "../config.js";
import type { ChunkMetadata, DocumentType } from "../ingestion/types.js";

export type SearchResult = {
  chunkId: string;
  documentId: string;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
};

export type DocumentRecord = {
  id: string;
  githubPath: string;
  contentHash: string;
};

export type DocumentChunkInsert = {
  document_id: string;
  chunk_index: number;
  content: string;
  metadata: ChunkMetadata;
  embedding: number[];
};

export type RequirementResult = {
  requirementId: string;
  documentType: DocumentType;
  source: string;
  sections: string[];
  chunks: Array<{ chunkId: string; content: string; metadata: ChunkMetadata }>;
};

export type UATObservationInsert = {
  observation_id: string;
  test_case_id?: string;
  module?: string;
  process_area?: string;
  process_code?: string;
  system?: string;
  transaction_id?: string;
  title?: string;
  expected_behavior: string;
  actual_behavior: string;
  evidence_references: string[];
  severity?: string;
  source_github_path: string;
  source_sheet: string;
  source_row: number;
  content_hash: string;
};

export type UATEvaluation = {
  rootCause?: string;
  resolutionDecision?: string;
  productLimitationFlag?: string;
  resolutionStatus?: string;
};

export class SupabaseService {
  private readonly client: SupabaseClient;

  constructor(private readonly config: AppConfig) {
    this.client = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
  }

  async searchDocuments(embedding: number[], matchCount: number, documentType?: DocumentType): Promise<SearchResult[]> {
    if (embedding.length !== this.config.embeddingDimension) {
      throw new Error(`Embedding dimension mismatch: expected ${this.config.embeddingDimension}, received ${embedding.length}`);
    }
    const rpcArgs = documentType
      ? { query_embedding: embedding, match_count: matchCount, document_type_filter: documentType }
      : { query_embedding: embedding, match_count: matchCount };
    const { data, error } = await this.client.rpc("search_documents", rpcArgs);
    if (error) throw new Error(`Supabase vector search failed: ${error.message}`);
    return (data ?? []).map((row: Record<string, unknown>) => ({
      chunkId: String(row.chunk_id),
      documentId: String(row.document_id),
      content: String(row.content),
      metadata: (row.metadata as Record<string, unknown>) ?? {},
      similarity: Number(row.similarity)
    }));
  }

  async getRequirement(requirementId: string): Promise<RequirementResult | null> {
    const { data, error } = await this.client.rpc("get_requirement_chunks", {
      requirement_id_filter: requirementId
    });
    if (error) throw new Error(`Supabase requirement lookup failed: ${error.message}`);
    if (!data || data.length === 0) return null;
    const chunks: RequirementResult["chunks"] = data.map((row: Record<string, unknown>) => ({
      chunkId: String(row.chunk_id),
      content: String(row.content),
      metadata: row.metadata as ChunkMetadata
    }));
    const first = chunks[0].metadata;
    return {
      requirementId,
      documentType: first.document_type,
      source: first.github_path,
      sections: [...new Set(chunks.map((chunk) => chunk.metadata.section))],
      chunks
    };
  }

  async checkConnection(): Promise<void> {
    const { error } = await this.client.from("documents").select("id", { head: true, count: "exact" });
    if (error) throw new Error(`Supabase connectivity check failed: ${error.message}`);
  }

  async getDocumentByPath(githubPath: string): Promise<DocumentRecord | null> {
    const { data, error } = await this.client
      .from("documents")
      .select("id, github_path, content_hash")
      .eq("github_path", githubPath)
      .maybeSingle();
    if (error) throw new Error(`Supabase document lookup failed: ${error.message}`);
    if (!data) return null;
    return { id: String(data.id), githubPath: String(data.github_path), contentHash: String(data.content_hash) };
  }

  async upsertDocument(record: {
    github_path: string;
    filename: string;
    document_type: string;
    version: string;
    content_hash: string;
  }): Promise<DocumentRecord> {
    const { data, error } = await this.client
      .from("documents")
      .upsert({ ...record, updated_at: new Date().toISOString() }, { onConflict: "github_path" })
      .select("id, github_path, content_hash")
      .single();
    if (error || !data) throw new Error(`Supabase document upsert failed: ${error?.message ?? "empty response"}`);
    return { id: String(data.id), githubPath: String(data.github_path), contentHash: String(data.content_hash) };
  }

  async deleteDocumentChunks(documentId: string): Promise<void> {
    const { error } = await this.client.from("document_chunks").delete().eq("document_id", documentId);
    if (error) throw new Error(`Supabase old chunk removal failed: ${error.message}`);
  }

  async insertDocumentChunks(chunks: DocumentChunkInsert[]): Promise<void> {
    if (chunks.length === 0) throw new Error("Cannot insert an empty chunk set");
    if (chunks.some((chunk) => chunk.embedding.length !== this.config.embeddingDimension)) {
      throw new Error(`Supabase chunk insertion rejected: every embedding must have ${this.config.embeddingDimension} dimensions`);
    }
    const { error } = await this.client.from("document_chunks").insert(chunks);
    if (error) throw new Error(`Supabase chunk insertion failed: ${error.message}`);
  }

  async verifyIndexedDocument(documentId: string, expectedChunkCount: number): Promise<void> {
    const { data, error } = await this.client
      .from("document_chunks")
      .select("id, embedding")
      .eq("document_id", documentId)
      .order("chunk_index", { ascending: true });
    if (error) throw new Error(`Supabase ingestion verification failed: ${error.message}`);
    if (!data || data.length !== expectedChunkCount || data.length === 0) {
      throw new Error(`Supabase ingestion verification failed: expected ${expectedChunkCount} chunks, found ${data?.length ?? 0}`);
    }
    for (const row of data) {
      const embedding = parseEmbedding(row.embedding);
      if (embedding.length !== this.config.embeddingDimension || embedding.some((value) => !Number.isFinite(value))) {
        throw new Error(`Supabase ingestion verification failed: chunk ${String(row.id)} does not contain a valid ${this.config.embeddingDimension}-dimensional embedding`);
      }
    }
  }

  async upsertUATObservation(record: UATObservationInsert): Promise<{ id: string; created: boolean; changed: boolean }> {
    const existing = await this.client
      .from("uat_observations")
      .select("id, content_hash")
      .eq("source_github_path", record.source_github_path)
      .eq("observation_id", record.observation_id)
      .maybeSingle();
    if (existing.error) throw new Error(`Supabase UAT observation lookup failed: ${existing.error.message}`);
    if (existing.data && String(existing.data.content_hash) === record.content_hash) {
      return { id: String(existing.data.id), created: false, changed: false };
    }
    const { data, error } = await this.client
      .from("uat_observations")
      .upsert({ ...record, updated_at: new Date().toISOString() }, { onConflict: "source_github_path,observation_id" })
      .select("id")
      .single();
    if (error || !data) throw new Error(`Supabase UAT observation upsert failed: ${error?.message ?? "empty response"}`);
    return { id: String(data.id), created: !existing.data, changed: true };
  }

  async upsertUATEvaluation(observationId: string, evaluation: UATEvaluation): Promise<void> {
    const { error } = await this.client.from("uat_observation_evaluations").upsert({
      observation_id: observationId,
      root_cause: evaluation.rootCause,
      resolution_decision: evaluation.resolutionDecision,
      product_limitation_flag: evaluation.productLimitationFlag,
      resolution_status: evaluation.resolutionStatus,
      updated_at: new Date().toISOString()
    }, { onConflict: "observation_id" });
    if (error) throw new Error(`Supabase UAT evaluation upsert failed: ${error.message}`);
  }
}

function parseEmbedding(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map(Number);
    } catch {
      return value.replace(/[\[\]]/g, "").split(",").filter(Boolean).map(Number);
    }
  }
  return [];
}