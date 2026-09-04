import "dotenv/config";

export type AppConfig = {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  geminiApiKey: string;
  geminiEmbeddingModel: string;
  embeddingDimension: number;
  defaultTopK: number;
  port: number;
  githubToken: string;
  githubOwner: string;
  githubRepo: string;
  githubBranch: string;
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const REQUIRED_SECRET_NAMES = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "GEMINI_API_KEY"] as const;

export function missingRequiredSecrets(config: Pick<AppConfig, "supabaseUrl" | "supabaseServiceRoleKey" | "geminiApiKey">): string[] {
  const values = {
    SUPABASE_URL: config.supabaseUrl,
    SUPABASE_SERVICE_ROLE_KEY: config.supabaseServiceRoleKey,
    GEMINI_API_KEY: config.geminiApiKey
  };
  return REQUIRED_SECRET_NAMES.filter((name) => !values[name]?.trim());
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function embeddingDimension(): number {
  const value = positiveInteger("EMBEDDING_DIMENSION", 1536);
  if (value !== 1536) throw new Error("EMBEDDING_DIMENSION must be 1536 for the current Gemini and Supabase schema");
  return value;
}

export function loadConfig(requireSecrets = true): AppConfig {
  return {
    supabaseUrl: requireSecrets ? required("SUPABASE_URL") : process.env.SUPABASE_URL ?? "",
    supabaseServiceRoleKey: requireSecrets ? required("SUPABASE_SERVICE_ROLE_KEY") : process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    geminiApiKey: requireSecrets ? required("GEMINI_API_KEY") : process.env.GEMINI_API_KEY ?? "",
    geminiEmbeddingModel: process.env.GEMINI_EMBEDDING_MODEL?.trim() || "gemini-embedding-2",
    embeddingDimension: embeddingDimension(),
    defaultTopK: positiveInteger("DEFAULT_TOP_K", 5),
    port: positiveInteger("PORT", 3000),
    githubToken: process.env.GITHUB_TOKEN?.trim() ?? "",
    githubOwner: process.env.GITHUB_OWNER?.trim() ?? "",
    githubRepo: process.env.GITHUB_REPO?.trim() ?? "",
    githubBranch: process.env.GITHUB_BRANCH?.trim() || "main"
  };
}