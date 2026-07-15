// Offer-sheet generator — the white-label artifact.
//
// Reads ONLY meridian.presentable_lot (a farm-name-free projection), so the
// generated document structurally cannot contain supplier identity. A lot that
// is not presentable (unverified/failing COA, unverified farm, retest pending)
// is a hard error. Gates, all fail-closed: destination state must be on file
// and not blocked; the buyer must exist with verified KYB and a signed NCND
// (the sheet's confidentiality line must be true before the sheet exists);
// the audit row is written BEFORE the artifact renders. Newest COA wins;
// stale COAs (>180d), LOQ-margin lots, and supplier-name leaks in the strain
// field each require explicit confirmation.
// Exposed as window.mhcOfferSheet(dealId); admin.js guard-calls it.
import { supabase } from './supabase-client.js';

const GLYPH = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" aria-hidden="true">
  <circle cx="12" cy="12" r="10.4" stroke-width="1.5"/>
  <path d="M2.2 12.5h19.6" stroke-width="1.1" opacity="0.85"/>
  <path d="M8.6 12.5a3.4 3.4 0 0 1 6.8 0" stroke-width="1.5"/>
  <path d="M12 5.4v1.9M7.7 6.9l1.3 1.4M16.3 6.9 15 8.3" stroke-width="1.2"/>
  <path d="M12 12.5v8.5M9.9 12.5l-2.5 7.2M14.1 12.5l2.5 7.2" stroke-width="1.2" opacity="0.8"/>
