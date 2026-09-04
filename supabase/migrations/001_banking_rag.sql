create extension if not exists vector;

create table if not exists public.documents (
  id uuid primary key default gen_random_uuid(),
  github_path text not null unique,
  filename text not null,
  document_type text not null,
  version text,
  content_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.document_chunks (
  id uuid primary key default gen_random_uuid(),

  document_id uuid not null
    references public.documents(id)
    on delete cascade,

  chunk_index integer not null
    check (chunk_index >= 0),

  content text not null,

  metadata jsonb not null
    default '{}'::jsonb,

  embedding vector(1536) not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (document_id, chunk_index)
);

create index if not exists document_chunks_document_id_idx
  on public.document_chunks(document_id);

create index if not exists document_chunks_embedding_hnsw_idx
  on public.document_chunks
  using hnsw (embedding vector_cosine_ops);

create or replace function public.search_documents(
  query_embedding vector(1536),
  match_count integer default 5,
  match_threshold real default 0.70
)
returns table (
  chunk_id uuid,
  document_id uuid,
  content text,
  metadata jsonb,
  similarity real
)
language sql
stable
as $$
  select
    dc.id,
    dc.document_id,
    dc.content,
    dc.metadata,
    (1 - (dc.embedding <=> query_embedding))::real as similarity
  from public.document_chunks dc
  where (1 - (dc.embedding <=> query_embedding)) >= match_threshold
  order by dc.embedding <=> query_embedding
  limit greatest(match_count, 0);
$$;