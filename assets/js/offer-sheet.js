// Offer-sheet generator — the white-label artifact.
//
// Reads ONLY meridian.presentable_lot (a farm-name-free projection), so the
// generated document structurally cannot contain supplier identity. A lot that
// is not presentable (unverified/failing COA, unverified farm, retest pending)
// is a hard error, and a blocked destination state refuses generation.
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

async function fetchSheetData(dealId) {
  const { data: deal, error: dealErr } = await supabase
    .from('deal').select('*').eq('id', dealId).single();
  if (dealErr || !deal) throw new Error(`Deal not found: ${dealErr?.message || dealId}`);
  if (!deal.lot_id) throw new Error('Deal has no lot attached.');

  // Farm-name-free by construction — and the compliance gate in one query:
  // a lot only appears here with a verified, passing COA, a verified/active
  // farm, and no pending retest.
  const { data: lots, error: lotErr } = await supabase
    .from('presentable_lot').select('*').eq('lot_id', deal.lot_id);
  if (lotErr) throw new Error(lotErr.message);
  if (!lots || lots.length === 0) {
    throw new Error('Lot is not presentable — COA unverified or failing, farm not verified, or retest pending. Clear that first.');
  }
  const lot = lots[0];

  let request = null;
  if (deal.buyer_request_id) {
    const { data } = await supabase
      .from('buyer_request')
      .select('company, contact_name, destination_state')
      .eq('id', deal.buyer_request_id).single();
    request = data;
  }

  let buyerCompany = request?.company || null;
  if (!buyerCompany && deal.buyer_id) {
    const { data } = await supabase.from('buyer').select('company').eq('id', deal.buyer_id).single();
    buyerCompany = data?.company || null;
  }

  let legality = null;
  if (request?.destination_state) {
    const { data } = await supabase
      .from('state_legality').select('state, status, notes')
      .eq('state', request.destination_state).single();
    legality = data;
  }

  return { deal, lot, request, buyerCompany, legality };
}

function renderSheet({ ref, lot, deal, buyerCompany, request }) {
  const price = deal.agreed_price_per_lb ?? lot.asking_price_per_lb;
  const qty = deal.quantity_lb ?? lot.quantity_lb;
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

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
    <p><b>Terms.</b> Offer valid for 5 business days and subject to prior sale. Sample approval before full-lot commitment. Material ships only where lawful; buyer represents it is a business purchaser, 21+, holding any licenses its state requires.</p>
    <p><b>Confidentiality.</b> This document and the transaction it describes are covered by non-disclosure and non-circumvention terms. Presented by Meridian Hemp Co as broker of record.</p>
    <p class="contact">Meridian Hemp Co · 312 W. 2nd St #1175, Casper, WY 82601 · deals@meridianhempco.com</p>
  </footer>

  <button class="no-print print-btn" onclick="window.print()">Print / save as PDF</button>
</div>
</body>
</html>`;
}

async function logSheet(deal, lot, ref) {
  const price = deal.agreed_price_per_lb ?? lot.asking_price_per_lb;
  const qty = deal.quantity_lb ?? lot.quantity_lb;
  await supabase.from('activity').insert({
    entity_type: 'deal',
    entity_id: deal.id,
    kind: 'offer_sheet',
    body: `Offer sheet ${ref} generated`,
    price_snapshot: {
      price_per_lb: price,
      quantity_lb: qty,
      material_type: lot.material_type,
      lot_id: lot.lot_id,
      ts: new Date().toISOString(),
    },
  });
  await supabase.from('deal').update({ offer_sheet_ref: ref }).eq('id', deal.id);
}

window.mhcOfferSheet = async function mhcOfferSheet(dealId) {
  if (!supabase) { alert('Supabase is not configured yet.'); return; }
  try {
    const { deal, lot, request, buyerCompany, legality } = await fetchSheetData(dealId);

    // Destination-state gate: refuse blocked lanes, confirm gray ones.
    if (legality?.status === 'blocked') {
      alert(`Destination state ${legality.state} is BLOCKED for this material.\n\n${legality.notes || ''}\n\nNo offer sheet generated.`);
      return;
    }
    if (legality?.status === 'gray') {
      const go = confirm(`Destination state ${legality.state} is GRAY — verify before shipping.\n\n${legality.notes || ''}\n\nGenerate the offer sheet anyway?`);
      if (!go) return;
    }

    const ref = `MHC-${String(deal.id).slice(0, 8).toUpperCase()}`;
    const win = window.open('', '_blank');
    if (!win) { alert('Popup blocked — allow popups for this site.'); return; }
    win.document.write(renderSheet({ ref, lot, deal, buyerCompany, request }));
    win.document.close();

    await logSheet(deal, lot, ref);
  } catch (err) {
    console.error(err);
    alert(`Offer sheet failed: ${err.message}`);
  }
};
