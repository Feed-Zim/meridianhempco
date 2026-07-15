-- =============================================================================
-- 0005_mfa_aal.sql
-- Meridian Hemp Co. farm-CRM — step-up MFA (TOTP) enforcement in RLS.
-- Order: 5 of 5 (run after 0004_views.sql).
--
-- What this changes:
--   meridian.is_admin() previously returned true for any auth.uid() present in
--   meridian.admin_user, at ANY Authenticator Assurance Level (AAL). This adds
--   the official Supabase "enforce MFA for users who have opted in" pattern:
--
--     * An admin with NO verified MFA factor  -> AAL1 is accepted (unchanged).
--       This is what prevents self-lockout: the very first login (before anyone
--       has enrolled TOTP) and any future factor-less admin still works at AAL1.
--     * An admin WITH >=1 verified MFA factor  -> the session JWT must carry
--       aal = 'aal2'. A password-only (AAL1) session now fails is_admin(), so
--       every meridian table AND the coa-private storage bucket become invisible
--       until the client completes a TOTP challenge and the session is elevated.
--
--   Because every RLS policy in 0002_rls.sql (and the storage.objects COA
--   policies) is expressed as `... using (meridian.is_admin())`, changing this
--   one function upgrades the whole security surface at once.
--
-- Safety / recovery:
--   * Deploying this while the sole admin has zero factors is a no-op for access
--     (the else-branch returns true), so it can ship before the client MFA UI.
--   * Break-glass if an authenticator is ever lost: delete the row from
--     auth.mfa_factors for that user (service role / Management API) — the admin
--     drops back to the AAL1-accepted branch and can sign in with password only.
--
-- Notes:
--   * SECURITY DEFINER + empty search_path is preserved. The definer role can
--     read auth.mfa_factors (verified: the same role reads it via the
--     Management API), so the added subquery does not raise permission errors.
--   * auth.jwt() ->> 'aal' is NULL only if the claim is absent; NULL = 'aal2'
--     is NULL, which the outer AND treats as not-admin (fail-closed). Supabase
--     access tokens always include aal, so legitimate AAL2 sessions pass.
-- =============================================================================

create or replace function meridian.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    exists (
      select 1
      from meridian.admin_user au
      where au.user_id = auth.uid()
    )
    and (
      select case
        when count(*) > 0 then (auth.jwt() ->> 'aal') = 'aal2'
        else true
      end
      from auth.mfa_factors f
      where f.user_id = auth.uid()
        and f.status = 'verified'
    );
$$;
