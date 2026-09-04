import { loadConfig } from "./config.js";
import { indexDocument } from "./ingestion/index-document.js";
import { GeminiEmbeddingService } from "./services/gemini.js";
import { GithubService } from "./services/github.js";
import { SupabaseService } from "./services/supabase.js";

const path = process.argv[2];
if (!path || process.argv.length > 3) {
  console.error("Usage: npm run ingest -- documents/BRD/example.md");
  process.exitCode = 1;
} else {
  try {
    const config = loadConfig();
    console.log(`Fetching: ${path}`);
    const document = await new GithubService(config).getMarkdownFile(path);
    await indexDocument(document, new GeminiEmbeddingService(config), new SupabaseService(config));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Ingestion failed: unknown error");
    process.exitCode = 1;
  }
}