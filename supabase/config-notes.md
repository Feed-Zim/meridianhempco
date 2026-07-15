# Meridian Hemp Co. — Supabase setup (Phase 0)

> **STATUS: COMPLETED 2026-07-15** (except MARK ②/③ — admin login + allowlist row).
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
- If the MCP is unavailable, the fallback is the old manual flow: paste each
  migration into the SQL Editor in order, then do steps 4–9 by hand in the
  dashboard.
