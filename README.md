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
- **All of Pakistan**: 168 districts in 7 groups — Punjab (41), Khyber
  Pakhtunkhwa (36), Sindh (30), Balochistan (36), Islamabad Capital Territory
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
- **Automatic daily update (v2.1)**: the site refreshes itself — no manual
  step. On startup, and on every visit to the homepage rates or `/api/live`,
  it checks in the background whether today's AMIS rates are already in;
  if not (or the last good refresh is over 6 hours old) it fetches the AMIS
  page and upserts it, at most one attempt every 30 minutes. This matters
  because the free host sleeps the container after ~15 minutes idle, so a
  timer alone could never be trusted — the refresh rides on wake-up and
  visits instead. The homepage shows one honest freshness line from
  `/api/live`: “Rates updated: <date> • Source: AMIS Pakistan” when the
  stored date is today or yesterday, otherwise “Rates from <date> — today's
  update pending”. A failed fetch never deletes or blanks stored rates —
  the last good data stays up. `/api/live` also reports `last_refresh_at`,
  `last_refresh_attempt_at`, `rates_date` and `source`.
- **Nearest rates (v2.2)**: when a district has no published rates yet
  (e.g. Nowshera), the page shows its province hub's latest rates instead
  — Punjab→Lahore, KPK→Peshawar, Sindh→Karachi, Balochistan→Quetta,
  ICT→Islamabad, Gilgit-Baltistan→Gilgit, AJK→Muzaffarabad — clearly
  labelled "Nowshera has no published rates yet — nearest rates: Peshawar,
  <date>". The fallback fires only when the hub's rates are dated today or
  yesterday; a stale hub or a hub with no rates leaves the district honestly
  empty. The API carries `nearest_rates_from` and `nearest_rates_date`
  (both null on a district's own rates), and the requested district name is
  never changed. This is a fallback, not the district's own rates.
- **Verified seeds (v2.3)**: 25 more districts gained real rates from
  dated, checkable sources — AMIS ViewPrices potato (05-11-2026, 23
  markets, FQP stored as the rate with the Min–Max range in the row
  source), PBS weekly SPI retail averages (week ended 22 Oct 2026,
  labelled weekly, never shown as daily), Daily Qudrat Islamabad list
  (29 Oct 2026, 8 items), poultryrates.today chicken (05 Nov 2026,
  Mansehra + Abbottabad, retail live Rs 415/kg). Coverage is now 36 of
  169 locations with ≥1 real item. Two flagged AMIS outliers (Kot Adu
  FQP 3350, Sarialamgir FQP 5100) were deliberately NOT seeded, so
  Muzaffargarh and Gujrat stay without own rows — they show the labelled
  Lahore fallback instead. Nowshera still has no source anywhere and
  stays honestly empty.

- **Categories + Urdu units (v3.0)**: every item has a category —
  vegetables (سبزیاں), fruits (پھل), other (chicken → other/پولٹری). The
  public flow is province → district → category → a table sorted by Urdu
  name, then price. Every row shows the unit in Urdu — کلو for kg, درجن
  for dozen — plus the rate, the date and the source. Banana stays dozen;
  everything else is kg unless the source says otherwise.
- **District rate-admins (v3.0)**: the master admin creates per-district
  rate-admin accounts (username + password, scrypt-hashed, district
  assigned at creation; never self-registration, never seeded). A district
  admin adds/edits rates for their own district only — any other district
  is a server-side 403. Every entry needs item, price, unit, source name
  and date, and is labelled with source + date. Login page + small panel
  at `district-admin.html`. The master keeps all existing powers.
- **Licensed district-head admins / official districts (v3.1, 2026-11-05)**:
  for the public launch, each district can have ONE head — the government
  officer who manages that district's rates (for example the District
  Food Controller). Accounts start INACTIVE; the master activates them,
  and from that moment the district is OFFICIAL: only its head can enter
  its rates, and the master's own direct rate entries for it are rejected
  (403) with a clear message. The public district page shows "Officially
  managed by &lt;designation&gt;, &lt;district&gt;" — designation and district
  only; the officer's personal name and document numbers are never shown
  publicly and never appear in any public API response (they live in the
  master console only). The master can suspend a head — login is blocked
  immediately, every live session ends at once, and the district stops
  being official so the master can step back in — or reactivate them
  later. Every district-admin action (create, activate, suspend, rate
  add/delete, review propose/decide, password change/reset) is written
  to a master-only audit log with the acting officer's designation and
  primary document reference. Strict security stays: scrypt hashes, 24h
  bearer tokens, 5-failed-login / 15-minute lockout, real server-side
  logout, cross-district access 403, and a district admin can never list
  admins or read the audit log.
  - **Appointment documents, not licences (v3.2, 2026-11-05)**:
    government officers do NOT hold a commercial licence. Their authority
    is an appointment letter, a posting / transfer order (official
    notification), a service card, a Market Committee authorisation, or a
    CNIC — recorded as structured documents (document type, document
    number, issuing authority, issue date, expiry date where applicable),
    never as a free-text "licence". The word "licence" belongs to
    businesses and dealers, not officers, so this app does not invent a
    licence scheme. The Market Committee (its Secretary) is the body that
    fixes daily mandi rates in Punjab, and market committees must upload
    arrival + prices to amis.pk.
  - **Honest limit — read this before going public:** there is NO public
    API that verifies a government appointment automatically. The master
    (Hashir) — or the district head, for managers — checks the paper
    document himself and records the reference. This app never claims to
    verify appointments with the government, and no code in it ever will
    pretend to. An account created before this change has no documents
    and stays INACTIVE until the documents are recorded and it is
    activated.
  - **Boundary, stated plainly:** the official rule covers the master's
    DIRECT rate entries (`POST /api/admin/snapshot`). The review queue
    stays the shared approval path — a proposal for an official district
    is approved by its licensed admin (or by the master as oversight);
    nothing reaches the public without an approval. The AMIS automatic
    refresh is a system process, not a master entry, so it keeps running
    for every district including official ones.
