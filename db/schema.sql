-- 晨读 accounts + reader-data sync. Idempotent: safe to run more than once.
create table if not exists users (
  id            bigserial primary key,
  email         text not null unique,
  password_hash text not null,
  created_at    timestamptz not null default now()
);

create table if not exists sessions (
  token_hash text primary key,             -- sha256 of the cookie token; the token itself is never stored
  user_id    bigint not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists sessions_user_idx on sessions(user_id);
create index if not exists sessions_expires_idx on sessions(expires_at);

-- One row per reader localStorage key (chendu:notes:<date>, chendu:tr:<date>, chendu:recall:<date>).
create table if not exists reader_docs (
  user_id    bigint not null references users(id) on delete cascade,
  key        text not null check (key ~ '^chendu:(notes|tr|recall):[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  value      jsonb not null,
  rev        integer not null default 1,
  updated_at timestamptz not null default now(),
  primary key (user_id, key)
);

create table if not exists auth_attempts (
  id         bigserial primary key,
  bucket     text not null,                -- "<kind>:sha256(ip or email)"
  created_at timestamptz not null default now()
);
create index if not exists auth_attempts_bucket_idx on auth_attempts(bucket, created_at);
