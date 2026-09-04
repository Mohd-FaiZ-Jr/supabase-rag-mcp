import { loadConfig } from "../src/config.js";
import { GeminiEmbeddingService } from "../src/services/gemini.js";
import { SupabaseService } from "../src/services/supabase.js";

const config = loadConfig();
const embedding = await new GeminiEmbeddingService(config).embedQuery("How is a transfer reference generated?");
console.log(`Gemini embedding: ${embedding.length} dimensions`);
const supabase = new SupabaseService(config);
await supabase.checkConnection();
console.log("Supabase connectivity: ok");
const results = await supabase.searchDocuments(embedding, config.defaultTopK);
console.log(`Vector search: ${results.length} result(s)`);
for (const result of results) {
	console.log(JSON.stringify({ content: result.content, metadata: result.metadata, similarity: result.similarity }));
}
const expectedPath = process.env.EXPECTED_GITHUB_PATH?.trim();
if (expectedPath) {
	if (!results.some((result) => result.metadata.github_path === expectedPath)) {
		throw new Error(`Semantic retrieval verification failed: ${expectedPath} was not among the results`);
	}
	console.log(`Semantic retrieval verification: ${expectedPath} found`);
} else if (results.length === 0) {
	console.log("No documents found; no fabricated results returned. Set EXPECTED_GITHUB_PATH to verify a source document.");
}