- **District managers (v3.2, 2026-11-05)**: the head of food manages the
  food managers of his district, who work under his order by government
  post. A manager is scoped to ONE district and, inside it, ONLY to the
  places (markets/areas) the head assigns them — never the whole district
  by default. Managers ENTER rates; they never publish them: a manager's
  rate submission goes into the review queue as a proposal and goes live
  only when the district head approves it (or the master, where no head
  exists yet). A manager can never approve anything — not even their own
  proposal — never appoint anyone, never list other districts' managers,
  and sees only their own proposals plus non-manager proposals for their
  own assigned places. The head lists, activates, suspends and
  re-assigns places for his own district's managers only; the master can
  do the same for any manager, and can create a manager ONLY for a
  district that has no head yet (bootstrap). Same strict security as
  heads: scrypt, 24h bearer token, 5-fail / 15-min lockout, real logout,
  accounts start inactive.
- **Registration + approval (v3.2, 2026-11-05)**: a head or a manager
  registers themselves through the public form at `register.html` — name,
  designation/post, district, and their appointment documents. The
  account stays PENDING until approved: a head is approved by the master,
  a manager by the head of their own district. A pending or rejected
  account can never log in, and login failures give the same generic
  error whether the account does not exist, is pending, or the password
  is wrong — no hint is ever leaked. The approver sees the documents;
  nobody else does. Approving a manager requires recording the head's
  written appointment order (`appointment_ref`). The master's direct
  creation of heads (and bootstrap managers) stays as a bootstrap path.
  - **Document scans**: a pending account may attach a scan of one of
    its documents (image JPG/PNG/WebP or PDF, max ~5MB, multipart upload
    in native Node, stored under `uploads/` with a random filename). The
    scan is served ONLY to the approving head (for managers) or the
    master (for heads) through an authenticated endpoint — never public,
    never to another district's head or manager. Honest limit: scans live
    on the container disk and are lost on redeploy; the recorded document
    details live in the account record, and a re-upload after a redeploy
    restores the scan. `uploads/` is git-ignored and never pushed.
