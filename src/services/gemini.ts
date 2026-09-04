import { GoogleGenAI } from "@google/genai";
import type { AppConfig } from "../config.js";

export const GEMINI_EMBEDDING_DIMENSION = 1536;

export class GeminiEmbeddingService {
  private readonly client: GoogleGenAI;

  constructor(private readonly config: AppConfig) {
    this.client = new GoogleGenAI({ apiKey: config.geminiApiKey });
  }

  async embedQuery(query: string): Promise<number[]> {
    return this.embedText(`task: search result | query: ${query}`);
  }

  async embedDocument(content: string, title: string): Promise<number[]> {
    return this.embedText(`title: ${title} | text: ${content}`);
  }

  private async embedText(contents: string): Promise<number[]> {
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
      if (error instanceof Error && error.message.startsWith("Gemini returned")) throw error;
      throw new Error(`Gemini embedding request failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }
}