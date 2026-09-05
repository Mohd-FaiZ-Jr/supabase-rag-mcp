import type { GithubDocument } from "../services/github.js";
import { z } from "zod";

export type IngestionDocument = GithubDocument;

export const chunkMetadataSchema = z.object({
  document_type: z.enum(["BRD", "RCA", "UAT"]),
  requirement_id: z.string().min(1).optional(),
  section: z.string().min(1),
  github_path: z.string().min(1)
}).strict();

export type ChunkMetadata = z.infer<typeof chunkMetadataSchema>;

export type SemanticChunk = {
  chunkIndex: number;
  content: string;
  metadata: ChunkMetadata;
};