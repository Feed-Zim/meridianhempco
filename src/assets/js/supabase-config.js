// Public runtime config — the anon key is designed to be public; security is enforced by RLS.
// Project: meridian-hemp (dedicated; Phase 0 completed 2026-07-15).
export const SUPABASE_URL = 'https://shujrqtvwdeqldbizgnk.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNodWpycXR2d2RlcWxkYml6Z25rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQwODM2NTEsImV4cCI6MjA5OTY1OTY1MX0.5RMamTe1RVisVefXNxUAvHtwW2f1sZKGThfXTO0w70w';

// --- Phase 6 (Turnstile + Resend via the public-submit Edge Function) ---------
// Cloudflare Turnstile SITE key is public by design (browser widget only; the
// SECRET key lives in the Edge Function's Supabase secrets, never here).
export const TURNSTILE_SITE_KEY = '0x4AAAAAAD2p4L6Zax9JHtxa';
// The public-submit Edge Function endpoint (Turnstile verify -> insert -> email).
export const PUBLIC_SUBMIT_URL = `${SUPABASE_URL}/functions/v1/public-submit`;
// CUTOVER SWITCH — keep false until the two secrets are set, the function is
// deployed, and an end-to-end test passes. Flipping to true routes both forms
// through the Turnstile-gated Edge Function instead of the direct anon insert.
// After it's proven live, apply migration 0007 to revoke anon INSERT for good.
export const PUBLIC_SUBMIT_ENABLED = true;
