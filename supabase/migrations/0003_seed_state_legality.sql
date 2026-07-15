-- =============================================================================
-- 0003_seed_state_legality.sql
-- Meridian Hemp Co. farm-CRM — seed meridian.state_legality (50 states + DC).
-- Order: 3 of 4 (run after 0001_schema.sql, 0002_rls.sql; before 0004_views.sql).
--
-- Judged specifically for RECEIVING SMOKABLE CBD HEMP FLOWER SHIPMENTS
-- (Meridian's product — material_lot.material_type in
-- ('cbd_flower','smalls','biomass','pre_rolls')), not THCA flower, even where
-- the source research emphasizes THCA. Where a state's CBD-flower posture
-- differs from its THCA posture, this table follows CBD flower.
--
-- Sources (26 states researched, 2026-07-09 retrieval date):
--   c:/Users/marke/research/notes/hemp/state-matrix-south-east.md
--   c:/Users/marke/research/notes/hemp/state-matrix-west-midwest-ne.md
-- Federal backdrop referenced in those notes: P.L. 119-37 §781 total-THC
-- (Δ9 + 0.877×THCA) 0.3% + 0.4mg/container cap, effective 2026-11-12.
--
-- The remaining 24 states + DC were NOT covered by the source research and
-- are seeded 'gray' with a note flagging them for follow-up verification
-- rather than guessing at unresearched statutes. Do not treat 'gray' rows as
-- cleared for shipment — see meridian.presentable_lot / admin workflow,
-- which should still require a manual check before a deal ships to a
-- 'gray' or unresearched destination state.
--
-- Uses upsert so this file can be safely re-run as research is refreshed.
-- =============================================================================

