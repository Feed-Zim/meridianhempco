-- =============================================================================
-- 0002_rls.sql
-- Meridian Hemp Co. farm-CRM — Row Level Security + grants.
-- Order: 2 of 4 (run after 0001_schema.sql; before 0003_seed_state_legality.sql,
-- 0004_views.sql).
--
-- Design summary:
--   * Default-deny: RLS is enabled on every meridian table, and all default
--     grants are revoked from anon/authenticated before anything is re-granted.
--   * anon (public web forms) gets ONLY column-level INSERT on farm_intake and
--     buyer_request, gated by a `with check (status = '<initial value>')`
--     policy. This blocks status forgery: an anonymous submitter cannot insert
--     a row with status = 'promoted'/'rejected' (farm_intake) or anything other
--     than 'new' (buyer_request) because the WITH CHECK clause rejects the
--     insert outright. anon has NO select grant and NO select policy anywhere
--     in this schema — it is a write-only mailbox.
--     IMPORTANT: because anon cannot select, the client-side supabase-js call
--     MUST be a bare `.insert(...)` and must NOT chain `.select()` (PostgREST
--     tries to read back the inserted row for `.select()`, which anon cannot
--     do, and the request will fail/return no data).
--   * authenticated (admin app users) gets full CRUD via meridian.is_admin(),
--     which checks membership in meridian.admin_user. Only rows created by
--     Phase-0 setup in admin_user can pass; every authenticated policy is a
--     single `for all ... using (meridian.is_admin()) with check (meridian.is_admin())`
--     so a logged-in non-admin user still sees nothing.
--   * storage.objects policies for the private `coa-private` bucket follow the
--     same is_admin()-gated pattern; there is no anon/public access.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Enable RLS on every meridian table.
-- -----------------------------------------------------------------------------
alter table meridian.admin_user      enable row level security;
alter table meridian.farm_intake     enable row level security;
alter table meridian.farm            enable row level security;
alter table meridian.material_lot    enable row level security;
alter table meridian.coa             enable row level security;
alter table meridian.buyer           enable row level security;
alter table meridian.buyer_request   enable row level security;
alter table meridian.deal            enable row level security;
alter table meridian.activity        enable row level security;
alter table meridian.state_legality  enable row level security;

-- -----------------------------------------------------------------------------
-- Default-deny hygiene: strip default grants, then re-grant deliberately.
-- -----------------------------------------------------------------------------
revoke all on all tables in schema meridian from anon, authenticated;

grant usage on schema meridian to anon, authenticated;

-- -----------------------------------------------------------------------------
-- anon: column-level INSERT on the two public intake tables only.
-- -----------------------------------------------------------------------------
grant insert (
  legal_name, dba, state, contact_name, contact_email, contact_phone,
  license_number, license_type, annual_capacity_lb, material_types,
  coa_link, message, hp, source
) on meridian.farm_intake to anon;

grant insert (
  company, contact_name, contact_email, contact_phone, state, license,
  material_type, specs, volume_lb, price_target_per_lb, destination_state,
  timeline, message, hp, source
) on meridian.buyer_request to anon;

drop policy if exists anon_insert_pending on meridian.farm_intake;
create policy anon_insert_pending
  on meridian.farm_intake
  for insert
  to anon
  with check (status = 'pending');

drop policy if exists anon_insert_new on meridian.buyer_request;
create policy anon_insert_new
  on meridian.buyer_request
  for insert
  to anon
  with check (status = 'new');

-- No select grants and no select policies for anon anywhere in this schema.

-- -----------------------------------------------------------------------------
-- Function EXECUTE: Postgres grants EXECUTE to PUBLIC by default (unlike tables,
-- which default-deny). Strip that so anon can call nothing, then re-grant only
-- to authenticated. anon never needs any meridian function — the anon INSERT
-- policies check status literals, not is_admin(); trigger functions fire on DML
-- regardless of the invoking role's EXECUTE privilege.
-- -----------------------------------------------------------------------------
revoke execute on all functions in schema meridian from public, anon;

-- -----------------------------------------------------------------------------
-- authenticated: full CRUD, gated entirely by meridian.is_admin().
-- -----------------------------------------------------------------------------
grant select, insert, update, delete on all tables in schema meridian to authenticated;
grant execute on all functions in schema meridian to authenticated;

drop policy if exists admin_all on meridian.admin_user;
create policy admin_all
  on meridian.admin_user
  for all
  to authenticated
  using (meridian.is_admin())
  with check (meridian.is_admin());

drop policy if exists admin_all on meridian.farm_intake;
create policy admin_all
  on meridian.farm_intake
  for all
  to authenticated
  using (meridian.is_admin())
  with check (meridian.is_admin());

drop policy if exists admin_all on meridian.farm;
create policy admin_all
  on meridian.farm
  for all
  to authenticated
  using (meridian.is_admin())
  with check (meridian.is_admin());

drop policy if exists admin_all on meridian.material_lot;
create policy admin_all
  on meridian.material_lot
  for all
  to authenticated
  using (meridian.is_admin())
  with check (meridian.is_admin());

drop policy if exists admin_all on meridian.coa;
create policy admin_all
  on meridian.coa
  for all
  to authenticated
  using (meridian.is_admin())
  with check (meridian.is_admin());

drop policy if exists admin_all on meridian.buyer;
create policy admin_all
  on meridian.buyer
  for all
  to authenticated
  using (meridian.is_admin())
  with check (meridian.is_admin());

drop policy if exists admin_all on meridian.buyer_request;
create policy admin_all
  on meridian.buyer_request
  for all
  to authenticated
  using (meridian.is_admin())
  with check (meridian.is_admin());

drop policy if exists admin_all on meridian.deal;
create policy admin_all
  on meridian.deal
  for all
  to authenticated
  using (meridian.is_admin())
  with check (meridian.is_admin());

drop policy if exists admin_all on meridian.activity;
create policy admin_all
  on meridian.activity
  for all
  to authenticated
  using (meridian.is_admin())
  with check (meridian.is_admin());

drop policy if exists admin_all on meridian.state_legality;
create policy admin_all
  on meridian.state_legality
  for all
  to authenticated
  using (meridian.is_admin())
  with check (meridian.is_admin());

-- Note: admin_all's `for all` on farm_intake / buyer_request already covers
-- INSERT for authenticated admins (e.g. an admin manually logging a phone-in
-- intake), so no separate authenticated insert policy is needed on those
-- two tables.

-- -----------------------------------------------------------------------------
-- Storage: policies below apply to storage.objects (not a meridian table),
-- scoped to the private `coa-private` bucket (create the bucket itself via
-- the Supabase dashboard — see config-notes.md). Admin-only; no anon/public
-- access to COA files.
-- -----------------------------------------------------------------------------
drop policy if exists coa_private_admin_select on storage.objects;
create policy coa_private_admin_select
  on storage.objects
  for select
  to authenticated
  using (bucket_id = 'coa-private' and meridian.is_admin());

drop policy if exists coa_private_admin_insert on storage.objects;
create policy coa_private_admin_insert
  on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'coa-private' and meridian.is_admin());

drop policy if exists coa_private_admin_update on storage.objects;
create policy coa_private_admin_update
  on storage.objects
  for update
  to authenticated
  using (bucket_id = 'coa-private' and meridian.is_admin())
  with check (bucket_id = 'coa-private' and meridian.is_admin());

drop policy if exists coa_private_admin_delete on storage.objects;
create policy coa_private_admin_delete
  on storage.objects
  for delete
  to authenticated
  using (bucket_id = 'coa-private' and meridian.is_admin());
