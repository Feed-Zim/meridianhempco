// Handles both public forms — buyer request (/request/) and farm intake
// (/growers/) — detected via the [data-form] attribute on <form>.
//
// Pipeline per submit: honeypot check -> time-trap check -> client validation
// -> Supabase insert (RLS-scoped anon insert, no .select()) -> fire-and-forget
// email notification -> on-brand success panel. Any failure short of the
// honeypot/time-trap checks re-enables the form with an inline error.
import { supabase } from './supabase-client.js';
import {
  SUPABASE_ANON_KEY,
  PUBLIC_SUBMIT_ENABLED,
  PUBLIC_SUBMIT_URL,
  TURNSTILE_SITE_KEY,
} from './supabase-config.js';

const TABLE_BY_FORM = {
  'buyer-request': 'buyer_request',
  'farm-intake': 'farm_intake',
};

const MIN_SUBMIT_MS = 2500; // reject submits faster than a human could fill the form

// US states + DC for <select data-states> elements — populated at load so the
// page fragments stay small and the list lives in one place.
const US_STATES = [
  ['AL','Alabama'],['AK','Alaska'],['AZ','Arizona'],['AR','Arkansas'],['CA','California'],
  ['CO','Colorado'],['CT','Connecticut'],['DE','Delaware'],['DC','District of Columbia'],
  ['FL','Florida'],['GA','Georgia'],['HI','Hawaii'],['ID','Idaho'],['IL','Illinois'],
  ['IN','Indiana'],['IA','Iowa'],['KS','Kansas'],['KY','Kentucky'],['LA','Louisiana'],
  ['ME','Maine'],['MD','Maryland'],['MA','Massachusetts'],['MI','Michigan'],['MN','Minnesota'],
  ['MS','Mississippi'],['MO','Missouri'],['MT','Montana'],['NE','Nebraska'],['NV','Nevada'],
  ['NH','New Hampshire'],['NJ','New Jersey'],['NM','New Mexico'],['NY','New York'],
  ['NC','North Carolina'],['ND','North Dakota'],['OH','Ohio'],['OK','Oklahoma'],['OR','Oregon'],
  ['PA','Pennsylvania'],['RI','Rhode Island'],['SC','South Carolina'],['SD','South Dakota'],
  ['TN','Tennessee'],['TX','Texas'],['UT','Utah'],['VT','Vermont'],['VA','Virginia'],
  ['WA','Washington'],['WV','West Virginia'],['WI','Wisconsin'],['WY','Wyoming'],
];

function populateStateSelects() {
  document.querySelectorAll('select[data-states]').forEach((sel) => {
    const placeholder = sel.dataset.states || 'Select a state';
    sel.insertAdjacentHTML('beforeend', `<option value="">${placeholder}</option>`);
    for (const [code, name] of US_STATES) {
      sel.insertAdjacentHTML('beforeend', `<option value="${code}">${name}</option>`);
    }
  });
}
const NOTIFY_EMAIL = 'https://formsubmit.co/ajax/deals@meridianhempco.com';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function clearFieldError(field) {
  field.removeAttribute('aria-invalid');
  field.removeAttribute('aria-describedby');
  const wrap = field.closest('.field');
  const existing = wrap && wrap.querySelector('.field-error');
  if (existing) existing.remove();
}

function showFieldError(field, message) {
  clearFieldError(field);
  const wrap = field.closest('.field');
  if (!wrap) return;
  const err = document.createElement('p');
  err.className = 'field-error';
  err.id = `${field.name}-error`;
  err.textContent = message;
  field.setAttribute('aria-invalid', 'true');
  field.setAttribute('aria-describedby', err.id);
  wrap.appendChild(err);
}

function clearFormError(form) {
  const existing = form.querySelector('.form-error');
  if (existing) existing.remove();
}

function showFormError(form, message) {
  clearFormError(form);
  const p = document.createElement('p');
  p.className = 'form-error';
  p.setAttribute('role', 'alert');
  p.textContent = message;
  form.prepend(p);
}

