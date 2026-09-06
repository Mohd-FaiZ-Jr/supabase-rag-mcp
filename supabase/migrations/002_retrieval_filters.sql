drop function if exists public.search_documents(vector(1536), integer, real);

create or replace function public.search_documents(
  query_embedding vector(1536),
  match_count integer default 5,
  match_threshold real default 0.70,
  document_type_filter text default null
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
    and (document_type_filter is null or document_type_filter in ('BRD', 'RCA', 'UAT', 'TEST_CASE', 'OPEN_QUESTION'))
    and (document_type_filter is null or dc.metadata ->> 'document_type' = document_type_filter)
  order by dc.embedding <=> query_embedding
  limit greatest(match_count, 0);
$$;

create or replace function public.get_requirement_chunks(requirement_id_filter text)
returns table (
  chunk_id uuid,
  content text,
  metadata jsonb
)
language sql
stable
as $$
  select dc.id, dc.content, dc.metadata
  from public.document_chunks dc
  where dc.metadata ->> 'requirement_id' = requirement_id_filter
  order by dc.chunk_index;
$$;