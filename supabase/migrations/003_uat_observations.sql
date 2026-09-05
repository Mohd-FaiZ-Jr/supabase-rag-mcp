create table if not exists public.uat_observations (
  id uuid primary key default gen_random_uuid(),
  observation_id text not null,
  test_case_id text,
  module text,
  process_area text,
  process_code text,
  system text,
  transaction_id text,
  title text,
  expected_behavior text not null,
  actual_behavior text not null,
  evidence_references jsonb not null default '[]'::jsonb,
  severity text,
  source_github_path text not null,
  source_sheet text not null,
  source_row integer not null check (source_row > 0),
  content_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_github_path, observation_id)
);

create table if not exists public.uat_observation_evaluations (
  observation_id uuid primary key references public.uat_observations(id) on delete cascade,
  root_cause text,
  resolution_decision text,
  product_limitation_flag text,
  resolution_status text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists uat_observations_test_case_id_idx on public.uat_observations(test_case_id);