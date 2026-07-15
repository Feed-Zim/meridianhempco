// =============================================================================
// public-submit — Meridian Hemp Co. Phase-6 public form gateway (Edge Function)
// -----------------------------------------------------------------------------
// Flow:  browser  ->  this function
//   1. Cloudflare Turnstile token is verified SERVER-SIDE (the real bot gate).
//   2. On success, the lead is inserted via the SERVICE_ROLE key, which bypasses
//      RLS — so THIS FUNCTION is the security boundary. It whitelists exactly the
//      columns anon could insert under 0002_rls.sql, and never trusts a
//      client-supplied `status`/`source` (those fall to their DB defaults:
//      'pending'/'new', 'web'). The honeypot column `hp` is never stored.
//   3. A copy is emailed to the desk via Resend from the verified domain.
//
// After cutover (migration 0007) anon loses INSERT, so this is the ONLY write
// path for the two public intake tables.
//
// Env (Deno.env):
//   TURNSTILE_SECRET           - Cloudflare Turnstile secret key           (SECRET; also accepts CF-meridianhempco-Key)
//   RESEND_API_KEY             - Resend API key                            (SECRET; also accepts Resend-meridianhempco-Key)
//   SUPABASE_URL               - auto-injected by the platform
//   SUPABASE_SERVICE_ROLE_KEY  - auto-injected by the platform
//   NOTIFY_TO                  - optional; default deals@meridianhempco.com
//   NOTIFY_FROM                - optional; MUST be on the Resend-verified domain
//   ALLOWED_ORIGINS            - optional CSV; default apex + www meridianhempco.com
//
// The function reads secrets at REQUEST time (not module load) so it deploys and
// loads cleanly before the secrets exist — it simply returns a clean error until
// they are set. Deploy with verify_jwt ON (default); the browser sends the
// public anon key as a bearer, which passes the gateway. Turnstile is the real
// gate.
// =============================================================================

// Exact per-form column whitelist. MUST mirror the anon INSERT grants in
// 0002_rls.sql. status/source omitted on purpose -> DB DEFAULT applies.
const FIELDS: Record<
  string,
  { table: string; cols: string[]; required: string[] }
> = {
  "buyer-request": {
    table: "buyer_request",
    cols: [
      "company", "contact_name", "contact_email", "contact_phone", "state",
      "license", "material_type", "specs", "volume_lb", "price_target_per_lb",
      "destination_state", "timeline", "message",
    ],
    required: ["contact_name", "contact_email"],
  },
  "farm-intake": {
    table: "farm_intake",
    cols: [
      "legal_name", "dba", "state", "contact_name", "contact_email",
      "contact_phone", "license_number", "license_type", "annual_capacity_lb",
      "material_types", "coa_link", "message",
    ],
    required: ["legal_name", "state", "contact_name", "contact_email"],
  },
};

const MAX_BODY_BYTES = 24_000;   // reject oversized payloads outright
const MAX_STR = 4_000;           // per-field string cap

// Resolve a secret from the first env name that is set. Lets the function work
// whatever the operator named the secret (e.g. the Turnstile secret was stored
// as `CF-meridianhempco-Key`), while still preferring the documented name.
function firstEnv(...names: string[]): string | undefined {
  for (const n of names) {
    const v = Deno.env.get(n);
    if (v) return v;
  }
  return undefined;
}
const TURNSTILE_SECRET_NAMES = [
  "TURNSTILE_SECRET", "CF-meridianhempco-Key", "TURNSTILE_SECRET_KEY",
  "CF_TURNSTILE_SECRET",
];
const RESEND_KEY_NAMES = [
  "RESEND_API_KEY", "RESEND_KEY", "Resend-meridianhempco-Key",
];

const NOTIFY_TO = Deno.env.get("NOTIFY_TO") ?? "deals@meridianhempco.com";
const NOTIFY_FROM = Deno.env.get("NOTIFY_FROM") ??
  "Meridian Hemp Co <deals@meridianhempco.com>";

const ORIGIN_LIST = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const ALLOWED_ORIGINS = new Set(
  ORIGIN_LIST.length
    ? ORIGIN_LIST
    : ["https://meridianhempco.com", "https://www.meridianhempco.com"],
);

function corsHeaders(origin: string | null): Record<string, string> {
  const allow = origin && ALLOWED_ORIGINS.has(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

function esc(s: unknown): string {
  return String(s).replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!),
  );
}

