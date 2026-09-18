-- ============================================================================
-- Central Vault – Supabase-Schema
-- Einspielen: Supabase Dashboard → SQL Editor → komplett einfügen → Run
-- Das Skript ist idempotent und kann gefahrlos mehrfach ausgeführt werden.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Tabelle
--    Eine Zeile pro Benutzer. Der Server sieht ausschließlich Chiffrat,
--    Nonce, Salt und die öffentlichen KDF-Parameter.
-- ---------------------------------------------------------------------------
create table if not exists public.vaults (
  user_id           uuid        primary key references auth.users (id) on delete cascade,
  salt              text        not null,
  kdf               jsonb       not null,
  iv                text        not null,
  ciphertext        text        not null,
  version           integer     not null default 1,
  client_updated_at timestamptz not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  constraint vaults_salt_format
    check (salt ~ '^[A-Za-z0-9+/]{16,120}={0,2}$'),
  constraint vaults_iv_format
    check (iv ~ '^[A-Za-z0-9+/]{12,80}={0,2}$'),
  constraint vaults_ciphertext_format
    check (ciphertext ~ '^[A-Za-z0-9+/]+={0,2}$'),
  constraint vaults_ciphertext_size
    check (length(ciphertext) between 17 and 2000000),
  constraint vaults_version_positive
    check (version > 0),
  constraint vaults_kdf_shape
    check (
      kdf->>'algorithm' = 'argon2id'
      and (kdf->>'memorySize')::int  between 16384 and 262144
      and (kdf->>'iterations')::int  between 2 and 10
      and (kdf->>'parallelism')::int between 1 and 4
      and (kdf->>'hashLength')::int  = 64
    )
);

comment on table  public.vaults is 'Ende-zu-Ende-verschlüsselter Tresor, eine Zeile pro Benutzer.';
comment on column public.vaults.version is 'Optimistic Locking. Wird ausschließlich um 1 erhöht (Trigger).';

-- ---------------------------------------------------------------------------
-- 2. Row Level Security
--    Kein Zugriff ohne gültiges JWT, und nur auf die eigene Zeile.
--    Bewusst KEINE delete-Policy: der Tresor lässt sich nicht per API löschen.
-- ---------------------------------------------------------------------------
alter table public.vaults enable row level security;

drop policy if exists vault_select_own on public.vaults;
create policy vault_select_own on public.vaults
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists vault_insert_own on public.vaults;
create policy vault_insert_own on public.vaults
  for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists vault_update_own on public.vaults;
create policy vault_update_own on public.vaults
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke delete on public.vaults from anon, authenticated;
revoke all    on public.vaults from anon;

-- ---------------------------------------------------------------------------
-- 3. Schutz-Trigger
--    version steigt streng um 1, Salt/KDF/Anlagezeit sind unveränderlich,
--    updated_at kommt vom Server. Zweite Verteidigungslinie hinter dem
--    optimistischen .eq('version', …) des Clients.
-- ---------------------------------------------------------------------------
create or replace function public.vaults_before_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.version    := 1;
  new.created_at := now();
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.vaults_before_update()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.version <> old.version + 1 then
    raise exception 'VERSION_CONFLICT: erwartet %, erhalten %', old.version + 1, new.version
      using errcode = '23514';
  end if;
  new.user_id    := old.user_id;
  new.salt       := old.salt;
  new.kdf        := old.kdf;
  new.created_at := old.created_at;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists vaults_before_insert on public.vaults;
create trigger vaults_before_insert
  before insert on public.vaults
  for each row execute function public.vaults_before_insert();

drop trigger if exists vaults_before_update on public.vaults;
create trigger vaults_before_update
  before update on public.vaults
  for each row execute function public.vaults_before_update();

-- ---------------------------------------------------------------------------
-- 4. Realtime
--    Dient nur als Signal "auf einem anderen Gerät hat sich etwas geändert".
--    Der Client lädt danach immer per select nach – postgres_changes bricht
--    bei Nutzlasten über ~1 MB ab, das Chiffrat darf also nie der Transportweg
--    sein.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'vaults'
  ) then
    execute 'alter publication supabase_realtime add table public.vaults';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Kontrolle
-- ---------------------------------------------------------------------------
-- select relrowsecurity from pg_class where oid = 'public.vaults'::regclass;  -- muss true sein
-- select policyname, cmd from pg_policies where tablename = 'vaults';         -- muss 3 Zeilen liefern
