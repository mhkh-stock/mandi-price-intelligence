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
- **Admin panel** (`admin.html`): add daily snapshots and new items; history,
  movers and checker update themselves.

## Data (seeded 2026-11-04, real and sourced)
- **AMIS Pakistan, Daily Wholesale Price Commodity Change** — wholesale
  Rs/100kg for 3 Nov (yesterday) and 4 Nov 2026 (today), 11 cities, 68 item rows.
- **Commissioner Karachi official vegetable price list, 4 Nov 2026** — bazaar /
  mandi / auction rates per kg for 14 items.
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
node test.js            # 18 checks on a fresh DB (all must pass)
```

## Honest limits
- Retail official rates currently cover Karachi only; other cities show
  wholesale until their official lists are added.
- AMIS direction icons were ignored: direction is computed from the change
  value itself, because the icons on the source page are inconsistent.
- No SMS/WhatsApp alerts yet — that is a v2 step, not claimed here.
