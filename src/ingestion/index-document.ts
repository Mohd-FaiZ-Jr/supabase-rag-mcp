import { createHash } from "node:crypto";
import { chunkMarkdown } from "./chunker.js";
import type { DocumentType, IngestionDocument, SemanticChunk } from "./types.js";
import { GEMINI_EMBEDDING_DIMENSION, GeminiEmbeddingService } from "../services/gemini.js";
import { SupabaseService } from "../services/supabase.js";

type IngestionLogger = Pick<Console, "log">;
type IndexDocumentOptions = { documentType?: DocumentType; contentHash?: string; chunkMetadata?: Array<Record<string, unknown>> };

export async function indexDocument(
  document: IngestionDocument,
  gemini: GeminiEmbeddingService,
  supabase: SupabaseService,
  logger: IngestionLogger = console,
  options: IndexDocumentOptions = {}
): Promise<{ status: "indexed" | "skipped"; chunkCount: number; contentHash: string }> {
  const documentType = options.documentType ?? detectDocumentType(document.path);
  const contentHash = options.contentHash ?? createHash("sha256").update(document.content, "utf8").digest("hex");
  const chunks = chunkMarkdown({ path: document.path, content: document.content, documentType }).map((chunk, index) => applyChunkMetadata(chunk, options.chunkMetadata?.[index]));
  if (chunks.length === 0) throw new Error(`No semantic chunks were produced for ${document.path}`);

  logger.log(`Document: ${document.filename}`);
  logger.log(`Document type: ${documentType}`);
  logger.log(`Content length: ${document.content.length}`);
  logger.log(`Chunks: ${chunks.length}`);

  const existing = await supabase.getDocumentByPath(document.path);
  if (existing?.contentHash === contentHash) {
    try {
      await supabase.verifyIndexedDocument(existing.id, chunks.length);
      logger.log("Supabase: document unchanged; existing chunks verified");
      return { status: "skipped", chunkCount: chunks.length, contentHash };
    } catch {
      logger.log("Supabase: existing document is incomplete; rebuilding chunks");
    }
  }

  const storedDocument = await supabase.upsertDocument({
    github_path: document.path,
    filename: document.filename,
    document_type: documentType,
    version: document.branch,
    content_hash: contentHash
  });
  logger.log("Supabase: document upserted");
  await supabase.deleteDocumentChunks(storedDocument.id);

  const chunkRecords = [];
  logger.log(`Generating embeddings: 0/${chunks.length}`);
  for (const chunk of chunks) {
    const embedding = await gemini.embedDocument(chunk.content, `${document.filename} - ${String(chunk.metadata.section)}`);
    if (embedding.length !== GEMINI_EMBEDDING_DIMENSION) {
      throw new Error(`Embedding dimension mismatch for chunk ${chunk.chunkIndex}: expected ${GEMINI_EMBEDDING_DIMENSION}, received ${embedding.length}`);
    }
    chunkRecords.push({
      document_id: storedDocument.id,
      chunk_index: chunk.chunkIndex,
      content: chunk.content,
      metadata: chunk.metadata,
      embedding
    });
    logger.log(`Generating embeddings: ${chunk.chunkIndex + 1}/${chunks.length}`);
  }

  await supabase.insertDocumentChunks(chunkRecords);
  logger.log("Supabase: chunks inserted");
  await supabase.verifyIndexedDocument(storedDocument.id, chunks.length);
  logger.log("Ingestion complete.");
  return { status: "indexed", chunkCount: chunks.length, contentHash };
}

function applyChunkMetadata(chunk: SemanticChunk, metadata?: Record<string, unknown>): SemanticChunk {
  if (!metadata) return chunk;
  return { ...chunk, metadata: { ...chunk.metadata, ...metadata } };
}

export function detectDocumentType(path: string): DocumentType {
  if (/(?:^|\/)documents\/UAT(?:\/|$)/i.test(path)) return "UAT";
  const match = /(?:^|\/)documents\/(BRD|RCA)(?:\/|$)/i.exec(path);
  if (!match) throw new Error(`Unsupported document path: ${path}. Expected documents/BRD/... or documents/RCA/...`);
  return match[1].toUpperCase() as "BRD" | "RCA";
}