# Banking RAG MCP Server

Cloud-ready MCP server for retrieving banking document evidence from Supabase pgvector. It uses Gemini embeddings and does not generate RCA conclusions. It also supports explicit single-file ingestion from GitHub.

## Verified embedding contract

The official Gemini embeddings documentation lists `gemini-embedding-2` as stable. It supports configurable 768, 1536, or 3072 dimensions. This project explicitly uses 1536 dimensions for both query and document embeddings. `EMBEDDING_DIMENSION` is validated accordingly, and the SQL migration uses `vector(1536)`. Existing vectors must be re-embedded when changing models because embedding spaces are incompatible.

## Setup

```sh
npm install
copy .env.example .env
npm run build
npm test
```

Fill `.env` with real credentials, apply `supabase/migrations/001_banking_rag.sql`, then run:

```sh
npm start
curl http://localhost:3000/health
npm run test:integration
```

`test:integration` generates a real Gemini embedding, checks Supabase connectivity, and performs a real vector search. With an empty database it reports zero results and never fabricates evidence.

## Deployment

Configure these environment variables in the deployment platform's service settings before using `/mcp`:

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
GEMINI_API_KEY=your-gemini-api-key
```

The server binds to `0.0.0.0` and uses the platform-provided `PORT` value. It can start without secrets so platform health checks succeed; `/mcp` returns `503` and identifies the missing variables until the service is configured.

Apply `supabase/migrations/002_retrieval_filters.sql` after the original migration before using document-type filters or exact requirement lookup. It preserves the 0.70 similarity threshold and cosine/HNSW retrieval, adds server-side `BRD`/`RCA` filtering, and adds the exact `get_requirement_chunks` RPC.

## GitHub ingestion

Add these variables to `.env`:

```env
GITHUB_TOKEN=your-github-token
GITHUB_OWNER=your-github-owner
GITHUB_REPO=your-github-repository
GITHUB_BRANCH=main
EXPECTED_GITHUB_PATH=documents/BRD/transaction-reference.md
```

Index one Markdown file:

```sh
npm run ingest -- documents/BRD/transaction-reference.md
```

The command fetches the file through GitHub's Contents API, detects `BRD` or `RCA`, computes a SHA-256 content hash, creates Markdown-aware chunks, generates one 1536-dimensional Gemini embedding per chunk, upserts the document, replaces old chunks when content changes, and verifies the stored chunk count and vector dimensions. Running it again with unchanged content skips duplicate insertion.

To verify semantic retrieval against the indexed source, set `EXPECTED_GITHUB_PATH` and run:

```sh
npm run test:integration
```

## MCP

The Streamable HTTP endpoint is `POST /mcp`. It exposes exactly three business-facing tools:

- `search_banking_knowledge`: semantic evidence search with `query`, optional `topK` (1-10), and optional `documentType` (`BRD` or `RCA`).
- `get_banking_requirement`: exact lookup by `requirementId`, using the Supabase requirement RPC.
- `search_previous_rca`: semantic RCA-only search with `query` and optional `topK` (1-10).

Responses contain grounded evidence only. API keys, the service-role key, and the GitHub token are never included in MCP responses or ingestion logs. `test:mcp` independently starts the server and verifies health, tool discovery, all three tools, filtering, missing requirements, and invalid inputs over Streamable HTTP.

## MCP Integration

Endpoint: `POST /mcp`

Health: `GET /health`

The server binds to `0.0.0.0` with the configurable `PORT` value and can be consumed by an external MCP client using Streamable HTTP. Clients should send an MCP `initialize` request, call `tools/list`, then invoke only the three business tools above. The MCP layer returns grounded retrieval evidence and does not generate RCA conclusions.

## Retrieval evaluation

After indexing the test BRD/RCA documents and applying migration 002, run:

```sh
npm run test:evaluation
```

The suite runs eight realistic queries, applies document-type filters, reports actual Supabase similarity scores, and verifies `TRX-REF-001` plus a clean not-found result for `NONEXISTENT-999`.

## Next steps

Automatic webhooks, scheduled synchronization, bulk repository indexing, Multica Cloud integration, remote MCP authentication, cloud deployment, and final RCA generation remain out of scope. The current ingestion command intentionally indexes one explicit Markdown path at a time.