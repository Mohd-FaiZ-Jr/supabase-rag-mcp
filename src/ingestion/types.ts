import type { GithubDocument } from "../services/github.js";
import { z } from "zod";

export type IngestionDocument = GithubDocument;
export type DocumentType = "BRD" | "RCA" | "UAT" | "TEST_CASE" | "OPEN_QUESTION";

export const chunkMetadataSchema = z.object({
  document_type: z.enum(["BRD", "RCA", "UAT", "TEST_CASE", "OPEN_QUESTION"]),
  requirement_id: z.string().min(1).optional(),
  rule_status: z.string().min(1).optional(),
  section: z.string().min(1),
  github_path: z.string().min(1)
}).strict();

export type ChunkMetadata = z.infer<typeof chunkMetadataSchema>;

export type SemanticChunk = {
  chunkIndex: number;
  content: string;
  metadata: ChunkMetadata;
};