insert into meridian.state_legality (state, status, notes) values
  -- ---------------------------------------------------------------------
  -- Researched states (south-east matrix)
  -- ---------------------------------------------------------------------
  ('TX', 'gray',    'Volatile: 25 TAC Ch.300 smokable ban enjoined 5/1/26, reinstated by 15th Ct App ~6/9/26, trial ~7/27/26. Non-smokable CBD ≤0.3% total THC legal; smokable form caught by rule pending litigation outcome.'),
  ('FL', 'allowed', 'Legal 21+ if ≤0.3% total THC (Fla. Stat. §581.217 / 5K-4.034); requires Hemp Food Establishment Permit ~$650/yr from FDACS.'),
  ('GA', 'blocked', 'Flower/leaf form banned outright for retail and wholesale regardless of THC content (O.C.G.A. §2-23-3, SB 494 eff 10/1/24).'),
  ('NC', 'allowed', 'Legal, unlicensed, Δ9-only test today. HB 328 conference report (federal total-THC standard) passed Senate 7/2/26, House vote ~7/27/26 — would add 21+ age law eff 7/15/26; monitor for status change.'),
  ('SC', 'allowed', 'Legal, no form ban, Δ9-only test, no license required for CBD flower. Note: SLED/AG actively prosecute high-THCA material as marijuana — keep lots clearly CBD-dominant.'),
  ('TN', 'allowed', 'Legal ≤0.3% total THC, but in-person sale at TABC-licensed premises only — online sales banned. Licensing: $500 app + $1,000 retail/$2,500 supplier/$5,000 wholesaler per year.'),
  ('VA', 'allowed', 'Legal within total-THC caps; smokable flower requires ISO-17025 COA. Retail Facility Registration $1,000/yr (VDACS, transitioning to CCA ~Aug 2026).'),
  ('KY', 'blocked', 'Flower form-banned at retail regardless of THC (302 KAR 50:070); non-flower CBD products remain legal. Wholesale limited to licensee-to-licensee.'),
  ('AL', 'blocked', 'Smokable hemp form-banned as a FELONY (Class C, 1-10 yrs) since 7/1/25 (HB 445); online/shipping sales also banned.'),
  ('MS', 'blocked', 'No statute, but AG opinion (6/11/25) treats consumable hemp as illegal absent FDA approval or medical program; enforcement inconsistent. Treated as blocked pending 2026-27 legislative session.'),
  ('LA', 'blocked', 'Smokable/floral form banned (Act 752 eff 1/1/25), enforced with litigation pending but no injunction in place.'),
  ('IN', 'blocked', 'Historic smokable-hemp ban (IC §35-48-4-10.1) is a Class A misdemeanor including mere transport, regardless of THC content. 2026 reform bills (SB 250, SB 478) both died.'),
  ('OH', 'blocked', 'SB 56 (eff 3/20/26) caps at 0.4mg total THC/container — flower exceeds this trivially — and routes anything above it to dispensary-only channel, which cannot sell hemp flower. No lawful smokable-flower channel.'),
  -- ---------------------------------------------------------------------
  -- Researched states (west/midwest/NE matrix)
  -- ---------------------------------------------------------------------
  ('CA', 'blocked', 'AB 8 (eff 1/1/26) bars ALL hemp flower/pre-rolls regardless of THC content; dispensary-only channel. CDPH no-detectable-THC rule for ingestibles reinforces the ban.'),
  ('CO', 'allowed', 'Legal only in a narrow CBD-dominant lane (mandatory ≥15:1 CBD:THC ratio, ≤1.75mg THC/serving). CDPHE processing registration ~$1,600/yr + product registration; verify each lot meets the ratio before shipping.'),
  ('OR', 'allowed', 'Legal ≤0.3% total THC. Requires OLCC Hemp Registry ($400/yr, enforced since 6/1/26) + Vendor registration ($100/yr) + ODA registration.'),
  ('WA', 'blocked', 'Any detectable THC is treated as a cannabis product (SB 5367) — trace THC in flower sweeps it into the cannabis channel. Functionally bans all hemp flower outside licensed cannabis retail.'),
  ('AZ', 'allowed', 'Legal ≤0.3% total THC, no form ban. AZDA licensing: grower $1,000/processor $2,000/transporter $100/yr; no dedicated hemp retail license, no state hemp age law.'),
  ('MO', 'gray',    'Legal today on a Δ9-only basis, but HB 2641 (signed 4/23/26, "Intoxicating Cannabinoid Control Act") moves to 0.3% total-THC + 0.4mg/container effective 11/12/26, which will route most flower into dispensary-only. Window closing.'),
  ('IL', 'gray',    'Legal today, no retail license required, but SB 3222 (signed 6/12/26) imposes a 0.4mg/container cap effective 11/12/26, timed to the federal cutover — effectively closes the flower lane on that date.'),
  ('MI', 'allowed', 'Legal with CRA Processor-Handler license ($1,350 + $150 sampling/testing fees eff 1/1/26); total-THC test basis (0.877 factor) per PA 56/2021. MDARD grower license $1,250.'),
  ('WI', 'allowed', 'Fully legal for retail and wholesale, no form restriction, Δ9-only test, NO state license required (USDA grower registration + DATCP processor ~$100/yr only). No state age law; friendliest state in the researched set.'),
  ('MN', 'blocked', 'Effectively blocked: the Lower-Potency Hemp Edible (LPHE) program covers edibles only — smokable flower is routed into the licensed cannabis channel under OCM total-THC rules.'),
  ('NY', 'blocked', 'No clean lane: OCM Part 114 bans any hemp product marketed or sold "for smoking" regardless of THC content, and treats intoxicating THCA as cannabis.'),
  ('NJ', 'blocked', 'Effectively barred: S-4509 (eff 1/13/26) + implementing rule c.7 (eff 3/30/26) impose a 0.4mg/container cap (including THC analogs) that flower cannot meet; smoke-shop sales of hemp flower ended 4/13/26.'),
  ('PA', 'allowed', 'Legal, open retail, no form restriction. PDA confirms there is NO license required to wholesale, retail, or broker hemp flower in PA today (cultivation is tested on a total-THC basis; retail practice is Δ9-only). SB 49 pending would change this.'),
  -- ---------------------------------------------------------------------
  -- Not covered by the source research (state-matrix files) — seeded
  -- gray pending dedicated research; do NOT treat as cleared to ship.
  -- ---------------------------------------------------------------------
  ('AK', 'gray', 'Not yet researched in state-matrix files (July 2026) — verify current statute/program before accepting shipments.'),
  ('AR', 'gray', 'Not yet researched in state-matrix files (July 2026) — verify current statute/program before accepting shipments.'),
  ('CT', 'gray', 'Not yet researched in state-matrix files (July 2026) — verify current statute/program before accepting shipments.'),
  ('DE', 'gray', 'Not yet researched in state-matrix files (July 2026) — verify current statute/program before accepting shipments.'),
  ('HI', 'gray', 'Not yet researched in state-matrix files (July 2026) — verify current statute/program before accepting shipments.'),
  ('ID', 'gray', 'Not yet researched in state-matrix files (July 2026) — verify current statute/program before accepting shipments.'),
  ('IA', 'gray', 'Not yet researched in state-matrix files (July 2026) — verify current statute/program before accepting shipments.'),
  ('KS', 'gray', 'Not yet researched in state-matrix files (July 2026) — verify current statute/program before accepting shipments.'),
  ('ME', 'gray', 'Not yet researched in state-matrix files (July 2026) — verify current statute/program before accepting shipments.'),
  ('MD', 'gray', 'Not yet researched in state-matrix files (July 2026) — verify current statute/program before accepting shipments.'),
  ('MA', 'gray', 'Not yet researched in state-matrix files (July 2026) — verify current statute/program before accepting shipments.'),
  ('MT', 'gray', 'Not yet researched in state-matrix files (July 2026) — verify current statute/program before accepting shipments.'),
  ('NE', 'gray', 'Not yet researched in state-matrix files (July 2026) — verify current statute/program before accepting shipments.'),
  ('NV', 'gray', 'Not yet researched in state-matrix files (July 2026) — verify current statute/program before accepting shipments.'),
  ('NH', 'gray', 'Not yet researched in state-matrix files (July 2026) — verify current statute/program before accepting shipments.'),
  ('NM', 'gray', 'Not yet researched in state-matrix files (July 2026) — verify current statute/program before accepting shipments.'),
  ('ND', 'gray', 'Not yet researched in state-matrix files (July 2026) — verify current statute/program before accepting shipments.'),
  ('OK', 'gray', 'Not yet researched in state-matrix files (July 2026) — verify current statute/program before accepting shipments.'),
  ('RI', 'gray', 'Not yet researched in state-matrix files (July 2026) — verify current statute/program before accepting shipments.'),
  ('SD', 'gray', 'Not yet researched in state-matrix files (July 2026) — verify current statute/program before accepting shipments.'),
  ('UT', 'gray', 'Not yet researched in state-matrix files (July 2026) — verify current statute/program before accepting shipments.'),
  ('VT', 'gray', 'Not yet researched in state-matrix files (July 2026) — verify current statute/program before accepting shipments.'),
  ('WV', 'gray', 'Not yet researched in state-matrix files (July 2026) — verify current statute/program before accepting shipments.'),
  ('WY', 'gray', 'Not yet researched in state-matrix files (July 2026) — verify current statute/program before accepting shipments.'),
  ('DC', 'gray', 'Not yet researched in state-matrix files (July 2026) — verify current statute/program before accepting shipments.')
on conflict (state) do update
  set status = excluded.status,
      notes = excluded.notes,
      updated_at = now();
