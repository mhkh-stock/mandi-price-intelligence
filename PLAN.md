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
