// Thin Supabase client wrapper for the public forms (buyer request / farm intake).
// Reads runtime config from supabase-config.js so the anon key + URL are the
// only things that need to change when Phase 0 (Postgres/Supabase setup) lands.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';

// True once the placeholder tokens have been swapped for real project values.
export function isConfigured() {
  return SUPABASE_URL !== '__SUPABASE_URL__' && SUPABASE_ANON_KEY !== '__SUPABASE_ANON_KEY__';
}

// Only construct the client when configured — createClient() throws on an
// invalid placeholder URL, and forms.js has a working fallback (email-only)
// for the unconfigured state, so this must not throw at module-load time.
export const supabase = isConfigured()
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      db: { schema: 'meridian' },
      auth: { persistSession: true },
    })
  : null;
