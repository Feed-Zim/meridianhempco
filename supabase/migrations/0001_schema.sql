-- =============================================================================
-- 0001_schema.sql
-- Meridian Hemp Co. farm-CRM — core schema, tables, and triggers.
-- Order: 1 of 4 (run before 0002_rls.sql, 0003_seed_state_legality.sql,
-- 0004_views.sql).
--
-- Creates the `meridian` schema and all application tables:
--   admin_user, farm_intake, farm, material_lot, coa, buyer, buyer_request,
--   deal, activity, state_legality
-- plus the meridian.is_admin() helper used by RLS policies in 0002_rls.sql
-- and a shared meridian.set_updated_at() trigger function.
--
-- Target: PostgreSQL 15+ (Supabase). Idempotent-ish: safe to re-run.
-- =============================================================================

create schema if not exists meridian;

-- -----------------------------------------------------------------------------
-- Shared trigger: keep updated_at current on every row update.
-- -----------------------------------------------------------------------------
create or replace function meridian.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- admin_user — allowlist of admin auth UIDs.
-- Mark's auth.uid() is inserted manually after Phase 0 (see config-notes.md).
-- -----------------------------------------------------------------------------
create table if not exists meridian.admin_user (
  user_id uuid primary key,
  note text
);

-- -----------------------------------------------------------------------------
-- meridian.is_admin() — used by every RLS policy in 0002_rls.sql.
-- security definer + empty search_path so it can read admin_user regardless
-- of caller's RLS/grants, and cannot be hijacked via search_path tricks.
-- -----------------------------------------------------------------------------
create or replace function meridian.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from meridian.admin_user au
    where au.user_id = auth.uid()
  );
$$;

-- -----------------------------------------------------------------------------
-- farm_intake — public "join our supply network" form submissions.
-- -----------------------------------------------------------------------------
create table if not exists meridian.farm_intake (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  legal_name text not null,
  dba text,
  state char(2) not null,
  contact_name text not null,
  contact_email text not null,
  contact_phone text,
  license_number text,
  license_type text check (license_type in ('usda', 'state', 'unknown')),
  annual_capacity_lb numeric,
  material_types text[],
  coa_link text check (coa_link is null or coa_link ~* '^https?://'),
  message text,
  hp text,
  source text default 'web',
  status text not null default 'pending'
    check (status in ('pending', 'promoted', 'rejected')),
  reviewed_at timestamptz,
  reviewed_by uuid
);

-- -----------------------------------------------------------------------------
-- farm — verified/onboarded supplier farms.
-- -----------------------------------------------------------------------------
create table if not exists meridian.farm (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  legal_name text not null,
  dba text,
  state char(2) not null,
  contacts jsonb default '[]',
  license_number text,
  license_type text check (license_type in ('usda', 'state')),
  license_verify_status text not null default 'unverified'
    check (license_verify_status in ('unverified', 'verified', 'failed')),
  license_verify_date date,
  sos_entity_match text not null default 'unverified'
    check (sos_entity_match in ('unverified', 'match', 'mismatch')),
  ncnd_signed boolean not null default false,
  ncnd_signed_date date,
  ncnd_doc_ref text,
  annual_capacity_lb numeric,
  notes text,
  status text not null default 'pending'
    check (status in ('pending', 'verified', 'active', 'suspended')),
  intake_id uuid references meridian.farm_intake(id)
);

drop trigger if exists set_updated_at on meridian.farm;
create trigger set_updated_at
  before update on meridian.farm
  for each row execute function meridian.set_updated_at();

-- -----------------------------------------------------------------------------
-- material_lot — a farm's offered/listed hemp material.
-- -----------------------------------------------------------------------------
create table if not exists meridian.material_lot (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid not null references meridian.farm(id),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  material_type text not null
    check (material_type in ('cbd_flower', 'smalls', 'biomass', 'pre_rolls')),
  strain text,
  grade text check (grade in ('a_bud', 'smalls', 'b_grade')),
  grow_method text check (grow_method in ('indoor', 'light_dep', 'outdoor', 'greenhouse')),
  harvest_date date,
  quantity_lb numeric,
  asking_price_per_lb numeric,
  origin_state char(2),
  status text not null default 'offered'
    check (status in ('offered', 'listed', 'on_hold', 'sold', 'expired')),
  thca_sunset_flag boolean not null default false,
  retest_required boolean not null default false,
  -- set once when a retest trigger first fires (>= $25k value, first-time
  -- supplier, or COA red flag); clearing retest_required leaves this as history
  -- so the flag is never silently re-raised on every save.
  retest_flagged_at timestamptz,
  retained_sample_location text,
  notes text
);

drop trigger if exists set_updated_at on meridian.material_lot;
create trigger set_updated_at
  before update on meridian.material_lot
  for each row execute function meridian.set_updated_at();

