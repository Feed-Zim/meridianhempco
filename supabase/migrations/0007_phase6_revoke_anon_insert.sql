-- =============================================================================
-- 0007_phase6_revoke_anon_insert.sql   ***CUTOVER-ONLY — DO NOT APPLY YET***
-- -----------------------------------------------------------------------------
-- Phase 6 final step. Apply this ONLY after ALL of the following are true:
--   1. The `public-submit` Edge Function is deployed.
--   2. TURNSTILE_SECRET + RESEND_API_KEY secrets are set on the project.
--   3. The site is rebuilt/deployed with PUBLIC_SUBMIT_ENABLED = true.
--   4. A real end-to-end submission through the function landed a row AND the
--      Resend email arrived.
--
-- Once applied, `anon` can no longer INSERT into the public intake tables, so
-- the ONLY write path becomes the service_role insert inside public-submit.
-- If the function ever breaks, roll back with the block at the bottom to
-- restore the direct-anon path (and set PUBLIC_SUBMIT_ENABLED = false).
--
-- Order: 7 of 7 (run after 0002_rls.sql established the grants/policies).
-- =============================================================================

-- Remove the column-level INSERT grants anon received in 0002_rls.sql.
revoke insert on meridian.farm_intake   from anon;
revoke insert on meridian.buyer_request from anon;

-- Remove the anon insert policies (belt-and-suspenders; with no grant they are
-- already unreachable, but dropping them leaves the schema unambiguous).
drop policy if exists anon_insert_pending on meridian.farm_intake;
drop policy if exists anon_insert_new     on meridian.buyer_request;

-- anon now has NO grant and NO policy anywhere in schema meridian: a pure,
-- write-nothing role. All public writes flow through public-submit only.

-- =============================================================================
-- ROLLBACK (uncomment + run to restore the pre-Phase-6 direct-anon path):
-- =============================================================================
-- grant insert (
--   legal_name, dba, state, contact_name, contact_email, contact_phone,
--   license_number, license_type, annual_capacity_lb, material_types,
--   coa_link, message, hp, source
-- ) on meridian.farm_intake to anon;
--
-- grant insert (
--   company, contact_name, contact_email, contact_phone, state, license,
--   material_type, specs, volume_lb, price_target_per_lb, destination_state,
--   timeline, message, hp, source
-- ) on meridian.buyer_request to anon;
--
-- create policy anon_insert_pending on meridian.farm_intake
--   for insert to anon with check (status = 'pending');
-- create policy anon_insert_new on meridian.buyer_request
--   for insert to anon with check (status = 'new');
