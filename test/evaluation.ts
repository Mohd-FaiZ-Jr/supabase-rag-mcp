import { loadConfig } from "../src/config.js";
import { GeminiEmbeddingService } from "../src/services/gemini.js";
import { SupabaseService } from "../src/services/supabase.js";

type EvaluationCase = {
  name: string;
  query: string;
  documentType: "BRD" | "RCA";
  expectedSource: string;
  expectedRequirementId?: string;
};

const cases: EvaluationCase[] = [
  { name: "Successful transfer requirement", query: "What should happen after a successful money transfer?", documentType: "BRD", expectedSource: "documents/BRD/transaction-reference.md", expectedRequirementId: "TRX-REF-001" },
  { name: "Transaction reference generation", query: "How is a transaction reference generated?", documentType: "BRD", expectedSource: "documents/BRD/transaction-reference.md", expectedRequirementId: "TRX-REF-001" },
  { name: "Payment success transition", query: "When should a transaction become SUCCESS?", documentType: "BRD", expectedSource: "documents/BRD/payment-status.md", expectedRequirementId: "PAY-STATUS-001" },
  { name: "Missing reference RCA", query: "What happens if the transaction reference is missing?", documentType: "RCA", expectedSource: "documents/RCA/RCA-001.md" },
  { name: "Previous missing reference issue", query: "Have we seen an issue involving missing transaction references?", documentType: "RCA", expectedSource: "documents/RCA/RCA-001.md" },
  { name: "Reference failure cause", query: "Why might a transaction reference be missing after a successful transfer?", documentType: "RCA", expectedSource: "documents/RCA/RCA-001.md" },
  { name: "Transfer processing requirement", query: "What validates and submits a money transfer?", documentType: "BRD", expectedSource: "documents/BRD/money-transfer.md", expectedRequirementId: "TRX-TRANSFER-001" },
  { name: "Payment status RCA", query: "Find the RCA related to an incorrect successful payment status.", documentType: "RCA", expectedSource: "documents/RCA/RCA-002.md" }
];

const config = loadConfig();
const gemini = new GeminiEmbeddingService(config);
const supabase = new SupabaseService(config);
let passed = 0;

console.log("=== Banking RAG Retrieval Evaluation ===");
for (const evaluationCase of cases) {
  const embedding = await gemini.embedQuery(evaluationCase.query);
  const results = await supabase.searchDocuments(embedding, config.defaultTopK, evaluationCase.documentType);
  const match = results.find((result) => result.metadata.github_path === evaluationCase.expectedSource && (!evaluationCase.expectedRequirementId || result.metadata.requirement_id === evaluationCase.expectedRequirementId));
  if (match) {
    passed += 1;
    console.log(`[PASS] ${evaluationCase.name}`);
    console.log(`Expected: ${evaluationCase.expectedRequirementId ?? evaluationCase.expectedSource}`);
    console.log(`Found: ${String(match.metadata.requirement_id ?? match.metadata.github_path)}`);
    console.log(`Similarity: ${match.similarity}`);
  } else {
    console.log(`[FAIL] ${evaluationCase.name}`);
    console.log(`Expected: ${evaluationCase.expectedRequirementId ?? evaluationCase.expectedSource}`);
    console.log(`Found: ${results.map((result) => `${String(result.metadata.requirement_id ?? result.metadata.github_path)} (${result.similarity})`).join(", ") || "none"}`);
  }
}

const exact = await supabase.getRequirement("TRX-REF-001");
if (!exact || exact.source !== "documents/BRD/transaction-reference.md") throw new Error("Exact requirement lookup failed for TRX-REF-001");
console.log(`[PASS] Exact requirement lookup: ${exact.requirementId} (${exact.chunks.length} chunks)`);
const missing = await supabase.getRequirement("NONEXISTENT-999");
if (missing !== null) throw new Error("Missing requirement lookup should return not found");
console.log("[PASS] Missing requirement lookup: NONEXISTENT-999 not found");

const passRate = (passed / cases.length) * 100;
console.log("------------------------------------------");
console.log(`Passed: ${passed}`);
console.log(`Failed: ${cases.length - passed}`);
console.log(`Pass rate: ${passRate}%`);
console.log("------------------------------------------");
if (passed !== cases.length) process.exitCode = 1;