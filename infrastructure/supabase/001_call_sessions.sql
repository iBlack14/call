create table if not exists public.call_sessions (
  code text primary key,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint call_sessions_code_length check (char_length(code) between 4 and 50)
);

create index if not exists call_sessions_updated_at_idx
  on public.call_sessions (updated_at desc);

alter table public.call_sessions enable row level security;

revoke all on table public.call_sessions from anon, authenticated;
grant select, insert, update, delete on table public.call_sessions to service_role;