// Validates every [required] field (text/email/select/textarea). Checkbox
// groups in these two forms are never required, so checkboxes are skipped.
function validateForm(form) {
  let valid = true;
  form.querySelectorAll('[required]').forEach((field) => {
    if (field.type === 'checkbox' || field.type === 'radio') return;
    clearFieldError(field);
    const value = (field.value || '').trim();
    if (!value) {
      showFieldError(field, 'This field is required.');
      valid = false;
      return;
    }
    if (field.type === 'email' && !EMAIL_RE.test(value)) {
      showFieldError(field, 'Enter a valid email address.');
      valid = false;
    }
  });
  return valid;
}

// Builds the insert payload from named fields. Checkbox groups that share a
// name (e.g. material_types) collect into a JS array — supabase-js
// serializes arrays fine for a Postgres text[] column.
function collectPayload(form) {
  const payload = {};
  const seen = new Set();

  for (const field of form.elements) {
    if (!field.name || field.name === 'hp' || seen.has(field.name)) continue;
    // underscore-prefixed inputs are formsubmit control fields (native no-JS
    // fallback path) — never part of the DB payload
    if (field.name.startsWith('_')) continue;
    if (field.tagName === 'BUTTON') continue;

    if (field.type === 'checkbox') {
      const group = form.querySelectorAll(`input[type="checkbox"][name="${field.name}"]`);
      seen.add(field.name);
      if (group.length > 1) {
        payload[field.name] = Array.from(group).filter((c) => c.checked).map((c) => c.value);
      } else {
        payload[field.name] = field.checked;
      }
      continue;
    }

    const value = (field.value || '').trim();
    seen.add(field.name);
    if (value === '') continue;
    payload[field.name] = field.type === 'number' ? Number(value) : value;
  }

  return payload;
}

// Email notification via formsubmit. Returns a promise resolving true only on
// a confirmed 2xx — callers decide whether to await it (it is the ONLY capture
// path until Supabase is configured, so silent failure there = a lost lead).
function notifyByEmail(payload, formType, flag) {
  const who = payload.company || payload.legal_name || payload.contact_name || 'unnamed';
  const kind = formType === 'buyer-request' ? 'buyer request' : 'farm intake';
  const flat = {
    _subject: `${flag ? '[FLAGGED ' + flag + '] ' : ''}New ${kind} — ${who}`,
    _template: 'table',
    form: formType,
    ...payload,
  };
  if (flag) flat.flagged = flag;
  if (Array.isArray(flat.material_types)) flat.material_types = flat.material_types.join(', ');
  return fetch(NOTIFY_EMAIL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(flat),
  }).then((r) => r.ok).catch(() => false);
}

// --- Phase 6: Turnstile widget + Edge Function submit path -------------------
// All of the below is dormant unless PUBLIC_SUBMIT_ENABLED is true. When on, the
// real submit routes through the public-submit Edge Function (Turnstile verified
// server-side) instead of the direct anon insert; the honeypot/time-trap copies
// also go through it (with a `flag`) so email moves to Resend and formsubmit is
// retired.
let turnstileScriptLoaded = false;
function loadTurnstileScript() {
  if (turnstileScriptLoaded) return;
  turnstileScriptLoaded = true;
  const s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
  s.async = true;
  s.defer = true;
  document.head.appendChild(s);
}

// Injects an auto-rendering Turnstile widget just above the submit button.
// Turnstile writes the solved token into a hidden <input name="cf-turnstile-
// response"> inside this form, which we read at submit time.
function mountTurnstile(form) {
  if (form.querySelector('.cf-turnstile')) return;
  const holder = document.createElement('div');
  holder.className = 'cf-turnstile mhc-turnstile';
  holder.setAttribute('data-sitekey', TURNSTILE_SITE_KEY);
  holder.setAttribute('data-theme', 'auto');
  const submitBtn = form.querySelector('[type="submit"]');
  if (submitBtn && submitBtn.parentNode) {
    submitBtn.parentNode.insertBefore(holder, submitBtn);
  } else {
    form.appendChild(holder);
  }
}

