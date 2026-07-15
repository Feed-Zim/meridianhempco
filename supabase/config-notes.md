# Meridian Hemp Co. — Supabase setup (Phase 0)

> **STATUS: COMPLETED 2026-07-15** — incl. Mark's admin login + allowlist row,
> and TOTP two-factor (migration 0005 + admin enroll/challenge UI, see below).
> Project: `meridian-hemp`, ref `shujrqtvwdeqldbizgnk`, region `us-west-1`,
> org "Feed-Zim's Org" (free plan). Migrations 0001→0004 applied; `meridian`
> exposed in PostgREST; signups disabled; `coa-private` bucket created (Private);
> anon key wired into `src/assets/js/supabase-config.js` and deployed via CI.
> RLS verification suite: all security checks passed (anon denied everywhere,
> forged status rejected, throwaway non-admin saw zero rows, throwaway admin had
> full CRUD, bucket admin-only); all test artifacts deleted afterward.
> Executed via the Supabase Management API directly (PAT from `research/.env`) —
> the hosted MCP wasn't connected in the session; same PAT, same effect.
> Note: free-plan projects pause after ~1 week of inactivity — the weekly
> backup ping below keeps it warm, or upgrade before real deal flow.

**Decision (2026-07-14):** this app gets its own **dedicated Supabase project** —
NOT the shared org project `cepqtbfocqjrngfjornf`. Supplier/buyer PII and COA
files stay isolated from every other project's keys and tooling.

**How this runs:** the Supabase MCP is connected (hosted server, PAT auth,
org-wide read-write: `apply_migration`, `execute_sql`, management API), so
Claude executes nearly all of Phase 0. Mark has exactly three manual steps,
marked **MARK** below. Everything else is automated in a session.

## Claude's automated flow (in order)

1. **Verify MCP + org** — list organizations/projects; confirm the PAT works
   and `cepqtbfocqjrngfjornf` is visible (proves org scope).
2. **MARK ①: approve project creation** — Claude creates the dedicated
   project (suggested name `meridian-hemp`, region `us-west`; DB password
   generated and stored nowhere — dashboard reset if ever needed). Creation
   is billable-surface, so it waits for an explicit yes.
3. **Apply migrations in order** via `apply_migration`:
   `0001_schema.sql` → `0002_rls.sql` → `0003_seed_state_legality.sql` →
   `0004_views.sql`. Confirm each before the next.
4. **Expose the schema** — add `meridian` to PostgREST exposed schemas
   (management API / config; without it the client can't reach any table
   regardless of grants).
5. **Auth config** — disable public signups (no self-serve accounts exist).
6. **MARK ②: create his admin login** — email + password in the dashboard
   (Authentication → Users → Add user), ideally with TOTP enrolled. Passwords
   never pass through chat. Claude then inserts the allowlist row:
   ```sql
   insert into meridian.admin_user (user_id, note)
   values ('<uid from auth.users>', 'Mark');
   ```
   and **MARK ③ confirms** the uid shown matches his user before it's run.
7. **Storage** — create bucket `coa-private`, **Private**. Access is governed
   by the `storage.objects` policies from `0002_rls.sql` (admin-only).
8. **Wire the site** — fetch Project URL + anon key, write them into
   `src/assets/js/supabase-config.js`, rebuild, deploy. (The anon key is
   public-safe by design; RLS is the security model.)
9. **Run the RLS verification suite** (below) with REST calls using the anon
   key + a signed-in admin session. Nothing ships until every box passes.

## RLS verification suite (Claude runs; all must pass)

- [ ] `select relname, relrowsecurity from pg_class where relnamespace =
      'meridian'::regnamespace and relkind = 'r';` → `true` for every table
      (admin_user, farm_intake, farm, material_lot, coa, buyer,
      buyer_request, deal, activity, state_legality).
- [ ] Anon `select` denied on **every** `meridian` table and on
      `presentable_lot` (empty/denied, never data).
- [ ] Anon `insert` into `farm_intake` lands `status='pending'`;
      into `buyer_request` lands `status='new'`.
- [ ] **Forged status rejected**: anon insert with `status='promoted'` /
      `'closed_won'` fails the `with check` policy (error, not downgrade).
- [ ] Client inserts stay bare `.insert(...)` with no chained `.select()`
      (anon has no select grant — a chained select breaks the success path).
- [ ] Admin session: full CRUD on every table; `meridian.is_admin()` = true.
- [ ] A second non-admin authenticated user (create a throwaway, then delete)
      sees zero rows everywhere — policies key off `admin_user` membership,
      not the `authenticated` role.
- [ ] `coa-private` bucket is Private; only the admin can list/upload/sign.
- [ ] Spot-check `state_legality` rows against `notes/hemp/state-matrix-*.md`;
      the ~24 'gray' states (see 0003 header) need real research before an
      offer ships to one.

## Backups (set up right after Phase 0)

- Supabase Free/Pro keeps daily automatic backups (Pro: 7 days) — check the
  plan's retention and upgrade if deals depend on this data.
- **Weekly export**: Claude (via MCP `execute_sql`) dumps each `meridian`
  table to CSV into `research/output/hemp/backups/` (or Mark clicks
  Database → Backups → Download). Calendar it — the CRM is the business.
- Admin dashboard also has per-tab **Export CSV** buttons for ad-hoc copies.
- COA files in `coa-private` are NOT in DB backups — export the bucket
  (Storage API list + download) alongside the SQL dump.

## Notes

- Never put the service-role key, DB password, or PAT in this repo. The PAT
  lives in `research/.env` (`SUPABASE_PAT`); the site ships only the anon key.

