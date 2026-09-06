import { GoogleGenAI } from "@google/genai";
import type { AppConfig } from "../config.js";

export const GEMINI_EMBEDDING_DIMENSION = 1536;
const DEFAULT_MIN_DELAY_MS = 675;
const MAX_ATTEMPTS = 3;

type EmbeddingClient = Pick<GoogleGenAI["models"], "embedContent">;

export class GeminiEmbeddingService {
  private readonly client: GoogleGenAI;
  private readonly minDelayMs: number;
  private nextRequestAt = 0;
  private rateLimitQueue: Promise<void> = Promise.resolve();

  constructor(private readonly config: AppConfig, client?: EmbeddingClient) {
    this.client = client ? { models: client } as GoogleGenAI : new GoogleGenAI({ apiKey: config.geminiApiKey });
    this.minDelayMs = config.geminiEmbeddingMinDelayMs ?? DEFAULT_MIN_DELAY_MS;
  }

  async embedQuery(query: string): Promise<number[]> {
    return this.embedText(`task: search result | query: ${query}`);
  }

  async embedDocument(content: string, title: string): Promise<number[]> {
    return this.embedText(`title: ${title} | text: ${content}`);
  }

  private async embedText(contents: string): Promise<number[]> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      await this.waitForRateLimit();
      try {
        const response = await this.client.models.embedContent({
          model: this.config.geminiEmbeddingModel,
          contents,
          config: { outputDimensionality: GEMINI_EMBEDDING_DIMENSION }
        });
        const values = response.embeddings?.[0]?.values;
        if (!values || values.length !== GEMINI_EMBEDDING_DIMENSION || values.some((value) => !Number.isFinite(value))) {
          throw new Error(`Gemini returned a malformed embedding; expected ${GEMINI_EMBEDDING_DIMENSION} finite values`);
        }
        return values;
      } catch (error) {
        const retryDelayMs = getRetryDelayMs(error);
        if (retryDelayMs === undefined || attempt === MAX_ATTEMPTS) {
          if (error instanceof Error && error.message.startsWith("Gemini returned")) throw error;
          throw new Error(`Gemini embedding request failed: ${error instanceof Error ? error.message : "unknown error"}`);
        }
        await delay(retryDelayMs);
      }
    }
    throw new Error("Gemini embedding request failed: retry limit exceeded");
  }

  private async waitForRateLimit(): Promise<void> {
    let release!: () => void;
    const previous = this.rateLimitQueue;
    this.rateLimitQueue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const waitMs = Math.max(0, this.nextRequestAt - Date.now());
      if (waitMs > 0) await delay(waitMs);
      this.nextRequestAt = Date.now() + this.minDelayMs;
    } finally {
      release();
    }
  }
}

function getRetryDelayMs(error: unknown): number | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (!/429|RESOURCE_EXHAUSTED/i.test(message)) return undefined;
  const retryDelay = /["']retryDelay["']\s*:\s*["']([0-9]+(?:\.[0-9]+)?)(ms|s)["']/i.exec(message);
  if (!retryDelay) return 0;
  const value = Number(retryDelay[1]);
  return retryDelay[2].toLowerCase() === "s" ? value * 1000 : value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}