function turnstileToken(form) {
  const el = form.querySelector('[name="cf-turnstile-response"]');
  return el ? (el.value || '') : '';
}

// POST to the public-submit Edge Function. The public anon key is sent as the
// bearer so the request clears the functions gateway; Turnstile is the real
// gate. Resolves on a 2xx, throws otherwise.
async function submitViaEdge(payload, formType, { flag = '', token = '' } = {}) {
  const res = await fetch(PUBLIC_SUBMIT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ form: formType, payload, flag, token }),
  });
  if (!res.ok) {
    let msg = `submit failed (${res.status})`;
    try { const j = await res.json(); if (j && j.error) msg = j.error; } catch (e) {}
    throw new Error(msg);
  }
  return true;
}

function showSuccess(form) {
  const panel = document.createElement('div');
  panel.className = 'form-success';
  panel.setAttribute('role', 'status');
  panel.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M20 6 9 17l-5-5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    <div>
      <h3>Received.</h3>
      <p>Response within one business day.</p>
    </div>`;
  form.replaceWith(panel);
}

function initForm(form) {
  const formType = form.dataset.form;
  const table = TABLE_BY_FORM[formType];
  if (!table) return;

  const loadedAt = Date.now();
  const submitBtn = form.querySelector('[type="submit"]');
  const submitLabel = submitBtn ? submitBtn.textContent : '';

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    // Honeypot — bots tend to fill every field, humans never see this one.
    // A trip still emails a [FLAGGED] copy (a false positive must never cost
    // a real lead) but shows the bot a plain success and writes no DB row.
    const hp = form.querySelector('[name="hp"]');
    if (hp && hp.value.trim() !== '') {
      const flagged = collectPayload(form);
      if (PUBLIC_SUBMIT_ENABLED) submitViaEdge(flagged, formType, { flag: 'honeypot' }).catch(() => {});
      else notifyByEmail(flagged, formType, 'honeypot');
      showSuccess(form);
      return;
    }

    // Time-trap — a real visitor takes more than a couple seconds to read
    // and fill the form; a bot submits near-instantly. Same flagged-copy rule.
    if (Date.now() - loadedAt < MIN_SUBMIT_MS) {
      const flagged = collectPayload(form);
      if (PUBLIC_SUBMIT_ENABLED) submitViaEdge(flagged, formType, { flag: 'time-trap' }).catch(() => {});
      else notifyByEmail(flagged, formType, 'time-trap');
      showSuccess(form);
      return;
    }

    if (!validateForm(form)) return;

    // Phase 6: require a solved Turnstile token before we disable the button.
    let edgeToken = '';
    if (PUBLIC_SUBMIT_ENABLED) {
      edgeToken = turnstileToken(form);
      if (!edgeToken) {
        showFormError(form, 'Please complete the verification below, then submit again.');
        return;
      }
    }

    clearFormError(form);
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Sending…';
    }

    const payload = collectPayload(form);

    try {
      if (PUBLIC_SUBMIT_ENABLED) {
        // Turnstile-gated Edge Function does the insert + email server-side.
        await submitViaEdge(payload, formType, { token: edgeToken });
      } else if (supabase) {
        // DB row is the source of truth; the email copy is fire-and-forget.
        const { error } = await supabase.from(table).insert(payload);
        if (error) throw error;
        notifyByEmail(payload, formType);
      } else {
        // Email is the ONLY capture path (Supabase unconfigured or the
        // vendored bundle failed) — await it and refuse to fake success.
        const delivered = await notifyByEmail(payload, formType);
        if (!delivered) throw new Error('notification email failed');
      }
      showSuccess(form);
    } catch (err) {
      console.error(err);
      showFormError(form, 'Something went wrong sending this — please try again, or email deals@meridianhempco.com directly.');
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = submitLabel;
      }
    }
  });
}

populateStateSelects();
if (PUBLIC_SUBMIT_ENABLED) loadTurnstileScript();
document.querySelectorAll('form[data-form]').forEach((form) => {
  initForm(form);
  if (PUBLIC_SUBMIT_ENABLED) mountTurnstile(form);
});