-- -----------------------------------------------------------------------------
-- coa — certificate of analysis for a lot. total_thc_pct / passes are
-- generated columns referencing only base columns on this table (valid).
-- -----------------------------------------------------------------------------
create table if not exists meridian.coa (
  id uuid primary key default gen_random_uuid(),
  lot_id uuid not null references meridian.material_lot(id),
  created_at timestamptz default now(),
  lab_name text not null,
  iso17025_accreditation_no text,
  dea_registration_no text,
  coa_date date,
  lims_verify_url text check (lims_verify_url is null or lims_verify_url ~* '^https?://'),
  loq numeric,
  delta9_pct numeric,
  thca_pct numeric,
  cbd_pct numeric,
  total_thc_pct numeric generated always as (delta9_pct + 0.877 * thca_pct) stored,
  passes boolean generated always as ((delta9_pct + 0.877 * thca_pct) <= 0.3) stored,
  verify_status text not null default 'unverified'
    check (verify_status in ('unverified', 'qr_checked', 'retested')),
  storage_path text,
  red_flags text
);

-- -----------------------------------------------------------------------------
-- buyer — verified/onboarded buyers.
-- -----------------------------------------------------------------------------
create table if not exists meridian.buyer (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  company text not null,
  contact_name text,
  email text,
  phone text,
  state char(2),
  license text,
  kyb_status text not null default 'unverified'
    check (kyb_status in ('unverified', 'verified', 'failed')),
  -- buyer-side NCND, mirroring farm — the offer sheet's "covered by NCND terms"
  -- line must be true before a sheet can be generated for this buyer.
  ncnd_signed boolean not null default false,
  ncnd_signed_date date,
  ncnd_doc_ref text,
  notes text
);

drop trigger if exists set_updated_at on meridian.buyer;
create trigger set_updated_at
  before update on meridian.buyer
  for each row execute function meridian.set_updated_at();

-- -----------------------------------------------------------------------------
-- buyer_request — public "source material" form submissions.
-- -----------------------------------------------------------------------------
create table if not exists meridian.buyer_request (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  company text,
  contact_name text not null,
  contact_email text not null,
  contact_phone text,
  state char(2),
  license text,
  material_type text,
  specs text,
  volume_lb numeric,
  price_target_per_lb numeric,
  destination_state char(2),
  timeline text,
  message text,
  hp text,
  source text default 'web',
  status text not null default 'new'
    check (status in ('new', 'reviewing', 'offered', 'negotiating', 'closed_won', 'closed_lost')),
  buyer_id uuid references meridian.buyer(id),
  reviewed_at timestamptz,
  reviewed_by uuid
);

-- -----------------------------------------------------------------------------
-- deal — a farm lot / buyer request matched into a transaction.
-- -----------------------------------------------------------------------------
create table if not exists meridian.deal (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  lot_id uuid references meridian.material_lot(id),
  buyer_request_id uuid references meridian.buyer_request(id),
  buyer_id uuid references meridian.buyer(id),
  commission_basis numeric not null default 0.10,
  agreed_price_per_lb numeric,
  quantity_lb numeric,
  status text not null default 'draft'
    check (status in ('draft', 'offered', 'negotiating', 'closed_won', 'closed_lost')),
  offer_sheet_ref text,
  -- physical-sample step (playbook: no lot closes without a sent sample)
  sample_sent_at timestamptz,
  sample_tracking_ref text,
  notes text
);

drop trigger if exists set_updated_at on meridian.deal;
create trigger set_updated_at
  before update on meridian.deal
  for each row execute function meridian.set_updated_at();

-- -----------------------------------------------------------------------------
-- activity — free-form audit/CRM timeline entries against any entity.
-- -----------------------------------------------------------------------------
create table if not exists meridian.activity (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  entity_type text not null
    check (entity_type in ('farm', 'buyer', 'lot', 'deal', 'buyer_request', 'farm_intake')),
  entity_id uuid not null,
  kind text not null
    check (kind in ('note', 'status_change', 'email', 'quote', 'offer_sheet', 'coa_check', 'coa_release')),
  body text,
  price_snapshot jsonb,
  created_by uuid
);

-- -----------------------------------------------------------------------------
-- state_legality — per-state legality of receiving smokable CBD hemp flower
-- shipments. Seeded in 0003_seed_state_legality.sql.
-- -----------------------------------------------------------------------------
create table if not exists meridian.state_legality (
  state char(2) primary key,
  status text not null check (status in ('allowed', 'blocked', 'gray')),
  notes text,
  updated_at timestamptz default now()
);

-- -----------------------------------------------------------------------------
-- Indexes: foreign keys + hot status/lookup columns.
-- -----------------------------------------------------------------------------
create index if not exists idx_farm_intake_status on meridian.farm_intake (status);

create index if not exists idx_farm_intake_id on meridian.farm (intake_id);

create index if not exists idx_material_lot_farm_id on meridian.material_lot (farm_id);
create index if not exists idx_material_lot_status on meridian.material_lot (status);

create index if not exists idx_coa_lot_id on meridian.coa (lot_id);

create index if not exists idx_buyer_request_status on meridian.buyer_request (status);
create index if not exists idx_buyer_request_buyer_id on meridian.buyer_request (buyer_id);

create index if not exists idx_deal_lot_id on meridian.deal (lot_id);
create index if not exists idx_deal_buyer_request_id on meridian.deal (buyer_request_id);
create index if not exists idx_deal_buyer_id on meridian.deal (buyer_id);

create index if not exists idx_activity_entity on meridian.activity (entity_type, entity_id);
