# Deploy — Mandi Price Intelligence

## Runtime

- **Node.js 24+** (`engines` in `package.json`). Native `node:http` +
  `node:sqlite` only — **zero dependencies, no build step, no `npm install`**.
- **Start command:** `node server.js` (or `npm start`, same thing).
- **Port:** `3030` by default (`PORT` env). The server binds `0.0.0.0`
  explicitly — a platform that cannot reach the app is usually a bind
  problem, not a port problem.
- **Health check:** `GET /health` returns `{"ok":true}` with no DB and no
  auth — safe for the platform's health probe even on a fresh,
  still-seeding database.

## Environment variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `ADMIN_CODE` | **Yes** | — (no default) | Master code. **Fail-closed:** the app refuses to start without it (`FATAL: ADMIN_CODE env var is required`). Set a long random value on the host; never commit it to the repo. |
| `PORT` | No | `3030` | HTTP listen port. |
| `DB_FILE` | No | `data/mandi.sqlite` (under the app dir) | SQLite file, WAL mode. Overrides the writable-dir fallback below. |
| `UPLOADS_DIR` | No | `uploads/` (under the app dir) | Licence scans + rates-page photos. **Set `/tmp/mandi-uploads` on the host** — see below. |
| `MANDI_AUTO_REFRESH` | No | on | Daily AMIS refresh on startup / wake-up. Set `0` to disable (tests do this). |
| `AMIS_URL` | No | `http://www.amis.pk/daily%20market%20changes.aspx` | Daily wholesale page the auto-refresh fetches. |
| `AMIS_VIEWPRICES_URL` | No | `http://www.amis.pk/ViewPrices.aspx?searchType=0&commodityId=21` | AMIS ViewPrices page (commodity 21 = Potato Fresh). |

## Writable-directory requirement

The app writes two things at runtime:

1. The SQLite database (`DB_FILE`, default `data/mandi.sqlite`).
2. Uploaded scans/photos (`UPLOADS_DIR`, default `uploads/`).

On a normal PC the app directory is writable and both stay exactly
where they were. On hosts with a **read-only app directory** (e.g.
SnapDeploy's `/app`) both move automatically to the OS temp dir —
`lib/writable.js`, same pattern as FoodScope — and the server logs:

```
Mandi data directory (read-only app dir fallback): /tmp/mandi-price-intelligence
```

with the DB at `/tmp/mandi-price-intelligence/data/mandi.sqlite` and
uploads at `/tmp/mandi-price-intelligence/uploads`. `DB_FILE` /
`UPLOADS_DIR` env vars still win over the fallback when set.

**Host settings (SnapDeploy, current host):**

- Set `UPLOADS_DIR=/tmp/mandi-uploads` explicitly — uploads must never
  go to the read-only app dir.
- Set `DB_FILE` to a persistent path if the host offers one; otherwise
  the temp-dir fallback applies and the database is lost when the
  container is recreated (rates are re-seeded from `seed-data.json`,
  but admin-added snapshots are not).
- Uploaded scans/photos live on the container disk and are **lost on
  redeploy** by design; the recorded document details and rates are the
  durable data, and a re-upload after a redeploy restores the file.

## Verify after deploy

```sh
curl https://<host>/health            # {"ok":true}
curl https://<host>/api/meta          # cities, provinces, items, latest_date
```

Then, in the browser: homepage loads, a district shows rates, and the
master admin login accepts `ADMIN_CODE` (sent as the `X-Master-Code`
header, never in a URL).

## Tests

```sh
node test.js   # full suite on fresh DBs in /tmp; must be green before any push
```
