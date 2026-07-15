// Thin Supabase client wrapper for the public forms and admin dashboard.
// Uses the VENDORED UMD bundle (/assets/js/vendor/supabase.min.js, loaded via a
// classic <script defer> tag before any module script) — window.supabase — so
// there is NO runtime CDN dependency: if the bundle somehow fails to load, this
// module still imports cleanly and `supabase` is null, letting forms.js fall
// back to email-only capture instead of dying with it.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';

// True once the placeholder tokens have been swapped for real project values.
export function isConfigured() {
  return SUPABASE_URL !== '__SUPABASE_URL__' && SUPABASE_ANON_KEY !== '__SUPABASE_ANON_KEY__';
}

const factory = (typeof window !== 'undefined' && window.supabase && window.supabase.createClient) || null;

export const supabase = (isConfigured() && factory)
  ? factory(SUPABASE_URL, SUPABASE_ANON_KEY, {
      db: { schema: 'meridian' },
      auth: { persistSession: true },
    })
  : null;
