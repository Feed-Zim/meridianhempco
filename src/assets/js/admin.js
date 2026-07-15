// Desk admin (internal CRM). ES module, vanilla JS, no framework.
// Auth-gates on a Supabase session (RLS + meridian.is_admin() do the real
// enforcement server-side; this UI just reflects that state). One tab is
// active at a time; each tab has its own render function that fetches and
// draws its view, and re-fetches after every write so the UI always shows
// server state, not optimistic local state.
import { supabase, isConfigured } from './supabase-client.js';

// ---------------------------------------------------------------------
// small helper layer
// ---------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDate(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
    + ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function fmtDateOnly(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtMoney(n) {
  if (n === null || n === undefined || n === '') return '—';
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtNum(n) {
  if (n === null || n === undefined || n === '') return '—';
  return Number(n).toLocaleString('en-US');
}

function badge(text, kind) {
  return `<span class="badge-${kind}">${escapeHtml(text)}</span>`;
}

const STATUS_KIND = {
  pending: 'warn', unverified: 'warn', new: 'warn', reviewing: 'warn', draft: 'warn',
  offered: 'warn', negotiating: 'warn', on_hold: 'warn', gray: 'warn',
  promoted: 'ok', verified: 'ok', active: 'ok', match: 'ok', closed_won: 'ok',
  listed: 'ok', qr_checked: 'ok', retested: 'ok', allowed: 'ok', sold: 'ok',
  rejected: 'bad', failed: 'bad', suspended: 'bad', mismatch: 'bad',
  closed_lost: 'bad', blocked: 'bad', expired: 'bad',
};
function statusBadge(status) {
  if (!status) return '—';
  return badge(status, STATUS_KIND[status] || 'warn');
}

function legalityBadge(row) {
  const kind = { allowed: 'ok', gray: 'warn', blocked: 'bad' }[row.status] || 'warn';
  const title = row.notes ? ` title="${escapeHtml(row.notes)}"` : '';
  return `<span class="badge-${kind}"${title}>${escapeHtml(row.status)}</span>`;
}

// Surfaces every Supabase error (or a plain success note) in a status line.
let flashTimer = null;
function flash(msg, isError = false) {
  const el = $('#admin-flash');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('is-error', !!isError);
  el.hidden = false;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

// Signed-in admin's auth uid — set/cleared by toggleSession(). Stamped onto
// every activity insert and every reviewed_by column write.
let currentUserId = null;

// Every write path that needs a timeline entry goes through this — returns
// {data, error} like any other supabase-js call so callers can flash on failure.
// created_by is stamped here so every call site gets audit attribution for free.
function logActivity(entry) {
  return supabase.from('activity').insert({ ...entry, created_by: currentUserId });
}

// Double-submit guard: disables btn for the duration of fn(), re-enabling it
// even if fn() throws or returns early. Wrap every mutating button handler.
async function withBusy(btn, fn) {
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    return await fn();
  } finally {
    btn.disabled = false;
  }
}

// URL scheme allowlist — only http(s) links are ever rendered as <a href>.
// Blocks javascript:/data: URIs from admin-authenticated-session renders of
// publicly-submitted fields (coa_link, lims_verify_url).
function safeHttpUrl(u) {
  return /^https?:\/\//i.test(u || '') ? u : null;
}

// Renders a publicly-submitted URL as a real link when it passes the scheme
// allowlist, otherwise as escaped plain text (never an <a href>).
function urlOrText(u, label) {
  if (!u) return '';
  const safe = safeHttpUrl(u);
  return safe
    ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener">${escapeHtml(label || u)}</a>`
    : escapeHtml(u);
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

// CSV cell: stringifies objects (nested joins like deal.lot), quotes values
// containing commas/quotes/newlines, and neutralizes formula-injection
// prefixes (=, +, -, @) for anyone opening the export in a spreadsheet app.
function csvCell(value) {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  if (/[",\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

// Generic CSV export used by every tab's "Export CSV" toolbar button — headers
// are inferred from the first row's keys.
function exportCsv(filename, rows) {
  if (!rows || !rows.length) { flash('Nothing to export.', true); return; }
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  rows.forEach((row) => lines.push(headers.map((h) => csvCell(row[h])).join(',')));
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------
// bootstrap / auth
// ---------------------------------------------------------------------
const unconfiguredEl = $('#admin-unconfigured');
const loginEl = $('#admin-login');
const shellEl = $('#admin-shell');

if (!isConfigured()) {
  unconfiguredEl.hidden = false;
} else {
  init();
}

async function init() {
  wireLogin();
  wireShell();

  const { data, error } = await supabase.auth.getSession();
  if (error) flash(error.message, true);
  toggleSession(data ? data.session : null);

  supabase.auth.onAuthStateChange((_event, session) => {
    toggleSession(session);
  });
}

let sessionActive = false;
function toggleSession(session) {
  if (session) {
    loginEl.hidden = true;
    shellEl.hidden = false;
    $('#admin-user-email').textContent = session.user.email || '';
    currentUserId = session.user.id;
    if (!sessionActive) activateTab('intake');
    sessionActive = true;
  } else {
    loginEl.hidden = false;
    shellEl.hidden = true;
    sessionActive = false;
    currentUserId = null;
  }
}

function wireLogin() {
  const form = $('#admin-login-form');
  const errEl = $('#admin-login-error');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errEl.hidden = true;
    const email = $('#admin-email').value.trim();
    const password = $('#admin-password').value;
    const btn = form.querySelector('[type="submit"]');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    btn.disabled = false;
    btn.textContent = 'Sign in';
    if (error) {
      errEl.textContent = error.message;
      errEl.hidden = false;
      return;
    }
    form.reset();
  });
}

function wireShell() {
  $('#admin-signout').addEventListener('click', async () => {
    const { error } = await supabase.auth.signOut();
    if (error) flash(error.message, true);
  });
  $$('.admin-tab').forEach((btn) => {
    btn.addEventListener('click', () => activateTab(btn.dataset.tab));
  });
}

// ---------------------------------------------------------------------
// tab dispatch
// ---------------------------------------------------------------------
const RENDERERS = {
  intake: renderIntake,
  requests: renderRequests,
  farms: renderFarms,
  lots: renderLots,
  buyers: renderBuyers,
  deals: renderDeals,
  activity: renderActivity,
};

async function activateTab(tab) {
  $$('.admin-tab').forEach((btn) => btn.classList.toggle('is-active', btn.dataset.tab === tab));
  const view = $('#admin-view');
  view.innerHTML = '<p class="admin-loading">Loading…</p>';
  try {
    await RENDERERS[tab](view);
  } catch (err) {
    console.error(err);
    view.innerHTML = '<p class="admin-empty">Failed to load — see console.</p>';
    flash((err && err.message) || 'Load failed', true);
  }
}

// ---------------------------------------------------------------------
// 1. Intake
// ---------------------------------------------------------------------
async function renderIntake(view) {
  const { data: pending, error: e1 } = await supabase
    .from('farm_intake').select('*').eq('status', 'pending')
    .order('created_at', { ascending: false }).limit(200);
  if (e1) throw e1;

  const { data: processed, error: e2 } = await supabase
    .from('farm_intake').select('*').in('status', ['promoted', 'rejected'])
    .order('created_at', { ascending: false }).limit(200);
  if (e2) throw e2;

  view.innerHTML = `
    <div class="admin-view-head">
      <h2>Intake</h2>
      <p class="admin-view-sub">${pending.length} pending</p>
      <button class="btn-quiet" type="button" id="admin-export-intake">Export CSV</button>
    </div>
    <div class="admin-list">
      ${pending.length ? pending.map(intakeRow).join('') : '<p class="admin-empty">No pending intake.</p>'}
    </div>
    <details class="admin-collapse">
      <summary>Processed (${processed.length})</summary>
      <div class="admin-list">
        ${processed.length ? processed.map(intakeRow).join('') : '<p class="admin-empty">None yet.</p>'}
      </div>
    </details>
  `;

  wireRowToggles(view);
  $$('[data-approve]', view).forEach((btn) => btn.addEventListener('click', () => withBusy(btn, () => approveIntake(btn.dataset.approve, view))));
  $$('[data-reject]', view).forEach((btn) => btn.addEventListener('click', () => withBusy(btn, () => rejectIntake(btn.dataset.reject, view))));
  $('#admin-export-intake', view).addEventListener('click', () => exportCsv(`intake-${todayStamp()}.csv`, [...pending, ...processed]));
}

function wireRowToggles(view) {
  $$('.admin-row-toggle', view).forEach((btn) => {
    btn.addEventListener('click', () => btn.closest('.admin-row').classList.toggle('is-open'));
  });
}

function intakeRow(row) {
  const materials = Array.isArray(row.material_types) ? row.material_types.join(', ') : '';
  return `
    <div class="admin-row" data-id="${row.id}">
      <button class="admin-row-toggle" type="button">
        <span class="admin-row-title">${escapeHtml(row.legal_name)}${row.dba ? ' · ' + escapeHtml(row.dba) : ''}</span>
        <span class="admin-row-meta">${escapeHtml(row.state)} · ${fmtDate(row.created_at)} ${statusBadge(row.status)}</span>
      </button>
      <div class="admin-row-body">
        <dl class="admin-dl">
          <div><dt>Contact</dt><dd>${escapeHtml(row.contact_name)}</dd></div>
          <div><dt>Email</dt><dd>${escapeHtml(row.contact_email)}</dd></div>
          <div><dt>Phone</dt><dd>${escapeHtml(row.contact_phone) || '—'}</dd></div>
          <div><dt>License #</dt><dd>${escapeHtml(row.license_number) || '—'}</dd></div>
          <div><dt>License type</dt><dd>${escapeHtml(row.license_type) || '—'}</dd></div>
          <div><dt>Annual capacity (lb)</dt><dd>${fmtNum(row.annual_capacity_lb)}</dd></div>
          <div><dt>Material types</dt><dd>${escapeHtml(materials) || '—'}</dd></div>
          <div><dt>COA link</dt><dd>${row.coa_link ? urlOrText(row.coa_link) : '—'}</dd></div>
          <div><dt>Source</dt><dd>${escapeHtml(row.source) || '—'}</dd></div>
          <div><dt>Reviewed</dt><dd>${fmtDate(row.reviewed_at)}</dd></div>
          <div class="admin-dl-span"><dt>Message</dt><dd>${escapeHtml(row.message) || '—'}</dd></div>
        </dl>
        ${row.status === 'pending' ? `
        <div class="admin-row-actions">
          <button class="btn" type="button" data-approve="${row.id}">Approve</button>
          <button class="btn-quiet" type="button" data-reject="${row.id}">Reject</button>
        </div>` : ''}
      </div>
    </div>
  `;
}

async function approveIntake(id, view) {
  const { data: intake, error: e0 } = await supabase.from('farm_intake').select('*').eq('id', id).single();
  if (e0) { flash(e0.message, true); return; }

  const licenseType = intake.license_type === 'unknown' ? null : intake.license_type;
  const { data: farm, error: e1 } = await supabase.from('farm').insert({
    legal_name: intake.legal_name,
    dba: intake.dba,
    state: intake.state,
    contacts: [{ name: intake.contact_name, email: intake.contact_email, phone: intake.contact_phone }],
    license_number: intake.license_number,
    license_type: licenseType,
    annual_capacity_lb: intake.annual_capacity_lb,
    notes: intake.message,
    status: 'pending',
    intake_id: intake.id,
  }).select().single();
  if (e1) { flash(e1.message, true); return; }

  const { error: e2 } = await supabase.from('farm_intake')
    .update({ status: 'promoted', reviewed_at: new Date().toISOString(), reviewed_by: currentUserId }).eq('id', id);
  if (e2) { flash(e2.message, true); return; }

  const { error: e3 } = await logActivity({ entity_type: 'farm', entity_id: farm.id, kind: 'status_change', body: 'Promoted from intake' });
  if (e3) flash(e3.message, true);

  flash('Farm created from intake.');
  renderIntake(view);
}

async function rejectIntake(id, view) {
  if (!confirm('Reject this intake submission?')) return;
  const { error } = await supabase.from('farm_intake')
    .update({ status: 'rejected', reviewed_at: new Date().toISOString(), reviewed_by: currentUserId }).eq('id', id);
  if (error) { flash(error.message, true); return; }
  flash('Intake rejected.');
  renderIntake(view);
}

// ---------------------------------------------------------------------
// 2. Requests
// ---------------------------------------------------------------------
const REQUEST_STATUSES = ['new', 'reviewing', 'offered', 'negotiating', 'closed_won', 'closed_lost'];
let requestsFilter = 'new';

async function renderRequests(view) {
  let query = supabase.from('buyer_request').select('*').order('created_at', { ascending: false }).limit(200);
  if (requestsFilter !== 'all') query = query.eq('status', requestsFilter);
  const { data: requests, error } = await query;
  if (error) throw error;

  const { data: legality, error: lErr } = await supabase.from('state_legality').select('*');
  if (lErr) throw lErr;
  const legalityMap = new Map((legality || []).map((r) => [r.state, r]));

  view.innerHTML = `
    <div class="admin-view-head">
      <h2>Requests</h2>
      <div class="admin-filter-bar">
        <button class="admin-filter-btn ${requestsFilter === 'all' ? 'is-active' : ''}" data-filter="all" type="button">All</button>
        ${REQUEST_STATUSES.map((s) => `<button class="admin-filter-btn ${requestsFilter === s ? 'is-active' : ''}" data-filter="${s}" type="button">${s}</button>`).join('')}
      </div>
      <button class="btn-quiet" type="button" id="admin-export-requests">Export CSV</button>
    </div>
    <div class="admin-list">
      ${requests.length ? requests.map((r) => requestRow(r, legalityMap)).join('') : '<p class="admin-empty">No requests in this status.</p>'}
    </div>
  `;

  $$('[data-filter]', view).forEach((btn) => btn.addEventListener('click', () => { requestsFilter = btn.dataset.filter; renderRequests(view); }));
  $('#admin-export-requests', view).addEventListener('click', () => exportCsv(`requests-${todayStamp()}.csv`, requests));
  $$('.admin-row-toggle', view).forEach((btn) => {
    btn.addEventListener('click', async () => {
      const row = btn.closest('.admin-row');
      const wasOpen = row.classList.contains('is-open');
      row.classList.toggle('is-open');
      if (!wasOpen) {
        const matchesEl = row.querySelector('.admin-matches');
        if (matchesEl && !matchesEl.dataset.loaded) {
          matchesEl.dataset.loaded = '1';
          await loadMatches(matchesEl, row.dataset.id, view);
        }
      }
    });
  });
  $$('[data-request-status]', view).forEach((sel) => {
    sel.addEventListener('change', () => updateRequestStatus(sel.dataset.requestStatus, sel.value, view, sel.dataset.reviewedAt || null));
  });
  $$('[data-create-buyer]', view).forEach((btn) => {
    btn.addEventListener('click', () => withBusy(btn, () => createBuyerFromRequest(btn.dataset.createBuyer, view)));
  });
}

function requestRow(r, legalityMap) {
  const legality = legalityMap.get(r.destination_state);
  return `
    <div class="admin-row" data-id="${r.id}">
      <button class="admin-row-toggle" type="button">
        <span class="admin-row-title">${escapeHtml(r.company) || escapeHtml(r.contact_name)}</span>
        <span class="admin-row-meta">${escapeHtml(r.material_type) || '—'} · ${fmtNum(r.volume_lb)} lb · ${fmtDate(r.created_at)} ${statusBadge(r.status)}</span>
      </button>
      <div class="admin-row-body">
        <dl class="admin-dl">
          <div><dt>Contact</dt><dd>${escapeHtml(r.contact_name)}</dd></div>
          <div><dt>Email</dt><dd>${escapeHtml(r.contact_email)}</dd></div>
          <div><dt>Phone</dt><dd>${escapeHtml(r.contact_phone) || '—'}</dd></div>
          <div><dt>State</dt><dd>${escapeHtml(r.state) || '—'}</dd></div>
          <div><dt>License</dt><dd>${escapeHtml(r.license) || '—'}</dd></div>
          <div><dt>Material</dt><dd>${escapeHtml(r.material_type) || '—'}</dd></div>
          <div><dt>Volume (lb)</dt><dd>${fmtNum(r.volume_lb)}</dd></div>
          <div><dt>Price target ($/lb)</dt><dd>${fmtMoney(r.price_target_per_lb)}</dd></div>
          <div><dt>Destination state</dt><dd>${escapeHtml(r.destination_state) || '—'} ${legality ? legalityBadge(legality) : ''}</dd></div>
          <div><dt>Timeline</dt><dd>${escapeHtml(r.timeline) || '—'}</dd></div>
          <div><dt>Buyer linked</dt><dd>${r.buyer_id ? 'Yes' : 'No'}</dd></div>
          <div class="admin-dl-span"><dt>Specs</dt><dd>${escapeHtml(r.specs) || '—'}</dd></div>
          <div class="admin-dl-span"><dt>Message</dt><dd>${escapeHtml(r.message) || '—'}</dd></div>
        </dl>

        <div class="admin-row-actions">
          <label class="admin-inline-field">
            <span>Status</span>
            <select data-request-status="${r.id}" data-reviewed-at="${r.reviewed_at || ''}">
              ${REQUEST_STATUSES.map((s) => `<option value="${s}" ${s === r.status ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </label>
          ${!r.buyer_id ? `<button class="btn-quiet" type="button" data-create-buyer="${r.id}">Create buyer from request</button>` : ''}
        </div>

        <div class="admin-matches" data-material="${escapeHtml(r.material_type || '')}" data-buyer-id="${r.buyer_id || ''}">
          <p class="admin-loading">Matches load when expanded.</p>
        </div>
      </div>
    </div>
  `;
}

async function loadMatches(el, requestId, view) {
  const material = el.dataset.material;
  const buyerId = el.dataset.buyerId || '';
  const { data: lots, error } = await supabase.from('presentable_lot').select('*').order('coa_date', { ascending: false }).limit(200);
  if (error) { el.innerHTML = `<p class="admin-empty">Could not load lots: ${escapeHtml(error.message)}</p>`; return; }

  // The request has no linked buyer yet — the deal can't be created without
  // one, so load the buyer list and force a selection per lot below.
  let buyers = [];
  if (!buyerId) {
    const { data: buyerRows, error: bErr } = await supabase.from('buyer').select('id, company').order('company');
    if (bErr) { el.innerHTML = `<p class="admin-empty">Could not load buyers: ${escapeHtml(bErr.message)}</p>`; return; }
    buyers = buyerRows || [];
  }

  let matched = material ? lots.filter((l) => l.material_type === material) : lots;
  let note = '';
  if (material && matched.length === 0 && lots.length > 0) {
    matched = lots;
    note = '<p class="admin-note">No verified lots match this material type — showing all verified lots.</p>';
  }

  el.innerHTML = `
    <h4>Matching lots</h4>
    ${note}
    ${matched.length ? matched.map((l) => matchRow(l, buyerId, buyers)).join('') : '<p class="admin-empty">No verified lots available.</p>'}
  `;

  $$('[data-create-deal]', el).forEach((btn) => {
    btn.addEventListener('click', () => {
      const lotId = btn.dataset.createDeal;
      let selectedBuyerId = buyerId;
      if (!selectedBuyerId) {
        const sel = el.querySelector(`[data-deal-buyer="${lotId}"]`);
        selectedBuyerId = sel ? sel.value : '';
        if (!selectedBuyerId) { flash('Select a buyer before creating a deal.', true); return; }
      }
      withBusy(btn, () => createDealFromMatch(lotId, requestId, selectedBuyerId, view));
    });
  });
}

function matchRow(l, buyerId, buyers) {
  const buyerField = buyerId ? '' : `
      <label class="admin-inline-field">
        <span>Buyer</span>
        <select data-deal-buyer="${l.lot_id}" required>
          <option value="">Select…</option>
          ${(buyers || []).map((b) => `<option value="${b.id}">${escapeHtml(b.company)}</option>`).join('')}
        </select>
      </label>`;
  return `
    <div class="admin-match-row">
      <div class="admin-match-info">
        <span class="admin-match-title">${escapeHtml(l.strain) || escapeHtml(l.material_type)} · ${escapeHtml(l.grade) || '—'}</span>
        <span class="admin-match-meta mono">${fmtNum(l.quantity_lb)} lb · ${fmtMoney(l.asking_price_per_lb)}/lb · total THC ${l.total_thc_pct ?? '—'}% · ${escapeHtml(l.origin_state) || '—'}</span>
      </div>
      ${buyerField}
      <button class="btn-quiet" type="button" data-create-deal="${l.lot_id}">Create deal</button>
    </div>
  `;
}

async function createDealFromMatch(lotId, requestId, buyerId, view) {
  const { data: deal, error: e1 } = await supabase.from('deal')
    .insert({ lot_id: lotId, buyer_request_id: requestId, buyer_id: buyerId || null, status: 'draft' }).select().single();
  if (e1) { flash(e1.message, true); return; }

  const { data: req, error: e2 } = await supabase.from('buyer_request').select('status').eq('id', requestId).single();
  if (e2) { flash(e2.message, true); }
  else if (req.status === 'new') {
    const { error: e3 } = await supabase.from('buyer_request').update({ status: 'reviewing' }).eq('id', requestId);
    if (e3) flash(e3.message, true);
  }

  const { error: e4 } = await logActivity({ entity_type: 'deal', entity_id: deal.id, kind: 'note', body: 'Deal drafted' });
  if (e4) flash(e4.message, true);

  flash('Deal created.');
  renderRequests(view);
}

async function updateRequestStatus(requestId, newStatus, view, prevReviewedAt) {
  if (newStatus === 'closed_lost' && !confirm('Mark this request closed (lost)?')) { renderRequests(view); return; }
  const patch = { status: newStatus, reviewed_by: currentUserId };
  if (!prevReviewedAt) patch.reviewed_at = new Date().toISOString();
  const { error } = await supabase.from('buyer_request').update(patch).eq('id', requestId);
  if (error) { flash(error.message, true); return; }
  const { error: e2 } = await logActivity({ entity_type: 'buyer_request', entity_id: requestId, kind: 'status_change', body: `Status changed to ${newStatus}` });
  if (e2) flash(e2.message, true);
  flash('Request updated.');
  renderRequests(view);
}

async function createBuyerFromRequest(requestId, view) {
  const { data: req, error: e0 } = await supabase.from('buyer_request').select('*').eq('id', requestId).single();
  if (e0) { flash(e0.message, true); return; }

  const { data: buyer, error: e1 } = await supabase.from('buyer').insert({
    company: req.company || req.contact_name,
    contact_name: req.contact_name,
    email: req.contact_email,
    phone: req.contact_phone,
    state: req.state,
    license: req.license,
  }).select().single();
  if (e1) { flash(e1.message, true); return; }

  const { error: e2 } = await supabase.from('buyer_request').update({ buyer_id: buyer.id }).eq('id', requestId);
  if (e2) { flash(e2.message, true); return; }

  flash('Buyer created and linked.');
  renderRequests(view);
}

// ---------------------------------------------------------------------
// 3. Farms
// ---------------------------------------------------------------------
const FARM_STATUSES = ['pending', 'verified', 'active', 'suspended'];
let pendingLotFarmId = null;

async function renderFarms(view) {
  const { data: farms, error } = await supabase.from('farm').select('*').order('created_at', { ascending: false }).limit(200);
  if (error) throw error;

  view.innerHTML = `
    <div class="admin-view-head">
      <h2>Farms</h2>
      <button class="btn-quiet" type="button" id="admin-export-farms">Export CSV</button>
    </div>
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead><tr>
          <th>Legal name</th><th>DBA</th><th>State</th><th>License verify</th><th>NCND</th><th>Status</th><th>Capacity (lb)</th><th></th>
        </tr></thead>
        <tbody>${farms.length ? farms.map(farmTableRow).join('') : '<tr><td colspan="8" class="admin-empty">No farms yet.</td></tr>'}</tbody>
      </table>
    </div>
    <div id="admin-farm-detail"></div>
  `;

  $$('[data-edit-farm]', view).forEach((btn) => btn.addEventListener('click', () => openFarmDetail(btn.dataset.editFarm, farms, view)));
  $('#admin-export-farms', view).addEventListener('click', () => exportCsv(`farms-${todayStamp()}.csv`, farms));
}

function farmTableRow(f) {
  return `
    <tr>
      <td>${escapeHtml(f.legal_name)}</td>
      <td>${escapeHtml(f.dba) || '—'}</td>
      <td>${escapeHtml(f.state)}</td>
      <td>${statusBadge(f.license_verify_status)}</td>
      <td>${f.ncnd_signed ? 'Yes' : 'No'}</td>
      <td>${statusBadge(f.status)}</td>
      <td class="mono">${fmtNum(f.annual_capacity_lb)}</td>
      <td><button class="btn-quiet" type="button" data-edit-farm="${f.id}">Edit</button></td>
    </tr>
  `;
}

function openFarmDetail(farmId, farms, view) {
  const f = farms.find((x) => x.id === farmId);
  const detail = $('#admin-farm-detail', view);
  detail.innerHTML = `
    <form class="form-card admin-detail-card" data-farm-id="${f.id}" data-prev-status="${f.status}">
      <h3>${escapeHtml(f.legal_name)}</h3>
      <div class="form-grid">
        <div class="field"><label>License #</label><input name="license_number" value="${escapeHtml(f.license_number) || ''}"></div>
        <div class="field"><label>License type</label>
          <select name="license_type">
            <option value="">—</option>
            <option value="usda" ${f.license_type === 'usda' ? 'selected' : ''}>USDA</option>
            <option value="state" ${f.license_type === 'state' ? 'selected' : ''}>State</option>
          </select>
        </div>
        <div class="field"><label>License verify status</label>
          <select name="license_verify_status">
            ${['unverified', 'verified', 'failed'].map((s) => `<option value="${s}" ${s === f.license_verify_status ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>License verify date</label><input type="date" name="license_verify_date" value="${f.license_verify_date || ''}"></div>
        <div class="field"><label>SOS entity match</label>
          <select name="sos_entity_match">
            ${['unverified', 'match', 'mismatch'].map((s) => `<option value="${s}" ${s === f.sos_entity_match ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label class="check-option"><input type="checkbox" name="ncnd_signed" ${f.ncnd_signed ? 'checked' : ''}> NCND signed</label></div>
        <div class="field"><label>NCND signed date</label><input type="date" name="ncnd_signed_date" value="${f.ncnd_signed_date || ''}"></div>
        <div class="field"><label>NCND doc ref</label><input name="ncnd_doc_ref" value="${escapeHtml(f.ncnd_doc_ref) || ''}"></div>
        <div class="field"><label>Annual capacity (lb)</label><input type="number" step="1" name="annual_capacity_lb" value="${f.annual_capacity_lb ?? ''}"></div>
        <div class="field"><label>Status</label>
          <select name="status">
            ${FARM_STATUSES.map((s) => `<option value="${s}" ${s === f.status ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </div>
        <div class="field field-span"><label>Notes</label><textarea name="notes">${escapeHtml(f.notes) || ''}</textarea></div>
      </div>
      <div class="form-actions">
        <button class="btn" type="submit">Save</button>
        <button class="btn-quiet" type="button" data-add-lot="${f.id}">Add lot</button>
        <button class="btn-quiet" type="button" data-close-detail>Close</button>
      </div>
    </form>
  `;

  detail.querySelector('form').addEventListener('submit', (e) => saveFarm(e, view));
  detail.querySelector('[data-add-lot]').addEventListener('click', () => {
    pendingLotFarmId = farmId;
    activateTab('lots');
  });
  detail.querySelector('[data-close-detail]').addEventListener('click', () => { detail.innerHTML = ''; });
}

async function saveFarm(e, view) {
  e.preventDefault();
  const form = e.target;
  const btn = e.submitter || form.querySelector('[type="submit"]');
  const prevStatus = form.dataset.prevStatus;
  await withBusy(btn, async () => {
    const fd = new FormData(form);
    const patch = {
      license_number: fd.get('license_number') || null,
      license_type: fd.get('license_type') || null,
      license_verify_status: fd.get('license_verify_status'),
      license_verify_date: fd.get('license_verify_date') || null,
      sos_entity_match: fd.get('sos_entity_match'),
      ncnd_signed: fd.get('ncnd_signed') === 'on',
      ncnd_signed_date: fd.get('ncnd_signed_date') || null,
      ncnd_doc_ref: fd.get('ncnd_doc_ref') || null,
      annual_capacity_lb: fd.get('annual_capacity_lb') || null,
      status: fd.get('status'),
      notes: fd.get('notes') || null,
    };
    if (patch.status === 'suspended' && prevStatus !== 'suspended' && !confirm('Suspend this farm?')) return;
    const { error } = await supabase.from('farm').update(patch).eq('id', form.dataset.farmId);
    if (error) { flash(error.message, true); return; }
    flash('Farm saved.');
    renderFarms(view);
  });
}

// ---------------------------------------------------------------------
// 4. Lots
// ---------------------------------------------------------------------
const LOT_STATUSES = ['offered', 'listed', 'on_hold', 'sold', 'expired'];
const MATERIAL_TYPES = ['cbd_flower', 'smalls', 'biomass', 'pre_rolls'];
const GRADES = ['a_bud', 'smalls', 'b_grade'];
const GROW_METHODS = ['indoor', 'light_dep', 'outdoor', 'greenhouse'];
const COA_VERIFY_STATUSES = ['unverified', 'qr_checked', 'retested'];
let lotsFilter = 'all';
let pendingOpenLotId = null;

async function renderLots(view) {
  let query = supabase.from('material_lot').select('*, farm:farm_id(legal_name)').order('created_at', { ascending: false }).limit(200);
  if (lotsFilter !== 'all') query = query.eq('status', lotsFilter);
  const { data: lots, error } = await query;
  if (error) throw error;

  const { data: farms, error: fErr } = await supabase.from('farm').select('id, legal_name').order('legal_name');
  if (fErr) throw fErr;

  view.innerHTML = `
    <div class="admin-view-head">
      <h2>Lots</h2>
      <div class="admin-filter-bar">
        <button class="admin-filter-btn ${lotsFilter === 'all' ? 'is-active' : ''}" data-filter="all" type="button">All</button>
        ${LOT_STATUSES.map((s) => `<button class="admin-filter-btn ${lotsFilter === s ? 'is-active' : ''}" data-filter="${s}" type="button">${s}</button>`).join('')}
      </div>
      <button class="btn" type="button" id="admin-new-lot">New lot</button>
      <button class="btn-quiet" type="button" id="admin-lot-menu">Generate lot menu</button>
      <button class="btn-quiet" type="button" id="admin-lot-menu-csv">Menu CSV (internal)</button>
      <button class="btn-quiet" type="button" id="admin-export-lots">Export CSV</button>
    </div>
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead><tr><th>Farm</th><th>Material</th><th>Strain</th><th>Grade</th><th>Qty (lb)</th><th>$/lb</th><th>Status</th><th></th></tr></thead>
        <tbody>${lots.length ? lots.map(lotTableRow).join('') : '<tr><td colspan="8" class="admin-empty">No lots.</td></tr>'}</tbody>
      </table>
    </div>
    <div id="admin-lot-detail"></div>
  `;

  $$('[data-filter]', view).forEach((btn) => btn.addEventListener('click', () => { lotsFilter = btn.dataset.filter; renderLots(view); }));
  $$('[data-edit-lot]', view).forEach((btn) => btn.addEventListener('click', () => openLotDetail(btn.dataset.editLot, lots, farms, view)));
  $('#admin-new-lot', view).addEventListener('click', () => openLotDetail(null, lots, farms, view));
  $('#admin-lot-menu', view).addEventListener('click', () => generateLotMenu());
  $('#admin-lot-menu-csv', view).addEventListener('click', () => exportLotMenuCsvInternal());
  $('#admin-export-lots', view).addEventListener('click', () => exportCsv(`lots-${todayStamp()}.csv`, lots));

  if (pendingLotFarmId) {
    const farmId = pendingLotFarmId;
    pendingLotFarmId = null;
    openLotDetail(null, lots, farms, view, farmId);
  } else if (pendingOpenLotId) {
    const openId = pendingOpenLotId;
    pendingOpenLotId = null;
    openLotDetail(openId, lots, farms, view);
  }
}

function lotTableRow(l) {
  return `
    <tr>
      <td>${escapeHtml(l.farm && l.farm.legal_name) || '—'}</td>
      <td>${escapeHtml(l.material_type)}</td>
      <td>${escapeHtml(l.strain) || '—'}</td>
      <td>${escapeHtml(l.grade) || '—'}</td>
      <td class="mono">${fmtNum(l.quantity_lb)}</td>
      <td class="mono">${fmtMoney(l.asking_price_per_lb)}</td>
      <td>${statusBadge(l.status)}</td>
      <td><button class="btn-quiet" type="button" data-edit-lot="${l.id}">Edit</button></td>
    </tr>
  `;
}

function openLotDetail(lotId, lots, farms, view, prefillFarmId) {
  const l = lotId ? lots.find((x) => x.id === lotId) : null;
  const detail = $('#admin-lot-detail', view);
  const farmOptions = farms.map((f) => {
    const selected = l ? l.farm_id === f.id : prefillFarmId === f.id;
    return `<option value="${f.id}" ${selected ? 'selected' : ''}>${escapeHtml(f.legal_name)}</option>`;
  }).join('');

  detail.innerHTML = `
    <form class="form-card admin-detail-card" data-lot-id="${l ? l.id : ''}" data-retest-flagged-at="${l && l.retest_flagged_at ? '1' : ''}">
      <h3>${l ? 'Edit lot' : 'New lot'}</h3>
      ${l && l.retest_flagged_at ? `<p class="admin-note">Retest flagged ${fmtDate(l.retest_flagged_at)}${l.retest_required ? '' : ' — cleared'}</p>` : ''}
      <div class="form-grid">
        <div class="field"><label>Farm</label><select name="farm_id" required><option value="">Select…</option>${farmOptions}</select></div>
        <div class="field"><label>Material type</label>
          <select name="material_type" required>
            ${MATERIAL_TYPES.map((m) => `<option value="${m}" ${l && l.material_type === m ? 'selected' : ''}>${m}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Strain</label><input name="strain" value="${l ? escapeHtml(l.strain) || '' : ''}"></div>
        <div class="field"><label>Grade</label>
          <select name="grade">
            <option value="">—</option>
            ${GRADES.map((g) => `<option value="${g}" ${l && l.grade === g ? 'selected' : ''}>${g}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Grow method</label>
          <select name="grow_method">
            <option value="">—</option>
            ${GROW_METHODS.map((g) => `<option value="${g}" ${l && l.grow_method === g ? 'selected' : ''}>${g}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Harvest date</label><input type="date" name="harvest_date" value="${l && l.harvest_date ? l.harvest_date : ''}"></div>
        <div class="field"><label>Quantity (lb)</label><input type="number" step="0.01" name="quantity_lb" value="${l && l.quantity_lb != null ? l.quantity_lb : ''}"></div>
        <div class="field"><label>Asking price ($/lb)</label><input type="number" step="0.01" name="asking_price_per_lb" value="${l && l.asking_price_per_lb != null ? l.asking_price_per_lb : ''}"></div>
        <div class="field"><label>Origin state</label><input name="origin_state" maxlength="2" value="${l ? escapeHtml(l.origin_state) || '' : ''}"></div>
        <div class="field"><label>Status</label>
          <select name="status">
            ${LOT_STATUSES.map((s) => `<option value="${s}" ${(l ? l.status === s : s === 'offered') ? 'selected' : ''}>${s}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label class="check-option"><input type="checkbox" name="thca_sunset_flag" ${l && l.thca_sunset_flag ? 'checked' : ''}> <span class="mono">thca_sunset_flag</span></label></div>
        <div class="field"><label class="check-option"><input type="checkbox" name="retest_required" ${l && l.retest_required ? 'checked' : ''}> Retest required</label></div>
        <div class="field"><label>Retained sample location</label><input name="retained_sample_location" value="${l ? escapeHtml(l.retained_sample_location) || '' : ''}"></div>
        <div class="field field-span"><label>Notes</label><textarea name="notes">${l ? escapeHtml(l.notes) || '' : ''}</textarea></div>
      </div>
      <div class="form-actions">
        <button class="btn" type="submit">Save lot</button>
        ${l && l.retest_required ? `<button class="btn-quiet" type="button" data-clear-retest="${l.id}">Clear retest</button>` : ''}
        <button class="btn-quiet" type="button" data-close-detail>Close</button>
      </div>
    </form>
    <div id="admin-coa-section"></div>
  `;

  detail.querySelector('form').addEventListener('submit', (e) => saveLot(e, view));
  detail.querySelector('[data-close-detail]').addEventListener('click', () => { detail.innerHTML = ''; });
  const clearRetestBtn = detail.querySelector('[data-clear-retest]');
  if (clearRetestBtn) clearRetestBtn.addEventListener('click', () => withBusy(clearRetestBtn, () => clearRetest(clearRetestBtn.dataset.clearRetest, view)));

  if (l) renderCoaSection($('#admin-coa-section', detail), l, view);
}

async function saveLot(e, view) {
  e.preventDefault();
  const form = e.target;
  const btn = e.submitter || form.querySelector('[type="submit"]');
  const lotId = form.dataset.lotId;
  const alreadyFlagged = form.dataset.retestFlaggedAt === '1';
  await withBusy(btn, async () => {
    const fd = new FormData(form);
    const patch = {
      farm_id: fd.get('farm_id'),
      material_type: fd.get('material_type'),
      strain: fd.get('strain') || null,
      grade: fd.get('grade') || null,
      grow_method: fd.get('grow_method') || null,
      harvest_date: fd.get('harvest_date') || null,
      quantity_lb: fd.get('quantity_lb') || null,
      asking_price_per_lb: fd.get('asking_price_per_lb') || null,
      origin_state: fd.get('origin_state') || null,
      status: fd.get('status'),
      thca_sunset_flag: fd.get('thca_sunset_flag') === 'on',
      retest_required: fd.get('retest_required') === 'on',
      retained_sample_location: fd.get('retained_sample_location') || null,
      notes: fd.get('notes') || null,
    };

    // Retest-flag lifecycle (see 0001_schema.sql material_lot.retest_flagged_at):
    // flag once, on whichever trigger fires first, and never re-flag
    // automatically once retest_flagged_at is non-null.
    let retestMsg = null;
    if (!alreadyFlagged) {
      const value = (Number(patch.quantity_lb) || 0) * (Number(patch.asking_price_per_lb) || 0);
      let flagReason = value >= 25000 ? 'lot value ≥ $25k' : null;
      if (!flagReason && !lotId && patch.farm_id) {
        const { count, error: countErr } = await supabase
          .from('material_lot')
          .select('id', { count: 'exact', head: true })
          .eq('farm_id', patch.farm_id);
        if (countErr) { flash(countErr.message, true); return; }
        if (count === 0) flagReason = 'first-time supplier';
      }
      if (flagReason) {
        patch.retest_required = true;
        patch.retest_flagged_at = new Date().toISOString();
        retestMsg = `Retest flagged: ${flagReason}`;
      }
    }

    const query = lotId
      ? supabase.from('material_lot').update(patch).eq('id', lotId).select().single()
      : supabase.from('material_lot').insert(patch).select().single();
    const { data: savedLot, error } = await query;
    if (error) { flash(error.message, true); return; }

    // Re-open the just-created lot's detail (rather than just closing the
    // panel) so a COA can be attached right away — COAs need an existing lot id.
    if (!lotId && savedLot) pendingOpenLotId = savedLot.id;

    flash(retestMsg || 'Lot saved.');
    renderLots(view);
  });
}

// "Clear retest" — turns off retest_required but keeps retest_flagged_at as
// history, so the flag lifecycle (flag once, never silently re-raise) holds.
async function clearRetest(lotId, view) {
  const { error } = await supabase.from('material_lot').update({ retest_required: false }).eq('id', lotId);
  if (error) { flash(error.message, true); return; }
  const { error: actErr } = await logActivity({ entity_type: 'lot', entity_id: lotId, kind: 'status_change', body: 'retest cleared' });
  if (actErr) flash(actErr.message, true);
  flash('Retest cleared.');
  renderLots(view);
}

async function renderCoaSection(container, lot, view) {
  const { data: coas, error } = await supabase.from('coa').select('*').eq('lot_id', lot.id).order('created_at', { ascending: false }).limit(200);
  if (error) { container.innerHTML = `<p class="admin-empty">Could not load COAs: ${escapeHtml(error.message)}</p>`; return; }

  container.innerHTML = `
    <h3>COAs</h3>
    <div class="admin-list">${coas.length ? coas.map(coaRow).join('') : '<p class="admin-empty">No COAs on file.</p>'}</div>
    <h4>New COA</h4>
    ${coaFormHtml()}
  `;

  $$('[data-coa-view]', container).forEach((btn) => btn.addEventListener('click', () => viewCoaFile(btn.dataset.coaView)));
  $$('[data-coa-status]', container).forEach((sel) => sel.addEventListener('change', () => updateCoaVerifyStatus(sel.dataset.coaStatus, sel.value, container, lot, view)));
  $('#admin-new-coa-form', container).addEventListener('submit', (e) => saveNewCoa(e, lot, container, view));
}

function coaRow(c) {
  // A COA can be saved with delta9_pct/thca_pct null via direct DB edits or
  // legacy rows — total_thc_pct/passes are generated columns that go NULL in
  // that case, which must not silently render as "fails".
  const thcBadge = (c.total_thc_pct === null || c.total_thc_pct === undefined || c.passes === null || c.passes === undefined)
    ? badge('incomplete', 'neutral')
    : (c.passes ? badge('passes', 'ok') : badge('fails', 'bad'));
  return `
    <div class="admin-coa-row">
      <div class="admin-coa-main">
        <span>${escapeHtml(c.lab_name)} · ${fmtDateOnly(c.coa_date)}</span>
        <span class="mono">D9 ${c.delta9_pct ?? '—'}% · thca_pct ${c.thca_pct ?? '—'}% · CBD ${c.cbd_pct ?? '—'}% · total THC ${c.total_thc_pct ?? '—'}%</span>
        ${thcBadge}
      </div>
      <div class="admin-coa-actions">
        <select data-coa-status="${c.id}">
          ${COA_VERIFY_STATUSES.map((s) => `<option value="${s}" ${s === c.verify_status ? 'selected' : ''}>${s}</option>`).join('')}
        </select>
        ${c.lims_verify_url ? urlOrText(c.lims_verify_url, 'LIMS') : ''}
        ${c.storage_path ? `<button class="btn-quiet" type="button" data-coa-view="${escapeHtml(c.storage_path)}">View file</button>` : ''}
      </div>
      ${c.red_flags ? `<p class="admin-note">Flags: ${escapeHtml(c.red_flags)}</p>` : ''}
    </div>
  `;
}

function coaFormHtml() {
  return `
    <form id="admin-new-coa-form" class="admin-coa-form">
      <div class="form-grid">
        <div class="field"><label>Lab name</label><input name="lab_name" required></div>
        <div class="field"><label>COA date</label><input type="date" name="coa_date"></div>
        <div class="field"><label>ISO 17025 #</label><input name="iso17025_accreditation_no"></div>
        <div class="field"><label>DEA registration #</label><input name="dea_registration_no"></div>
        <div class="field"><label>LIMS verify URL</label><input type="url" name="lims_verify_url"></div>
        <div class="field"><label>LOQ</label><input type="number" step="0.0001" name="loq"></div>
        <div class="field">
          <label>Delta-9 %</label>
          <input type="number" step="0.0001" name="delta9_pct" required>
          <span class="field-hint">enter 0 for non-detect</span>
        </div>
        <div class="field">
          <label class="mono">thca_pct</label>
          <input type="number" step="0.0001" name="thca_pct" required>
          <span class="field-hint">enter 0 for non-detect</span>
        </div>
        <div class="field"><label>CBD %</label><input type="number" step="0.0001" name="cbd_pct"></div>
        <div class="field"><label>Verify status</label>
          <select name="verify_status">${COA_VERIFY_STATUSES.map((s) => `<option value="${s}">${s}</option>`).join('')}</select>
        </div>
        <div class="field field-span"><label>Red flags</label><textarea name="red_flags"></textarea></div>
        <div class="field field-span"><label>Lab report (PDF)</label><input type="file" name="file" accept="application/pdf"></div>
      </div>
      <div class="form-actions"><button class="btn" type="submit">Add COA</button></div>
    </form>
  `;
}

async function saveNewCoa(e, lot, container, view) {
  e.preventDefault();
  const form = e.target;
  const btn = e.submitter || form.querySelector('[type="submit"]');
  await withBusy(btn, async () => {
    const fd = new FormData(form);
    const file = form.querySelector('[name="file"]').files[0];
    const redFlags = (fd.get('red_flags') || '').trim();

    const payload = {
      lot_id: lot.id,
      lab_name: fd.get('lab_name'),
      iso17025_accreditation_no: fd.get('iso17025_accreditation_no') || null,
      dea_registration_no: fd.get('dea_registration_no') || null,
      coa_date: fd.get('coa_date') || null,
      lims_verify_url: fd.get('lims_verify_url') || null,
      loq: fd.get('loq') || null,
      delta9_pct: fd.get('delta9_pct') || null,
      thca_pct: fd.get('thca_pct') || null,
      cbd_pct: fd.get('cbd_pct') || null,
      verify_status: fd.get('verify_status'),
      red_flags: redFlags || null,
    };

    const { data: coa, error } = await supabase.from('coa').insert(payload).select().single();
    if (error) { flash(error.message, true); return; }

    if (file) {
      const path = `lot-${lot.id}/${Date.now()}-${file.name}`;
      const { error: upErr } = await supabase.storage.from('coa-private').upload(path, file);
      if (upErr) {
        flash(upErr.message, true);
      } else {
        const { error: patchErr } = await supabase.from('coa').update({ storage_path: path }).eq('id', coa.id);
        if (patchErr) flash(patchErr.message, true);
      }
    }

    // Retest trigger (b): a COA saved with non-empty red_flags flags the lot,
    // once — guarded server-side too so it never re-fires after a clear.
    if (redFlags && !lot.retest_flagged_at) {
      const { error: flagErr } = await supabase.from('material_lot')
        .update({ retest_required: true, retest_flagged_at: new Date().toISOString() })
        .eq('id', lot.id)
        .is('retest_flagged_at', null);
      if (flagErr) flash(flagErr.message, true);
    }

    flash('COA added.');
    renderCoaSection(container, lot, view);
  });
}

async function updateCoaVerifyStatus(coaId, status, container, lot, view) {
  const { error } = await supabase.from('coa').update({ verify_status: status }).eq('id', coaId);
  if (error) { flash(error.message, true); return; }
  flash('COA updated.');
  renderCoaSection(container, lot, view);
}

async function viewCoaFile(path) {
  const { data, error } = await supabase.storage.from('coa-private').createSignedUrl(path, 300);
  if (error) { flash(error.message, true); return; }
  window.open(data.signedUrl, '_blank');
}

// Buyer-facing printable lot menu, sourced ONLY from presentable_lot — that
// view is structurally farm-anonymous (no legal_name/dba/contacts), so
// nothing here can leak supplier identity. asking_price_per_lb is never
// printed; "Landed $/lb" is left blank for the operator to fill by hand.
async function generateLotMenu() {
  const win = window.open('', '_blank');
  if (!win) { flash('Pop-up blocked — allow pop-ups to generate the lot menu.', true); return; }

  const { data: rows, error } = await supabase.from('presentable_lot').select('*')
    .order('material_type').order('strain');
  if (error) { win.close(); flash(error.message, true); return; }

  const bodyRows = (rows || []).map((r) => `
    <tr>
      <td>${escapeHtml(r.material_type)}</td>
      <td>${escapeHtml(r.strain) || '—'}</td>
      <td>${escapeHtml(r.grade) || '—'}</td>
      <td>${escapeHtml(r.grow_method) || '—'}</td>
      <td>${escapeHtml(r.origin_state) || '—'}</td>
      <td>${fmtNum(r.quantity_lb)}</td>
      <td>${r.cbd_pct ?? '—'}</td>
      <td>${r.total_thc_pct ?? '—'}</td>
      <td>${fmtDateOnly(r.coa_date)}</td>
      <td class="landed-price" contenteditable="true"></td>
    </tr>
  `).join('');

  win.document.write(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Meridian Hemp Co — Lot menu</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; padding: 24px; color: #111; }
  h1 { font-size: 1.4rem; margin: 0 0 2px; }
  .menu-date { color: #555; margin: 0 0 18px; font-size: 0.9rem; }
  table { border-collapse: collapse; width: 100%; font-size: 0.85rem; }
  th, td { border: 1px solid #ccc; padding: 6px 10px; text-align: left; }
  th { background: #f2f2f2; }
  .landed-price { min-width: 70px; background: #fffbe6; }
  .print-btn { margin-bottom: 14px; }
  @media print {
    .landed-price { background: none; }
    .print-btn { display: none; }
  }
</style>
</head>
<body>
  <h1>Meridian Hemp Co — Lot menu</h1>
  <p class="menu-date">${escapeHtml(fmtDateOnly(new Date().toISOString()))}</p>
  <button class="print-btn" type="button" onclick="window.print()">Print</button>
  <table>
    <thead>
      <tr><th>Material</th><th>Strain</th><th>Grade</th><th>Grow</th><th>Origin state</th><th>Qty (lb)</th><th>CBD %</th><th>Total THC %</th><th>COA date</th><th>Landed $/lb</th></tr>
    </thead>
    <tbody>${bodyRows || '<tr><td colspan="10">No presentable lots.</td></tr>'}</tbody>
  </table>
</body>
</html>`);
  win.document.close();
}

// Internal-only companion export — same presentable_lot rows but including
// asking_price_per_lb, clearly filename-flagged as internal use.
async function exportLotMenuCsvInternal() {
  const { data: rows, error } = await supabase.from('presentable_lot').select('*')
    .order('material_type').order('strain');
  if (error) { flash(error.message, true); return; }
  exportCsv(`lot-menu-internal-${todayStamp()}.csv`, rows || []);
}

// ---------------------------------------------------------------------
// 5. Buyers
// ---------------------------------------------------------------------
const KYB_STATUSES = ['unverified', 'verified', 'failed'];

async function renderBuyers(view) {
  const { data: buyers, error } = await supabase.from('buyer').select('*').order('created_at', { ascending: false }).limit(200);
  if (error) throw error;

  view.innerHTML = `
    <div class="admin-view-head">
      <h2>Buyers</h2>
      <button class="btn-quiet" type="button" id="admin-export-buyers">Export CSV</button>
    </div>
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead><tr><th>Company</th><th>Contact</th><th>Email</th><th>Phone</th><th>State</th><th>KYB</th><th></th></tr></thead>
        <tbody>${buyers.length ? buyers.map(buyerTableRow).join('') : '<tr><td colspan="7" class="admin-empty">No buyers yet.</td></tr>'}</tbody>
      </table>
    </div>
    <div id="admin-buyer-detail"></div>
  `;

  $$('[data-edit-buyer]', view).forEach((btn) => btn.addEventListener('click', () => openBuyerDetail(btn.dataset.editBuyer, buyers, view)));
  $('#admin-export-buyers', view).addEventListener('click', () => exportCsv(`buyers-${todayStamp()}.csv`, buyers));
}

function buyerTableRow(b) {
  return `
    <tr>
      <td>${escapeHtml(b.company)}</td>
      <td>${escapeHtml(b.contact_name) || '—'}</td>
      <td>${escapeHtml(b.email) || '—'}</td>
      <td>${escapeHtml(b.phone) || '—'}</td>
      <td>${escapeHtml(b.state) || '—'}</td>
      <td>${statusBadge(b.kyb_status)}</td>
      <td><button class="btn-quiet" type="button" data-edit-buyer="${b.id}">Edit</button></td>
    </tr>
  `;
}

function openBuyerDetail(buyerId, buyers, view) {
  const b = buyers.find((x) => x.id === buyerId);
  const detail = $('#admin-buyer-detail', view);
  detail.innerHTML = `
    <form class="form-card admin-detail-card" data-buyer-id="${b.id}">
      <h3>${escapeHtml(b.company)}</h3>
      <div class="form-grid">
        <div class="field"><label>Company</label><input name="company" value="${escapeHtml(b.company) || ''}" required></div>
        <div class="field"><label>Contact name</label><input name="contact_name" value="${escapeHtml(b.contact_name) || ''}"></div>
        <div class="field"><label>Email</label><input type="email" name="email" value="${escapeHtml(b.email) || ''}"></div>
        <div class="field"><label>Phone</label><input name="phone" value="${escapeHtml(b.phone) || ''}"></div>
        <div class="field"><label>State</label><input name="state" maxlength="2" value="${escapeHtml(b.state) || ''}"></div>
        <div class="field"><label>License</label><input name="license" value="${escapeHtml(b.license) || ''}"></div>
        <div class="field"><label>KYB status</label>
          <select name="kyb_status">${KYB_STATUSES.map((s) => `<option value="${s}" ${s === b.kyb_status ? 'selected' : ''}>${s}</option>`).join('')}</select>
        </div>
        <div class="field"><label class="check-option"><input type="checkbox" name="ncnd_signed" ${b.ncnd_signed ? 'checked' : ''}> NCND signed</label></div>
        <div class="field"><label>NCND signed date</label><input type="date" name="ncnd_signed_date" value="${b.ncnd_signed_date || ''}"></div>
        <div class="field"><label>NCND doc ref</label><input name="ncnd_doc_ref" value="${escapeHtml(b.ncnd_doc_ref) || ''}"></div>
        <div class="field field-span"><label>Notes</label><textarea name="notes">${escapeHtml(b.notes) || ''}</textarea></div>
      </div>
      <div class="form-actions">
        <button class="btn" type="submit">Save</button>
        <button class="btn-quiet" type="button" data-close-detail>Close</button>
      </div>
    </form>
  `;
  detail.querySelector('form').addEventListener('submit', (e) => saveBuyer(e, view));
  detail.querySelector('[data-close-detail]').addEventListener('click', () => { detail.innerHTML = ''; });
}

async function saveBuyer(e, view) {
  e.preventDefault();
  const form = e.target;
  const btn = e.submitter || form.querySelector('[type="submit"]');
  await withBusy(btn, async () => {
    const fd = new FormData(form);
    const patch = {
      company: fd.get('company'),
      contact_name: fd.get('contact_name') || null,
      email: fd.get('email') || null,
      phone: fd.get('phone') || null,
      state: fd.get('state') || null,
      license: fd.get('license') || null,
      kyb_status: fd.get('kyb_status'),
      ncnd_signed: fd.get('ncnd_signed') === 'on',
      ncnd_signed_date: fd.get('ncnd_signed_date') || null,
      ncnd_doc_ref: fd.get('ncnd_doc_ref') || null,
      notes: fd.get('notes') || null,
    };
    const { error } = await supabase.from('buyer').update(patch).eq('id', form.dataset.buyerId);
    if (error) { flash(error.message, true); return; }
    flash('Buyer saved.');
    renderBuyers(view);
  });
}

// ---------------------------------------------------------------------
// 6. Deals
// ---------------------------------------------------------------------
const DEAL_STATUSES = ['draft', 'offered', 'negotiating', 'closed_won', 'closed_lost'];

async function renderDeals(view) {
  const { data: deals, error } = await supabase.from('deal')
    .select('*, lot:lot_id(strain, material_type, coa(id, storage_path, created_at)), buyer:buyer_id(company)')
    .order('created_at', { ascending: false }).limit(200);
  if (error) throw error;

  view.innerHTML = `
    <div class="admin-view-head">
      <h2>Deals</h2>
      <button class="btn-quiet" type="button" id="admin-export-deals">Export CSV</button>
    </div>
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead><tr><th>Lot</th><th>Buyer</th><th>Request</th><th>Status</th><th>Price/lb</th><th>Qty (lb)</th><th></th></tr></thead>
        <tbody>${deals.length ? deals.map(dealTableRow).join('') : '<tr><td colspan="7" class="admin-empty">No deals yet.</td></tr>'}</tbody>
      </table>
    </div>
    <div id="admin-deal-detail"></div>
  `;

  $$('[data-edit-deal]', view).forEach((btn) => btn.addEventListener('click', () => openDealDetail(btn.dataset.editDeal, deals, view)));
  $('#admin-export-deals', view).addEventListener('click', () => exportCsv(`deals-${todayStamp()}.csv`, deals));
}

function dealTableRow(d) {
  return `
    <tr>
      <td>${escapeHtml(d.lot && (d.lot.strain || d.lot.material_type)) || '—'}</td>
      <td>${escapeHtml(d.buyer && d.buyer.company) || '—'}</td>
      <td class="mono">${d.buyer_request_id ? escapeHtml(d.buyer_request_id).slice(0, 8) : '—'}</td>
      <td>${statusBadge(d.status)}</td>
      <td class="mono">${fmtMoney(d.agreed_price_per_lb)}</td>
      <td class="mono">${fmtNum(d.quantity_lb)}</td>
      <td><button class="btn-quiet" type="button" data-edit-deal="${d.id}">Edit</button></td>
    </tr>
  `;
}

function openDealDetail(dealId, deals, view) {
  const d = deals.find((x) => x.id === dealId);
  const detail = $('#admin-deal-detail', view);
  const title = `${escapeHtml(d.lot && (d.lot.strain || d.lot.material_type)) || 'lot'} / ${escapeHtml(d.buyer && d.buyer.company) || 'buyer'}`;
  const coaList = (d.lot && d.lot.coa) || [];
  const latestCoa = coaList.filter((c) => c.storage_path).sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null;
  detail.innerHTML = `
    <form class="form-card admin-detail-card" data-deal-id="${d.id}" data-prev-status="${d.status}">
      <h3>Deal — ${title}</h3>
      <div class="form-grid">
        <div class="field"><label>Status</label>
          <select name="status">${DEAL_STATUSES.map((s) => `<option value="${s}" ${s === d.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
        </div>
        <div class="field"><label>Commission basis</label><input type="number" step="0.01" name="commission_basis" value="${d.commission_basis ?? ''}"></div>
        <div class="field"><label>Agreed price ($/lb)</label><input type="number" step="0.01" name="agreed_price_per_lb" value="${d.agreed_price_per_lb ?? ''}"></div>
        <div class="field"><label>Quantity (lb)</label><input type="number" step="0.01" name="quantity_lb" value="${d.quantity_lb ?? ''}"></div>
        <div class="field"><label>Sample sent</label><input type="date" name="sample_sent_at" value="${d.sample_sent_at ? d.sample_sent_at.slice(0, 10) : ''}"></div>
        <div class="field"><label>Sample tracking ref</label><input name="sample_tracking_ref" value="${escapeHtml(d.sample_tracking_ref) || ''}"></div>
        <div class="field field-span"><label>Notes</label><textarea name="notes">${escapeHtml(d.notes) || ''}</textarea></div>
      </div>
      <div class="form-actions">
        <button class="btn" type="submit">Save deal</button>
        <button class="btn-quiet" type="button" data-offer-sheet="${d.id}">Offer sheet</button>
        ${latestCoa ? `<button class="btn-quiet" type="button" data-release-coa="${d.id}" data-coa-id="${latestCoa.id}" data-coa-path="${escapeHtml(latestCoa.storage_path)}">Release COA to buyer</button>` : ''}
        <button class="btn-quiet" type="button" data-close-detail>Close</button>
      </div>
    </form>
  `;
  detail.querySelector('form').addEventListener('submit', (e) => saveDeal(e, view));
  detail.querySelector('[data-offer-sheet]').addEventListener('click', () => {
    if (window.mhcOfferSheet) window.mhcOfferSheet(dealId);
    else flash('Offer sheet module not loaded', true);
  });
  const releaseBtn = detail.querySelector('[data-release-coa]');
  if (releaseBtn) {
    releaseBtn.addEventListener('click', () => withBusy(releaseBtn, () => releaseCoaToBuyer(releaseBtn.dataset.releaseCoa, releaseBtn.dataset.coaId, releaseBtn.dataset.coaPath)));
  }
  detail.querySelector('[data-close-detail]').addEventListener('click', () => { detail.innerHTML = ''; });
}

async function saveDeal(e, view) {
  e.preventDefault();
  const form = e.target;
  const btn = e.submitter || form.querySelector('[type="submit"]');
  const dealId = form.dataset.dealId;
  const prevStatus = form.dataset.prevStatus;
  await withBusy(btn, async () => {
    const fd = new FormData(form);
    const sampleSentAt = fd.get('sample_sent_at');
    const patch = {
      status: fd.get('status'),
      commission_basis: fd.get('commission_basis') || null,
      agreed_price_per_lb: fd.get('agreed_price_per_lb') || null,
      quantity_lb: fd.get('quantity_lb') || null,
      sample_sent_at: sampleSentAt ? new Date(sampleSentAt).toISOString() : null,
      sample_tracking_ref: fd.get('sample_tracking_ref') || null,
      notes: fd.get('notes') || null,
    };

    if (patch.status === 'closed_lost' && prevStatus !== 'closed_lost' && !confirm('Mark this deal closed (lost)?')) return;
    if (patch.status === 'closed_won' && prevStatus !== 'closed_won' && !patch.sample_sent_at
      && !confirm('No sample sent on this deal — close anyway?')) return;

    const { data: deal, error } = await supabase.from('deal').update(patch).eq('id', dealId).select('*, lot:lot_id(material_type)').single();
    if (error) { flash(error.message, true); return; }

    if (patch.status === 'offered' && prevStatus !== 'offered' && patch.agreed_price_per_lb) {
      const { error: actErr } = await logActivity({
        entity_type: 'deal',
        entity_id: dealId,
        kind: 'quote',
        price_snapshot: {
          price_per_lb: Number(patch.agreed_price_per_lb),
          quantity_lb: patch.quantity_lb ? Number(patch.quantity_lb) : null,
          material_type: deal.lot ? deal.lot.material_type : null,
          ts: new Date().toISOString(),
        },
      });
      if (actErr) flash(actErr.message, true);
    }

    flash('Deal saved.');
    renderDeals(view);
  });
}

// Distinct from viewCoaFile (internal-only view): generates a fresh signed
// URL, logs the release to the deal's activity timeline FIRST, and only
// then presents the link — if the activity insert fails, the link is
// withheld and a distinct error is shown instead.
async function releaseCoaToBuyer(dealId, coaId, storagePath) {
  if (!confirm('Release this COA to the buyer? A signed download link will be generated.')) return;

  const { data: signed, error: signErr } = await supabase.storage.from('coa-private').createSignedUrl(storagePath, 300);
  if (signErr) { flash(signErr.message, true); return; }

  const expiresAt = new Date(Date.now() + 300 * 1000).toISOString();
  const { error: actErr } = await logActivity({
    entity_type: 'deal',
    entity_id: dealId,
    kind: 'coa_release',
    body: `COA ${coaId} released, expires ${expiresAt}`,
  });
  if (actErr) {
    flash(`COA link created but activity log failed — link withheld: ${actErr.message}`, true);
    return;
  }

  flash('COA release logged.');
  prompt('COA download link (expires in 5 min) — copy this to send to the buyer:', signed.signedUrl);
}

// ---------------------------------------------------------------------
// 7. Activity
// ---------------------------------------------------------------------
const ENTITY_TYPES = ['farm', 'buyer', 'lot', 'deal', 'buyer_request', 'farm_intake'];

async function renderActivity(view) {
  const { data: rows, error } = await supabase.from('activity').select('*').order('created_at', { ascending: false }).limit(100);
  if (error) throw error;

  view.innerHTML = `
    <div class="admin-view-head">
      <h2>Activity</h2>
      <button class="btn-quiet" type="button" id="admin-export-activity">Export CSV</button>
    </div>
    <form id="admin-note-form" class="admin-note-form">
      <div class="form-grid">
        <div class="field"><label>Entity type</label>
          <select name="entity_type">${ENTITY_TYPES.map((t) => `<option value="${t}">${t}</option>`).join('')}</select>
        </div>
        <div class="field"><label>Entity ID</label><input name="entity_id" placeholder="uuid" required></div>
        <div class="field field-span"><label>Note</label><textarea name="body" required></textarea></div>
      </div>
      <div class="form-actions"><button class="btn" type="submit">Add note</button></div>
    </form>
    <div class="admin-table-wrap">
      <table class="admin-table">
        <thead><tr><th>When</th><th>Entity</th><th>Kind</th><th>Body</th></tr></thead>
        <tbody>${rows.length ? rows.map(activityRow).join('') : '<tr><td colspan="4" class="admin-empty">No activity yet.</td></tr>'}</tbody>
      </table>
    </div>
  `;

  $('#admin-note-form', view).addEventListener('submit', (e) => addNote(e, view));
  $('#admin-export-activity', view).addEventListener('click', () => exportCsv(`activity-${todayStamp()}.csv`, rows));
}

function activityRow(a) {
  return `
    <tr>
      <td class="mono">${fmtDate(a.created_at)}</td>
      <td>${escapeHtml(a.entity_type)} <span class="mono">${escapeHtml(a.entity_id).slice(0, 8)}</span></td>
      <td>${escapeHtml(a.kind)}</td>
      <td>${escapeHtml(a.body) || '—'}</td>
    </tr>
  `;
}

async function addNote(e, view) {
  e.preventDefault();
  const form = e.target;
  const btn = e.submitter || form.querySelector('[type="submit"]');
  await withBusy(btn, async () => {
    const fd = new FormData(form);
    const payload = {
      entity_type: fd.get('entity_type'),
      entity_id: fd.get('entity_id').trim(),
      kind: 'note',
      body: fd.get('body').trim(),
    };
    const { error } = await logActivity(payload);
    if (error) { flash(error.message, true); return; }
    flash('Note added.');
    renderActivity(view);
  });
}
