import type { AppConfig } from "../config.js";

export type GithubDocument = {
  path: string;
  filename: string;
  content: string;
  owner: string;
  repository: string;
  branch: string;
};

type GithubContentResponse = {
  type?: string;
  name?: string;
  path?: string;
  content?: string;
  encoding?: string;
};

export class GithubService {
  constructor(private readonly config: AppConfig) {}

  async getMarkdownFile(path: string): Promise<GithubDocument> {
    this.validateConfiguration();
    if (!path.toLowerCase().endsWith(".md")) throw new Error(`GitHub ingestion currently supports Markdown files only: ${path}`);

    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const url = `https://api.github.com/repos/${encodeURIComponent(this.config.githubOwner)}/${encodeURIComponent(this.config.githubRepo)}/contents/${encodedPath}?ref=${encodeURIComponent(this.config.githubBranch)}`;
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.config.githubToken}`,
          "X-GitHub-Api-Version": "2022-11-28"
        }
      });
    } catch (error) {
      throw new Error(`GitHub request failed: ${error instanceof Error ? error.message : "unknown error"}`);
    }

    if (response.status === 401 || response.status === 403) throw new Error(`GitHub authentication failed (${response.status})`);
    if (response.status === 404) throw new Error(`GitHub file not found: ${path} on branch ${this.config.githubBranch}`);
    if (!response.ok) throw new Error(`GitHub API error (${response.status}): ${await response.text()}`);

    const payload = await response.json() as GithubContentResponse;
    if (payload.type !== "file" || !payload.content || payload.encoding !== "base64") {
      throw new Error(`GitHub path is not a supported encoded file: ${path}`);
    }
    const content = Buffer.from(payload.content.replace(/\s/g, ""), "base64").toString("utf8");
    if (!content.trim()) throw new Error(`GitHub document is empty: ${path}`);

    return {
      path: payload.path ?? path,
      filename: payload.name ?? path.split("/").pop() ?? path,
      content,
      owner: this.config.githubOwner,
      repository: this.config.githubRepo,
      branch: this.config.githubBranch
    };
  }

  private validateConfiguration(): void {
    const missing = [
      ["GITHUB_TOKEN", this.config.githubToken],
      ["GITHUB_OWNER", this.config.githubOwner],
      ["GITHUB_REPO", this.config.githubRepo]
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length > 0) throw new Error(`Missing GitHub configuration: ${missing.join(", ")}`);
  }
}