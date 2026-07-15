-- =============================================================================
-- 0008_phase6_grant_service_role_intake.sql
-- -----------------------------------------------------------------------------
-- Phase 6 prerequisite for the public-submit Edge Function.
--
-- The function inserts leads via the SERVICE_ROLE key. The `meridian` schema was
-- built least-privilege for the `anon` and `authenticated` roles ONLY (see
-- 0002_rls.sql), so `service_role` had zero access to it — a service_role insert
-- failed with:  42501 "permission denied for schema meridian".
-- (This stayed invisible until now because the honeypot/flag path emails without
-- ever touching the schema; only a real insert exercises it.)
--
-- Grant service_role EXACTLY what the function needs and nothing more: USAGE on
-- the schema + INSERT on the two public intake tables. It deliberately gets NO
-- access to the PII tables (farm, coa, buyer, deal, activity, …), so even a
-- leaked service key could only append intake rows — never read supplier/buyer
-- data. The function itself remains the security boundary (it whitelists columns
-- and forces status/source to their DB defaults).
--
-- Applied BEFORE the live E2E test. Independent of 0007 (the anon-INSERT revoke),
-- which is applied only AFTER that test passes.
-- =============================================================================

grant usage  on schema meridian            to service_role;
grant insert on meridian.buyer_request     to service_role;
grant insert on meridian.farm_intake       to service_role;

-- Rollback:
--   revoke insert on meridian.buyer_request from service_role;
--   revoke insert on meridian.farm_intake  from service_role;
--   revoke usage  on schema meridian        from service_role;