- **Daily official rates-page photo (v3.3, 2026-11-05)**: a manager
  photographs the official rates page the government side publishes each
  day (for example the Market Committee / District Food Controller daily
  rate list) for one of their assigned places. The photo waits PENDING
  until the district head approves it; only APPROVED photos show to the
  public on the district page (latest approved photo per place, plus a
  small history of the last few days), with the date, source label and
  "Official rates page" caption. One approved photo per place per day; a
  new upload for the same place+date supersedes a still-pending one.
  Images only (JPG/PNG/WebP, max ~5MB), stored under `uploads/` with a
  random filename, recorded in the database (manager, district, place,
  date, source label, filename, status). The photo file is served on a
  public URL only once approved; before approval it is reachable only
  through the authenticated head/master endpoint. Licence scans stay
  separate and are NEVER public — the two upload types are separate
  tables, endpoints and rules. Honest limit: photos live on the container
  disk and are lost on redeploy (the recorded rates themselves are the
  durable data); a re-upload after a redeploy restores the photo.
- **AMIS ViewPrices fetcher (v3.0)**: the refresh path also reads the
  AMIS wholesale price database (`ViewPrices.aspx`, per commodity, per
  date) and maps markets to districts from the verified table — Min/Max/FQP
  in Rs/100kg, source "AMIS ViewPrices (Min X–Max Y Rs/100kg)". A market
  value far outside the day's range is never auto-seeded; it goes to the
  review queue instead.
- **Review queue (v3.0, v3.2)**: proposed rates (ViewPrices outliers,
  morning AI-search candidates, district-admin drafts, manager entries)
  sit PENDING with item, district, place, price, unit, source, date and
  proposed-by. A district head or the master approves or rejects; only
  approved rows show to the public. Managers see only their own proposals
  plus non-manager proposals for their own assigned places; heads see
  only their own district. Endpoints are documented in `api.html`.
- **Morning AI search (v3.0, runbook `scripts/morning-ai-search.md`)**:
  a daily routine executed by hasho's morning job — NOT by code inside
  the sleeping container. It checks district market committees' official
  Facebook pages first, then Google, then AMIS ViewPrices, then
  poultryrates.today for chicken. Facebook honesty note: Facebook is
  login-walled and blocks scrapers — there is no scraper in the app and
  never one; only publicly visible, dated posts are used, and a candidate
  with no dated source is not a candidate. Candidates enter the review
  queue, never straight onto the site.
