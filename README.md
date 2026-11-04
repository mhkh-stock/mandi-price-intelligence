# Mandi Price Intelligence — منڈی ریٹ

Daily wholesale + official retail rates for Pakistan, with history, trends, spike
alerts and an overcharge checker. No estimates: every rate carries its source
and date.

## What it does
- **Today's rates** by city: wholesale per kg (per dozen for banana, as AMIS
  publishes) + official retail where an official list exists (Karachi).
- **Biggest movers**: top risers and fallers vs yesterday, per city.
- **Cheapest city**: compare wholesale per kg across all cities for any item.
- **Overcharge checker**: enter what you paid; verdict vs the official bazaar
  rate — fair, slightly above, or overcharged, with the exact difference.
- **Price trend chart**: history per item per city (canvas, no dependencies).
- **Verify flags**: any day-change of 40% or more is flagged "verify" — e.g.
  Kasur garlic +82.22% and Sahiwal garlic +84.76% on 2026-11-04 look like data
  jumps, not real market moves, and the app says so instead of hiding it.
- **Admin panel** (`admin.html`): add daily snapshots, new items and new
  districts; refresh live AMIS data with one button; history, movers and
  checker update themselves.
- **All of Pakistan**: 170 districts in 7 groups — Punjab (41), Khyber
  Pakhtunkhwa (38), Sindh (30), Balochistan (36), Islamabad Capital Territory
  (1), Gilgit-Baltistan (14), Azad Jammu and Kashmir (10) — plus Karachi's
  retail list as a separate city. Pick a province first, then only its
  districts are offered. Districts with no rates yet show honestly as empty
  — nothing is estimated or filled in meanwhile.
- **Public live API** (no key, see `api.html`): `/api/live`,
  `/api/provinces`, `/api/districts?province=…`, `/api/today`, `/api/movers`,
  `/api/history`, `/api/cheapest`, `/api/check`, `/api/meta`.
- **Daily refresh**: the admin panel pulls the public AMIS daily-changes
  page and upserts it as a new dated snapshot (wholesale, source “amis”,
  at most once every 30 minutes). Unknown AMIS market towns are skipped,
  never forced into the district list.

## Data (seeded 2026-11-04, real and sourced)
- **AMIS Pakistan, Daily Wholesale Price Commodity Change** — wholesale
  Rs/100kg for 3 Nov (yesterday) and 4 Nov 2026 (today), 11 cities, 68 item rows.
- **Commissioner Karachi official vegetable price list, 4 Nov 2026** — bazaar /
  mandi / auction rates per kg for 14 items.
- **Business Recorder Peshawar retail market survey, 2 Nov 2026** — retail
  rates for 13 items in Peshawar (a survey, not an official list; the two
  printed ranges, Green Chilli and Banana at Rs 100–150, are stored as the
  midpoint Rs 125 and labelled as such).
- History starts with these two days and grows with every snapshot added.
  Two points make a line, not a forecast — the trend strengthens daily.

## Stack (same as Ciral / FoodScope)
Node.js 24+, native `node:http` + `node:sqlite`, zero dependencies.
Port 3030 (`PORT` env), SQLite file `data/mandi.sqlite` (`DB_FILE` env),
WAL mode. Admin code: `ADMIN_CODE` env (default `mandi-admin`, demo-grade —
change it on deploy).

## Run
```sh
node server.js          # http://127.0.0.1:3030
node test.js            # 46 checks on a fresh DB (all must pass)
```

## Honest limits
- No official government API exists for mandi rates — this API serves the
  app's own database; it does not claim to be official.
- The daily refresh reads the public AMIS page and can break if AMIS changes
  its table layout; manual admin entry remains the fallback. Karachi retail
  is manual only: its source page mixes Roman-Urdu names with no reliable
  English mapping, so auto-parsing it was deliberately not built.
- Retail official rates currently cover Karachi only; Peshawar retail comes
  from a dated press survey, and every other district shows wholesale only
  (or nothing yet) until its rates are added.
- No district's rates are invented: districts without a snapshot show an
  explicit "no rates recorded yet" message.
- Balochistan uses the 36-district 2023 list; 2026 splits (Quetta East/West,
  Wadh, Tump, Barshore, North/South Dera Bugti) are not seeded — add them
  via the admin district form when their status is confirmed.
- AMIS direction icons were ignored: direction is computed from the change
  value itself, because the icons on the source page are inconsistent.
- No SMS/WhatsApp alerts yet — that is a later step, not claimed here.