## Two-factor authentication (TOTP) — added 2026-07-15

- **Migration `0005_mfa_aal.sql`** rewrote `meridian.is_admin()` to the Supabase
  "enforce MFA for users who have opted in" pattern: an admin with **no** verified
  factor still passes at AAL1 (prevents self-lockout), but once **any** verified
  TOTP factor exists, the session JWT must carry `aal = 'aal2'` or `is_admin()`
  returns false — so every table AND the `coa-private` bucket become invisible
  until a TOTP challenge elevates the session. One function change hardens the
  whole surface (all RLS policies + storage policies call `is_admin()`).
- **Admin UI** (`admin.js` / `admin.html`): password sign-in, then a step-up
  challenge screen whenever a verified factor exists; a "Two-factor" panel in the
  shell to enroll (QR + secret) or disable. Enroll/challenge/verify use the
  vendored supabase-js `auth.mfa.*` API — no new dependency.
- **Validated 2026-07-15**: a throwaway-admin harness (real JWTs + real TOTP
  codes) passed 12/12 — AAL1-no-factor keeps access, post-enroll AAL1 is denied,
  AAL2 is allowed; and the full enroll → re-login → challenge → shell flow was
  driven in a real browser. All test accounts deleted afterward.
- **Break-glass (lost authenticator):** delete the user's rows from
  `auth.mfa_factors` (service role / Management API) — they drop back to the
  AAL1-accepted branch and can sign in with password only, then re-enroll.
- If the MCP is unavailable, the fallback is the old manual flow: paste each
  migration into the SQL Editor in order, then do steps 4–9 by hand in the
  dashboard.

## Phase 6 — Turnstile + Resend hardening (BUILT 2026-07-15, dormant)

Goal: move public form submits from the direct anon insert (+ formsubmit email)
to a Turnstile-gated Edge Function that inserts via service_role and emails via
Resend — then revoke anon INSERT entirely so the function is the only write path.

**What's already built and deployed (all inert until the switch is flipped):**
- **Edge Function `public-submit`** — deployed (version 1, `verify_jwt` on).
  Verifies the Turnstile token server-side → whitelists exactly the anon-grant
  columns (forces `status`/`source` to DB defaults; never stores `hp`) →
  inserts via service_role → emails via Resend. Source:
  `supabase/functions/public-submit/index.ts`. Smoke-tested live: OPTIONS→204
  with CORS, unknown-form→400, unconfigured→503, no-bearer→401.
- **Frontend (flag OFF)** — `src/assets/js/supabase-config.js` holds the public
  `TURNSTILE_SITE_KEY` (`0x4AAAAAAD2p4L6Zax9JHtxa`), `PUBLIC_SUBMIT_URL`, and
  `PUBLIC_SUBMIT_ENABLED = false`. `forms.js` mounts the Turnstile widget and
  routes through the function ONLY when that flag is true; today it behaves
  exactly as before.
- **Revoke migration `0007_phase6_revoke_anon_insert.sql`** — staged, NOT
  applied. Has an inline rollback block.

**The two SECRETS (never in the repo, never in the browser):**
- `TURNSTILE_SECRET` — Cloudflare Turnstile secret key (pairs with the site key).
- `RESEND_API_KEY` — Resend API key.
They live in the project's Edge Function secret store, injected as
`Deno.env.get(...)`. `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` are
auto-injected — do NOT set them.

**Optional secrets:** `NOTIFY_TO` (default `deals@meridianhempco.com`),
`NOTIFY_FROM` (default `Meridian Hemp Co <deals@meridianhempco.com>` — MUST be on
the Resend-verified domain), `ALLOWED_ORIGINS` (CSV; default apex + www; add a
localhost origin here temporarily if testing from a local preview).

### Cutover checklist (in order — do NOT reorder)
1. **MARK: Resend** — create the API key; add + verify the sending domain
   (SPF/DKIM/DMARC DNS records at the registrar — allow propagation time). Pick
   the From address (e.g. `deals@meridianhempco.com` or a `send.` subdomain) and
   set `NOTIFY_FROM` to match the verified domain.
2. **MARK: Turnstile** — in the same Cloudflare widget as the site key, copy the
   **secret** key.
3. **Set the secrets** — dashboard (Project Settings → Edge Functions → Secrets)
   or `supabase secrets set TURNSTILE_SECRET=… RESEND_API_KEY=… NOTIFY_FROM=…`,
   or hand them to Claude (research/.env / safe DM) to push via Management API.
   The Supabase MCP has no secrets tool — this goes through the dashboard/CLI/API.
4. **Flip the flag** — set `PUBLIC_SUBMIT_ENABLED = true` in supabase-config.js;
   rebuild; sync to the deploy repo (`Feed-Zim/meridianhempco`); push → CI deploys.
5. **Test end-to-end** — submit both forms on the live site: Turnstile renders,
   a row lands in `farm_intake`/`buyer_request`, and the Resend email arrives.
   Trip the honeypot/time-trap → a `[FLAGGED]` email arrives, NO row written.
6. **Revoke anon** — only after step 5 passes, apply
   `0007_phase6_revoke_anon_insert.sql` (MCP `apply_migration`). Now the function
   is the sole write path. Re-test both forms once more.
7. **Retire formsubmit** — it's no longer used in edge mode; leave the code path
   as the automatic fallback (it re-activates if the flag is ever turned off).

**Rollback:** set `PUBLIC_SUBMIT_ENABLED = false` (rebuild/deploy) and run the
rollback block in 0007 to restore the anon grants. Direct-anon path resumes.