</svg>`;

const LABELS = {
  cbd_flower: 'CBD flower',
  smalls: 'Smalls / pre-roll grade',
  biomass: 'Biomass',
  pre_rolls: 'Finished pre-rolls',
  a_bud: 'A-bud',
  b_grade: 'B-grade',
  indoor: 'Indoor',
  light_dep: 'Light-dep',
  outdoor: 'Outdoor',
  greenhouse: 'Greenhouse',
};

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function label(v) { return LABELS[v] || v || '—'; }
function pct(v) { return v == null ? '—' : `${Number(v).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}%`; }
function usd(v) { return v == null ? '—' : `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`; }
function lbs(v) { return v == null ? '—' : `${Number(v).toLocaleString('en-US')} lb`; }
function fmtDate(v) {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? esc(v) : d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}
function validThrough(businessDays = 5) {
  const d = new Date();
  let left = businessDays;
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0 && d.getDay() !== 6) left--;
  }
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

async function fetchSheetData(dealId) {
  const { data: deal, error: dealErr } = await supabase
    .from('deal').select('*').eq('id', dealId).single();
  if (dealErr || !deal) throw new Error(`Deal not found: ${dealErr?.message || dealId}`);
  if (!deal.lot_id) throw new Error('Deal has no lot attached.');

  // Farm-name-free by construction — and the compliance gate in one query:
  // a lot only appears here with a verified, passing COA, a verified/active
  // farm, and no pending retest. A lot can carry several COAs (one row each);
  // the newest by coa_date is the one the sheet stands on.
  const { data: lots, error: lotErr } = await supabase
    .from('presentable_lot').select('*').eq('lot_id', deal.lot_id)
    .order('coa_date', { ascending: false }).limit(1);
  if (lotErr) throw new Error(lotErr.message);
  if (!lots || lots.length === 0) {
    throw new Error('Lot is not presentable — COA unverified or failing, farm not verified, or retest pending. Clear that first.');
  }
  const lot = lots[0];

  // Destination gate fails closed: no request or no destination = no sheet.
  let request = null;
  if (deal.buyer_request_id) {
    const { data } = await supabase
      .from('buyer_request')
      .select('company, contact_name, destination_state, buyer_id')
      .eq('id', deal.buyer_request_id).single();
    request = data;
  }
  if (!request || !request.destination_state) {
    throw new Error('No destination on file — link a buyer request with a destination state before generating an offer sheet.');
  }

  // Buyer gates fail closed: the sheet is only produced for a known buyer
  // with verified KYB and a signed NCND.
  const buyerId = deal.buyer_id || request.buyer_id;
  if (!buyerId) {
    throw new Error('No buyer on file for this deal — link a buyer (verified KYB, signed NCND) first.');
  }
  const { data: buyer, error: buyerErr } = await supabase
    .from('buyer').select('id, company, kyb_status, ncnd_signed')
    .eq('id', buyerId).single();
  if (buyerErr || !buyer) throw new Error('Buyer record not found for this deal.');
  if (buyer.kyb_status !== 'verified') {
    throw new Error(`Buyer KYB status is '${buyer.kyb_status}' — verify the buyer before anything goes out.`);
  }
  if (!buyer.ncnd_signed) {
    throw new Error('Buyer NCND is not signed — the confidentiality line on the sheet must be true before the sheet exists.');
  }

  const { data: legality } = await supabase
    .from('state_legality').select('state, status, notes')
    .eq('state', request.destination_state).single();
  if (!legality) {
    throw new Error(`No legality record for destination state ${request.destination_state} — add the state to state_legality first.`);
  }

  return { deal, lot, request, buyerCompany: buyer.company || request.company || null, legality };
}

// Buyer-facing leak guard: the strain field is free text typed at intake —
// if it contains a supplier's legal name or DBA, the white label is broken.
async function strainLeakWarning(strain) {
  if (!strain) return null;
  const { data: farms } = await supabase.from('farm').select('legal_name, dba');
  const hay = String(strain).toLowerCase();
  for (const f of farms || []) {
    for (const name of [f.legal_name, f.dba]) {
      const n = (name || '').toLowerCase().trim();
      if (n.length >= 4 && hay.includes(n)) {
        return `Strain text "${strain}" appears to contain the supplier name "${name}" — that would leak on a buyer-facing document. Edit the strain first.\n\nGenerate anyway?`;
      }
    }
  }
  return null;
}

function renderSheet({ ref, lot, deal, buyerCompany, request }) {
  const price = deal.agreed_price_per_lb ?? lot.asking_price_per_lb;
  const qty = deal.quantity_lb ?? lot.quantity_lb;
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const validDate = validThrough(5);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Meridian Hemp Co — Offer ${esc(ref)}</title>
<link rel="stylesheet" href="/styles/offer-sheet.css">
</head>
<body>
<div class="sheet">

  <header class="sheet-head">
    <div class="brand">
      <span class="brand-glyph">${GLYPH}</span>
      <div>
        <b>Meridian Hemp Co</b>
        <span>Wholesale offer sheet</span>
      </div>
    </div>
    <table class="doc-meta">
      <tr><td>Reference</td><td class="mono">${esc(ref)}</td></tr>
      <tr><td>Date</td><td>${esc(today)}</td></tr>
      <tr><td>Valid through</td><td>${esc(validDate)}</td></tr>
      <tr><td>Prepared for</td><td>${esc(buyerCompany || 'Prospective buyer')}</td></tr>
      ${request?.destination_state ? `<tr><td>Destination</td><td>${esc(request.destination_state)}</td></tr>` : ''}
    </table>
  </header>

  <hr class="rule">

  <section>
    <h2>Material</h2>
    <table class="spec">
      <tr><td>Product</td><td>${esc(label(lot.material_type))}</td></tr>
      <tr><td>Strain</td><td>${esc(lot.strain || '—')}</td></tr>
      <tr><td>Grade</td><td>${esc(label(lot.grade))}</td></tr>
      <tr><td>Grow method</td><td>${esc(label(lot.grow_method))}</td></tr>
      <tr><td>Origin</td><td>US-grown · ${esc(lot.origin_state || '—')} · licensed producer</td></tr>
      <tr><td>Harvest</td><td>${fmtDate(lot.harvest_date)}</td></tr>
      <tr><td>Quantity offered</td><td class="mono">${lbs(qty)}</td></tr>
      <tr><td>Offer price</td><td class="mono strong">${usd(price)} / lb${price != null ? ' · quoted landed' : ''}</td></tr>
    </table>
  </section>

  <section>
    <h2>Lab results <span class="badge-verified">Verified to lab records</span></h2>
    <table class="spec">
      <tr><td>CBD</td><td class="mono">${pct(lot.cbd_pct)}</td></tr>
      <tr><td>Delta-9 THC</td><td class="mono">${pct(lot.delta9_pct)}</td></tr>
      <tr><td>THCA</td><td class="mono">${pct(lot.thca_pct)}</td></tr>
      <tr><td>Total THC (Δ9 + 0.877 × THCA)</td><td class="mono strong">${pct(lot.total_thc_pct)} — within the 0.3% federal limit</td></tr>
    </table>
    <table class="spec lab">
      <tr><td>Laboratory</td><td>${esc(lot.lab_name || '—')}</td></tr>
      <tr><td>ISO/IEC 17025 accreditation</td><td class="mono">${esc(lot.iso17025_accreditation_no || '—')}</td></tr>
      <tr><td>DEA registration</td><td class="mono">${esc(lot.dea_registration_no || '—')}</td></tr>
      <tr><td>COA reference</td><td class="mono">${esc(String(lot.coa_id || '').slice(0, 8).toUpperCase())} · ${fmtDate(lot.coa_date)}</td></tr>
    </table>
    <p class="note">The certificate of analysis for this lot has been checked against the issuing laboratory's own records. The full certificate is disclosed at contract stage under a mutual confidentiality and non-circumvention agreement.</p>
  </section>

  <hr class="rule">

  <footer class="sheet-foot">
    <p><b>Terms.</b> Offer valid through ${esc(validDate)} and subject to prior sale. Sample approval before full-lot commitment. Material ships only where lawful; buyer represents it is a business purchaser, 21+, holding any licenses its state requires.</p>
    <p><b>Confidentiality.</b> This document and the transaction it describes are covered by non-disclosure and non-circumvention terms. Presented by Meridian Hemp Co as broker of record.</p>
    <p class="contact">Meridian Hemp Co · 312 W. 2nd St #1175, Casper, WY 82601 · deals@meridianhempco.com</p>
  </footer>

  <button class="no-print print-btn" onclick="window.print()">Print / save as PDF</button>
</div>
</body>
</html>`;
}