- **Grounded rate chat (v3.0)**: ask in plain English or Urdu ("tomato
  rate in Peshawar?", "پیاز کا ریٹ نوشہرہ میں؟") — POST `/api/chat` plus
  the chat box on the homepage, 24/7. The answer comes ONLY from the app's
  own rates database (rate, Urdu unit, date, source) or says plainly "no
  rate found for that item/district", plus the labelled nearest-rates
  fallback when one exists. It never invents a price, never guesses, and
  never presents a fallback rate as the district's own. No LLM, no key,
  free forever. Optional upgrade: if `OPENAI_API_KEY` is ever set, the chat
  may use it to understand the question only — the NUMBER always still
  comes from the database; with no key, grounded answers only.
- **District-list correction (v3.0, 2026-11-05)**: two entries that are
  not districts — Bari Swat (part of Swat) and Paharpur (a tehsil of
  D.I. Khan) — were removed from the district list. The list is now 168
  districts (KPK 36, not 38); 169 locations including Karachi. Neither
  entry had any rates, so coverage (36 locations with rates) is unchanged.

## Data (seeded 2026-11-04, real and sourced; v2.3 additions 2026-11-05)
- **AMIS Pakistan, Daily Wholesale Price Commodity Change** — wholesale
  Rs/100kg for 3 Nov (yesterday) and 4 Nov 2026 (today), 11 cities, 68 item rows.
- **Commissioner Karachi official vegetable price list, 4 Nov 2026** — bazaar /
  mandi / auction rates per kg for 14 items.
- **Business Recorder Peshawar retail market survey, 2 Nov 2026** — retail
  rates for 13 items in Peshawar (a survey, not an official list; the two
  printed ranges, Green Chilli and Banana at Rs 100–150, are stored as the
  midpoint Rs 125 and labelled as such).
- **AMIS ViewPrices wholesale database, 05-11-2026** — potato FQP
  Rs/100kg for 23 markets in 13 Punjab districts (12 of them new);
  market name stored as the variant, Min–Max range in the row source.
- **PBS Sensitive Price Indicator, week ended 22 Oct 2026** — weekly
  retail averages per kg for tomato/onion (+ potato/garlic where
  published) in 9 new districts: Bannu, Sialkot, Bahawalpur, Hyderabad,
  Sukkur, Larkana, Quetta, Khuzdar, Islamabad. Labelled weekly everywhere.
- **Daily Qudrat Islamabad list, 29 Oct 2026** — 8 retail items per kg.
- **poultryrates.today, 05 Nov 2026** — chicken retail live Rs 415/kg
  in Mansehra and Abbottabad, notified by the KP Market Committee.
- History starts with these two days and grows with every snapshot added.
  Two points make a line, not a forecast — the trend strengthens daily.

## Stack (same as Ciral / FoodScope)
Node.js 24+, native `node:http` + `node:sqlite`, zero dependencies.
Port 3030 (`PORT` env), SQLite file `data/mandi.sqlite` (`DB_FILE` env),
WAL mode. Admin code: `ADMIN_CODE` env is REQUIRED — the app refuses
to start without it. Set a long random value on your host; never commit
it to the repo.

## Run
```sh
node server.js          # http://127.0.0.1:3030
node test.js            # 175 checks on fresh DBs (all must pass)
```

## Honest limits
- No official government API exists for mandi rates — this API serves the
  app's own database; it does not claim to be official.
- The daily refresh reads the public AMIS page and can break if AMIS changes
  its table layout; manual admin entry remains the fallback. AMIS publishes
  on its own schedule, so a “today” refresh depends on AMIS having published
  today's page — if it has not, the site keeps yesterday's rates and says
  so on the homepage instead of claiming freshness. Karachi retail
  is manual only: its source page mixes Roman-Urdu names with no reliable
  English mapping, so auto-parsing it was deliberately not built.
- Retail official rates currently cover Karachi only; Peshawar retail comes
  from a dated press survey, and every other district shows wholesale only
  (or nothing yet) until its rates are added.
- Coverage is partial by design: of the 36 locations with rates, only the
  original 13 have multi-item daily rates. The 23 new ones have 1–4 items
  (potato-only via AMIS ViewPrices, 2–4 items via weekly PBS, chicken-only
  via poultryrates). The nearest-rates fallback remains the honest cover
  for the other 133 locations.
- No district's rates are invented: districts without a snapshot show an
  explicit "no rates recorded yet" message.
- Balochistan uses the 36-district 2023 list; 2026 splits (Quetta East/West,
  Wadh, Tump, Barshore, North/South Dera Bugti) are not seeded — add them
  via the admin district form when their status is confirmed.
- AMIS direction icons were ignored: direction is computed from the change
  value itself, because the icons on the source page are inconsistent.
- No SMS/WhatsApp alerts yet — that is a later step, not claimed here.
- Government appointments are not verified by any public API: the master
  (for heads) or the district head (for managers) checks the paper
  document and records the reference. Uploaded document scans and
  rates-page photos live on the container disk and are lost on redeploy;
  the recorded document details and rates are the durable data, and a
  re-upload after a redeploy restores the file.

## Quality / UX notes (v3.1–v3.3, 2026-11-05)

Every screen follows the same rules: one form per job (no multi-step
mazes), plain-language labels and error messages that say what went wrong
and what to do (never a bare error code), every action confirms success
or explains the failure (no silent nothing-happens), no dead ends (every
page has a way back or a next step), mobile-first like the rest of the app
(44px touch targets, 16px fonts, tables scroll at 360px), same header,
buttons and colours as the existing pages. A flow that needs more than 3
taps to finish its one job is simplified. Each phase (registration,
licence upload, scoped places, photo upload, approval flows) was tested
on a fresh database and reviewed once more before the next phase began;
the full suite (`node test.js`, 327 checks) passes 3x in a row, a 48-step
fresh-DB smoke walk of every journey (public visitor, manager, head,
master) passes, and a 46-attempt security pass (auth bypass, upload
abuse, IDOR, lockout, scan privacy, public-surface leaks) passes.

## QA pass — sell-readiness (2026-11-05, after the v3.0 build)

A human-perspective audit walked every journey on a fresh local server
(Peshawar user, Nowshera user, chat in English + Urdu, district-admin
journey, review queue, logged-out visitor, mobile 360px, security
spot-checks, startup/health). 15 gaps were found and fixed; the suite
grew from 175 to 202 checks and passes green 3×, plus a 32/32 live
smoke walk on a fresh DB and a 3-minute fresh-DB soak.

Fixed (P0 — security / wrong data):
- Master code and district-admin tokens no longer travel in URL query
  strings (they landed in browser history, logs and referers). Master
  reads use the `X-Master-Code` header; district-admin calls use the
  `Authorization: Bearer` header. `admin.js` / `district-admin.js`
  updated; the old `?code=` / `?token=` URLs now return 403/401.
- The admin page no longer shows the default master code in a
  placeholder.
- Wholesale dozen bug: a district admin entering Banana 125/dozen was
  stored as 12,500 and shown as Rs 12,500/dozen (100× too high). The
  add path now stores kg as Rs/100kg (AMIS convention) and dozen
  as-is; the public table already divided correctly via `perUnit`.
  Convention (also in `public/api.html`): wholesale = Rs/100kg for kg
  items, Rs per dozen for dozen items — in every entry path (district
  admin, review queue, ViewPrices, AMIS refresh).
- Added `GET /health` → `{"ok":true}` (no DB, no auth) and an explicit
  `0.0.0.0` bind (Bijli v1.2 failed its deploy without these).

Fixed (P1 — sessions / honesty / completeness):
- Real server-side logout (`POST /api/district-admin/logout` — the
  token dies immediately; before, logging out only cleared browser
  storage and the token stayed valid 24h).
- District admins can change their own password; the master can reset
  one (`POST /api/admin/district-admin/reset-password`). Both end the
  account's other sessions. Expired sessions are pruned on login.
- Deleting a rate that does not exist (e.g. an AMIS row) now returns
  404 instead of a false "Deleted" message.
- Chat for an untracked item (e.g. "apple rate in Nowshera?") now says
  plainly the item is not tracked and lists the 28 tracked items,
  instead of asking "Which item?".
- My-rates display uses the row's own unit + Urdu unit (was hardcoded
  "/ kg" for every row).
- Homepage now has an About / How it works section (what it is, how
  to use it, where rates come from, who runs it: M. Hashir,
  mhkh3200@gmail.com).
- Review-queue dedupe key now includes kind + variant (a retail and a
  wholesale proposal for the same item/price are different entries).

Fixed (P2 — polish):
- `favicon.ico` (inline SVG) + `robots.txt` — no more 404s.
- Controls are 44px min-height, 16px font (mobile touch targets, no
  iOS zoom on focus). Tables already scroll horizontally at 360px.

Still open (not blocking the push):
- The nearest-rates freshness decision is still with Hashir: Nowshera
  shows empty today because Peshawar's only rates are the 2026-11-02
  survey (3 days old, outside the strict today/yesterday rule). He can
  relax the window (show 2 Nov rates, labelled with the date) or keep
  it strict (empty until fresh Peshawar rates arrive).
- The two excluded AMIS potato outliers (Kot Adu FQP 3350,
  Sarialamgir FQP 5100) stay out of the seed; they wait in the review
  queue for a human decision — never auto-seeded.
- Before real public use / sale: set a private `ADMIN_CODE` on the
  container (there is no default — the app refuses to start without it)
  and create real district rate-admins (none seeded in production yet).