// Whitelist + coerce a raw client payload into a safe insert row. Unknown keys
// are dropped; strings are trimmed + capped; required NOT NULL cols enforced.
function buildRow(
  spec: { cols: string[]; required: string[] },
  payload: Record<string, unknown>,
): Record<string, unknown> | null {
  const row: Record<string, unknown> = {};
  for (const c of spec.cols) {
    let v = payload[c];
    if (v === undefined || v === null) continue;
    if (typeof v === "string") {
      v = v.trim().slice(0, MAX_STR);
      if (v === "") continue;
    } else if (Array.isArray(v)) {
      v = v.filter((x) => typeof x === "string").map((x) => String(x).slice(0, 200)).slice(0, 12);
      if ((v as unknown[]).length === 0) continue;
    } else if (typeof v === "number") {
      if (!Number.isFinite(v)) continue;
    } else {
      continue; // objects/booleans not expected on these columns
    }
    row[c] = v;
  }
  for (const r of spec.required) if (!(r in row)) return null;
  return row;
}

async function sendEmail(
  form: string,
  data: Record<string, unknown>,
  flag: string,
): Promise<void> {
  const key = firstEnv(...RESEND_KEY_NAMES);
  if (!key) return; // email is best-effort; skip silently if unconfigured
  const kind = form === "buyer-request" ? "buyer request" : "farm intake";
  const who = data.company || data.legal_name || data.contact_name || "unnamed";
  const subject = `${flag ? `[FLAGGED ${flag}] ` : ""}New ${kind} — ${who}`;
  const rows = Object.entries(data)
    .map(([k, v]) =>
      `<tr><td style="padding:4px 12px 4px 0;color:#667;white-space:nowrap;vertical-align:top">${esc(k)}</td>` +
      `<td style="padding:4px 0">${esc(Array.isArray(v) ? v.join(", ") : v)}</td></tr>`
    ).join("");
  const html =
    `<div style="font-family:system-ui,Segoe UI,sans-serif;font-size:14px;color:#111">` +
    `<h2 style="margin:0 0 10px">${esc(subject)}</h2>` +
    (flag
      ? `<p style="color:#b00;margin:0 0 10px">Spam-flagged (${esc(flag)}) — no database row was written.</p>`
      : "") +
    `<table style="border-collapse:collapse">${rows}</table></div>`;
  const replyTo = typeof data.contact_email === "string" ? data.contact_email : undefined;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: NOTIFY_FROM,
      to: [NOTIFY_TO],
      subject,
      html,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });
  if (!res.ok) console.error("resend failed", res.status, await res.text());
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin");

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (req.method !== "POST") {
    return json({ error: "method not allowed" }, 405, origin);
  }

  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY_BYTES) return json({ error: "payload too large" }, 413, origin);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad json" }, 400, origin);
  }

  const form = String(body?.form ?? "");
  const spec = FIELDS[form];
  if (!spec) return json({ error: "unknown form" }, 400, origin);

  const flag = typeof body?.flag === "string" ? body.flag.slice(0, 32) : "";
  const payload = (body?.payload && typeof body.payload === "object")
    ? body.payload as Record<string, unknown>
    : {};

  // Honeypot / time-trap: email a flagged copy, write NO db row, report ok so
  // a bot sees success. A false positive must never cost a real lead. No
  // Turnstile needed here (a tripped bot never solved it anyway).
  if (flag) {
    await sendEmail(form, payload, flag).catch(() => {});
    return json({ ok: true }, 200, origin);
  }

  // --- Turnstile server verification: the real bot gate. ---
  const secret = firstEnv(...TURNSTILE_SECRET_NAMES);
  if (!secret) return json({ error: "server not configured" }, 503, origin);
  const token = String(body?.token ?? "");
  if (!token) return json({ error: "verification required" }, 400, origin);

  const ip = req.headers.get("CF-Connecting-IP") ??
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  const verify = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret, response: token, ...(ip ? { remoteip: ip } : {}) }),
    },
  ).then((r) => r.json()).catch(() => ({ success: false }));

  if (!verify?.success) {
    return json({ error: "verification failed" }, 403, origin);
  }

  // --- Whitelist the row, then insert via service_role (RLS bypassed). ---
  const row = buildRow(spec, payload);
  if (!row) return json({ error: "missing required fields" }, 422, origin);

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!SUPABASE_URL || !SERVICE_KEY) {
    return json({ error: "server not configured" }, 503, origin);
  }

  const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/${spec.table}`, {
    method: "POST",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Content-Profile": "meridian", // schema (PostgREST write profile)
      "Prefer": "return=minimal",
    },
    body: JSON.stringify(row),
  });

  if (!insertRes.ok) {
    console.error("insert failed", insertRes.status, await insertRes.text());
    return json({ error: "could not save submission" }, 502, origin);
  }

  // DB row is the source of truth; the email is best-effort.
  await sendEmail(form, row, "").catch((e) => console.error("email error", e));

  return json({ ok: true }, 200, origin);
});