// Writes the audit row + deal ref. Throws on any failure — the caller must
// refuse to render the sheet when this fails (no audit row, no artifact).
async function logSheet(deal, lot, ref) {
  const price = deal.agreed_price_per_lb ?? lot.asking_price_per_lb;
  const qty = deal.quantity_lb ?? lot.quantity_lb;
  const { data: userData } = await supabase.auth.getUser();
  const { error: actErr } = await supabase.from('activity').insert({
    entity_type: 'deal',
    entity_id: deal.id,
    kind: 'offer_sheet',
    body: `Offer sheet ${ref} generated`,
    created_by: userData?.user?.id ?? null,
    price_snapshot: {
      price_per_lb: price,
      quantity_lb: qty,
      material_type: lot.material_type,
      lot_id: lot.lot_id,
      ts: new Date().toISOString(),
    },
  });
  if (actErr) throw new Error(`activity log insert failed: ${actErr.message}`);
  const { error: dealErr } = await supabase.from('deal').update({ offer_sheet_ref: ref }).eq('id', deal.id);
  if (dealErr) throw new Error(`deal ref update failed: ${dealErr.message}`);
}

window.mhcOfferSheet = async function mhcOfferSheet(dealId) {
  if (!supabase) { alert('Supabase is not configured yet.'); return; }

  // Open the window synchronously (inside the click gesture) so popup
  // blockers allow it; it is closed again on any gate refusal or failure.
  const win = window.open('', '_blank');
  if (!win) { alert('Popup blocked — allow popups for this site.'); return; }
  win.document.write('<!doctype html><title>Preparing offer sheet…</title><p style="font:14px system-ui;padding:24px">Preparing offer sheet…</p>');
  win.document.close();

  try {
    const { deal, lot, request, buyerCompany, legality } = await fetchSheetData(dealId);

    // Destination-state gate: refuse blocked lanes, confirm gray ones.
    if (legality.status === 'blocked') {
      win.close();
      alert(`Destination state ${legality.state} is BLOCKED for this material.\n\n${legality.notes || ''}\n\nNo offer sheet generated.`);
      return;
    }
    if (legality.status === 'gray') {
      const go = confirm(`Destination state ${legality.state} is GRAY — verify before shipping.\n\n${legality.notes || ''}\n\nGenerate the offer sheet anyway?`);
      if (!go) { win.close(); return; }
    }

    // COA staleness: a report older than 180 days needs a conscious override.
    if (lot.coa_date) {
      const ageDays = Math.floor((Date.now() - new Date(lot.coa_date).getTime()) / 86400000);
      if (ageDays > 180) {
        const go = confirm(`This lot's COA is ${ageDays} days old (over 180). A current retest is strongly advised before quoting.\n\nGenerate anyway?`);
        if (!go) { win.close(); return; }
      }
    }

    // LOQ margin: passing, but within one LOQ of the 0.300% line — retest
    // variance could flip it. Make the risk explicit.
    if (lot.loq != null && lot.total_thc_pct != null
        && (0.3 - Number(lot.total_thc_pct)) <= Number(lot.loq)) {
      const go = confirm(`Total THC ${pct(lot.total_thc_pct)} is within one LOQ (${pct(lot.loq)}) of the 0.300% limit — an independent retest could fail this lot.\n\nGenerate anyway?`);
      if (!go) { win.close(); return; }
    }

    // White-label leak guard: supplier name hiding in the strain text.
    const leak = await strainLeakWarning(lot.strain);
    if (leak) {
      const go = confirm(leak);
      if (!go) { win.close(); return; }
    }

    // Unique per generation — regenerating the same deal mints a new ref, so
    // every printed artifact traces to exactly one audit row.
    const ref = `MHC-${String(deal.id).slice(0, 8).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;

    // Audit first: no logged row, no artifact.
    try {
      await logSheet(deal, lot, ref);
    } catch (logErr) {
      win.close();
      console.error(logErr);
      alert(`Offer sheet NOT generated — audit logging failed and the sheet will not be produced without it.\n\n${logErr.message}`);
      return;
    }

    win.document.open();
    win.document.write(renderSheet({ ref, lot, deal, buyerCompany, request }));
    win.document.close();
  } catch (err) {
    win.close();
    console.error(err);
    alert(`Offer sheet failed: ${err.message}`);
  }
};
