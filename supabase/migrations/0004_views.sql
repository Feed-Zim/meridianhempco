-- =============================================================================
-- 0004_views.sql
-- Meridian Hemp Co. farm-CRM — buyer-safe presentable-lot view.
-- Order: 4 of 4 (run after 0001_schema.sql, 0002_rls.sql,
-- 0003_seed_state_legality.sql).
--
-- meridian.presentable_lot exposes ONLY the fields that are safe to show to
-- buyers/partners: lot + COA facts, with NO farm identity (no legal_name,
-- dba, or contacts columns), so it can be reused later behind an
-- admin-curated buyer-facing surface without leaking supplier identity.
--
-- security_invoker = on means this view runs with the CALLER's privileges
-- and is still subject to RLS on the underlying tables (meridian.farm,
-- meridian.material_lot, meridian.coa) — it does not bypass RLS. Today only
-- `authenticated` (admin) can select it; base-table admin_all policies still
-- gate every row.
-- =============================================================================

drop view if exists meridian.presentable_lot;

create view meridian.presentable_lot
with (security_invoker = on)
as
select
  material_lot.id                          as lot_id,
  material_lot.material_type,
  material_lot.strain,
  material_lot.grade,
  material_lot.grow_method,
  material_lot.harvest_date,
  material_lot.quantity_lb,
  material_lot.asking_price_per_lb,
  material_lot.origin_state,
  coa.id                                   as coa_id,
  coa.lab_name,
  coa.iso17025_accreditation_no,
  coa.dea_registration_no,
  coa.coa_date,
  coa.loq,
  coa.cbd_pct,
  coa.delta9_pct,
  coa.thca_pct,
  coa.total_thc_pct,
  coa.passes
from meridian.material_lot material_lot
join meridian.coa coa
  on coa.lot_id = material_lot.id
join meridian.farm farm
  on farm.id = material_lot.farm_id
where coa.verify_status <> 'unverified'
  and coa.passes
  and material_lot.status in ('offered', 'listed')
  and farm.status in ('verified', 'active')
  and material_lot.retest_required = false
  -- federal sunset guard: flagged lots stop being presentable on 2026-11-12
  -- (dormant today — supply is CBD-only and `passes` already enforces the
  -- 0.3% total-THC math; this pins the legal-classification date itself)
  and not (material_lot.thca_sunset_flag and current_date >= date '2026-11-12');

grant select on meridian.presentable_lot to authenticated;
