# Mandi Price Intelligence — research & plan notes

## Research (2026-11-04)
- AMIS daily-changes page is a plain table: city, crop, today's and yesterday's
  FQP/average price, change. Prices in Rs/100kg unless noted (banana per dozen).
  Fetched live 2026-11-04; values used verbatim in seed-data.json.
- Commissioner Karachi lists are daily pages (bazaar / mandi-bachat / auction
  per kg). 4 Nov 2026 list used for the Karachi retail seed.
- Gap confirmed by search: AMIS shows today only (no history), commissioner
  lists are daily pages (no history, no alerts, no checker). Nobody combines
  wholesale + official retail + history + alerts + checker in one product.
- Known data quirks found during research (kept as features, not hidden):
  - Garlic local jumps: Kasur 22,500 → 41,000 (+82.22%), Sahiwal 21,650 →
    40,000 (+84.76%) in one day — flagged "verify" by the 40% rule.
  - Layyah tomato +44.19% (8,600 → 12,400) — also flagged.
  - AMIS direction icons do not always match the change sign — direction is
    computed from values, never from icons.

## v1 scope (built, tested, 18/18 checks pass)
Public rates + movers + cheapest-city + overcharge checker + trend chart +
admin snapshot/item entry. Cities seeded: Lahore, Karachi, Rawalpindi,
Faisalabad, Gujranwala, Multan, Okara, Sargodha, Sahiwal, Kasur, Layyah,
RahimYarKhan. Items: 27 with Urdu names.

## v2 (not started, not promised)
Daily ingestion run (fetch AMIS + commissioner list, append snapshot, keep
source + date); more cities; official retail lists for Lahore/Islamabad;
alert subscriptions. Each v2 step gets its own test before it ships.

## v1.1 — Provinces expansion (2026-11-04 evening, on his order)
- All 41 Punjab districts + all 38 KPK districts listed, grouped by province
  (cities table gained a `province` column; old DBs migrate on startup,
  including the "RahimYarKhan" -> "Rahim Yar Khan" rename).
- Peshawar retail seeded from the dated Business Recorder survey (2026-11-02);
  Nowshera and all other rate-less districts show honestly empty.
- New admin endpoint POST /api/admin/city (code-gated) creates bare districts.
- Tests extended 18 -> 26, all passing on a fresh DB.
- Live update path: redeploy the SnapDeploy container (startup seeding is
  idempotent, so the existing DB gains districts + Peshawar rows on restart).

## v1.2 — Whole-website province pass (2026-11-04 evening, on his order)
- Hero now states the full coverage (Punjab 41 + KPK 38) and carries
  Punjab / KPK quick-switch chips; nav gained an All Districts link.
- City selects everywhere (rates, checker, trend, admin snapshot) are grouped
  by province; admin gained an "Add new district" form (province select).
- Copy corrected site-wide: today's note, cheapest note, checker fallback
  note, footer (Peshawar survey named). Rate-less districts show empty
  honestly, never estimated. Tests 26 -> 28, all passing.

## Live status 2026-11-04 ~20:05 PKT (verified by direct check)
- LIVE now: v1.1 — Punjab 41 + KPK 38 districts, Peshawar retail
  (2026-11-02, source brecorder-survey), Nowshera honestly empty,
  districts section, grouped selects. Live container auto-deployed from
  the GitHub push (commit 6207e5a) — SnapDeploy has NO redeploy button
  (only Restart, which re-runs the old image).
- NOT live yet: v1.2 polish (hero province chips, admin district form,
  corrected copy; commits c608ed57 + 76061927). Blocked on SnapDeploy
  free tier: 5/5 deploys used in this 12h window, resets ~08:00 PKT
  2026-11-05. On reset, trigger a deploy (push or dashboard) and verify
  the homepage contains id="provinceChips".

## v2.0 — All-Pakistan + live API + daily refresh (2026-11-04 evening, on his order)
- All 170 districts seeded: Punjab 41, KPK 38, Sindh 30, Balochistan 36
  (2023 list; 2026 splits not seeded, addable via admin), ICT 1,
  Gilgit-Baltistan 14 (2019 notification), AJK 10. Live DB holds 171
  locations because Karachi's retail list is a separate city, not a district.
- Province-first selection everywhere a city is picked (hero, checker,
  trend, admin snapshot): province select first, district select shows only
  that province's districts. Default Punjab / Lahore; checker defaults
  Sindh / Karachi. Old grouped single-select removed.
- Public no-key JSON API: /api/provinces, /api/districts?province=,
  /api/live, plus existing /api/meta, /api/today, /api/movers, /api/history,
  /api/cheapest, /api/check. Docs at public/api.html, linked from footer.
- Daily refresh POST /api/admin/refresh (master code only, 30-min minimum
  interval unless force=true): fetches the live AMIS GridView table with
  node:http, parses it with regex (lib/amis.js), upserts wholesale rows for
  the current PKT date + yesterday with source 'amis'. Verified live
  2026-11-04: 528 inserted, 82 updated, 478 skipped (AMIS market towns not
  in the district list), second call correctly answered too-soon.
  Crop mapping: exact, then parenthetical variant, then X/Y split, then
  first-word match; unmatched crops become new kg items (Banana -> dozen).
- Karachi retail auto-refresh NOT built: its source page uses Roman-Urdu
  names with no reliable English mapping and no verifiable date — manual
  admin entry stays, stated in README.
- Tests 28 -> 46, all passing on a fresh DB, including a parser unit test
  on a fixture snippet and an unavailable-service detection test.
