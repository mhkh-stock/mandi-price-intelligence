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
- All 41 Punjab districts + all 36 KPK districts listed, grouped by province
  (cities table gained a `province` column; old DBs migrate on startup,
  including the "RahimYarKhan" -> "Rahim Yar Khan" rename).
- Peshawar retail seeded from the dated Business Recorder survey (2026-11-02);
  Nowshera and all other rate-less districts show honestly empty.
- New admin endpoint POST /api/admin/city (code-gated) creates bare districts.
- Tests extended 18 -> 26, all passing on a fresh DB.
- Live update path: redeploy the SnapDeploy container (startup seeding is
  idempotent, so the existing DB gains districts + Peshawar rows on restart).

## v1.2 — Whole-website province pass (2026-11-04 evening, on his order)
- Hero now states the full coverage (Punjab 41 + KPK 36) and carries
  Punjab / KPK quick-switch chips; nav gained an All Districts link.
- City selects everywhere (rates, checker, trend, admin snapshot) are grouped
  by province; admin gained an "Add new district" form (province select).
- Copy corrected site-wide: today's note, cheapest note, checker fallback
  note, footer (Peshawar survey named). Rate-less districts show empty
  honestly, never estimated. Tests 26 -> 28, all passing.

## Live status 2026-11-04 ~20:05 PKT (verified by direct check)
- LIVE now: v1.1 — Punjab 41 + KPK 36 districts, Peshawar retail
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
- All 168 districts seeded: Punjab 41, KPK 36, Sindh 30, Balochistan 36
  (2023 list; 2026 splits not seeded, addable via admin), ICT 1,
  Gilgit-Baltistan 14 (2019 notification), AJK 10. Live DB holds 169
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

Redeploy trigger 2026-11-05 ~20:05 PKT — SnapDeploy auto-deploy after limit reset.

## v2.1 — Automatic daily live rates (2026-11-05 evening, on his order)
- The AMIS fetch+upsert logic moved out of the admin handler into one
  shared `runAmisRefresh()`; the admin endpoint (code-gated, 30-min
  minimum, same response shape) now just calls it.
- Automatic refresh: `maybeRefresh()` runs in the background on server
  startup and at the start of GET /api/today and /api/live. It fetches
  only when there are no AMIS rows dated today (PKT) or the last success
  is over 6 hours old, and only if the last attempt is over 30 minutes
  old. Meta keys `last_refresh` (success) and `last_refresh_attempt`
  (every attempt) are both recorded. A failed fetch never touches stored
  rates — last good data stays. No timer is used: the free host sleeps
  the container after ~15 min idle, so the refresh rides on wake-up and
  visits. Env overrides (tests only): `MANDI_AUTO_REFRESH=0` disables
  the automatic path, `AMIS_URL` points the fetch elsewhere.
- /api/live now also returns `last_refresh_at`, `last_refresh_attempt_at`,
  `rates_date` and `source: "AMIS Pakistan (amis.pk)"` (nothing else
  changed in its shape). Homepage shows one freshness line from it:
  "Rates updated: <date> • Source: AMIS Pakistan" when the date is today
  or yesterday, otherwise "Rates from <date> — today's update pending".
- Tests 46 -> 65, all passing on fresh DBs: stale data triggers exactly
  one fixture fetch and lands today's rates; fresh data triggers none;
  a 500 from the source leaves all old rows intact and rates_date
  unchanged; the admin endpoint still works through the shared function.
  The fixture is a local HTTP server standing in for amis.pk, so tests
  never touch the real network.

## v2.2 — Nearest-rates fallback (2026-11-05 evening, on his order)
- Problem: Nowshera (and most districts) show nothing — no published,
  dated rate list exists for them, and the rule is never to invent rates.
  Fix: when a district has no rates rows, /api/today shows its province
  hub's latest rates instead, clearly labelled — never relabelled as the
  district's own. Hub map: Punjab→Lahore, KPK→Peshawar, Sindh→Karachi,
  Balochistan→Quetta, ICT→Islamabad, Gilgit-Baltistan→Gilgit,
  AJK→Muzaffarabad.
- Rule: the fallback fires ONLY when the hub actually has rates dated
  today or yesterday (PKT). A stale hub (Peshawar's 2026-11-02 survey
  once it ages out) or a hub with no rates at all (Quetta) leaves the
  district honestly empty. The API carries `nearest_rates_from` and
  `nearest_rates_date` (both null on a district's own rates); the
  requested district name is never changed. /api/movers passes the same
  labels through. The homepage shows one line next to the rates:
  "<district> has no published rates yet — nearest rates: <hub>, <date>".
- Limit (honest): this is a fallback, not the district's own rates — and
  it only fires while the hub is fresh. Peshawar's only current data is
  the 2026-11-02 survey, so until a fresh Peshawar snapshot lands (daily
  AMIS refresh if AMIS lists Peshawar, or an admin entry), Nowshera still
  shows empty — with the reason visible, not silently wrong.
- Tests 65 -> 72, all passing on fresh DBs (suite run green 3 times):
  Nowshera falls back to fresh Peshawar rates, labelled; Lahore returns
  its own rates with no fallback flag; Khuzdar stays honestly empty
  (hub Quetta has none); a stale hub gives no fallback; the v2.1
  auto-refresh checks all still pass untouched.

## v2.3 — Verified seeds: 13 -> 36 districts with real rates (2026-11-05 evening)
- Source: ~/workspace/new-projects/kpk-punjab-rates-research.md (read fully
  first). Seeded ONLY what it verifies; nothing from its §8 blacklist
  (daatacenter, Numbeo, kfoods Quetta, Scribd KP lists, Bahawalpur May 2026
  list, irfarm) and nothing from the undated KP gap PDF.
- AMIS ViewPrices potato, dated 05-11-2026: 23 markets seeded as wholesale
  rows (FQP in Rs/100kg, market name as variant, Min–Max range recorded in
  the row source, e.g. "AMIS ViewPrices (Min 10000–Max 13000 Rs/100kg)").
  Multi-market districts keep every market row (Khanewal 3, Lodhran 3,
  Vehari 2, Toba Tek Singh 2, Jhelum 2, Dera Ghazi Khan 2). Cheapest potato
  that day: Hafizabad Rs 97.50/kg.
- PBS weekly SPI, week ended 22 Oct 2026: tomato/onion (+ potato/garlic
  where published) for the 9 NEW districts only — Bannu, Sialkot,
  Bahawalpur, Hyderabad, Sukkur, Larkana, Quetta, Khuzdar, Islamabad.
  Stored as retail_bazaar per kg with source "PBS weekly retail average,
  week ended 22 Oct 2026" — never shown as a daily rate. Islamabad also
  got the Daily Qudrat 8-item list (29 Oct 2026), which is its latest
  snapshot; the PBS rows stay in history with their own date.
- Chicken, 05-11-2026: Mansehra + Abbottabad, retail live Rs 415/kg,
  source "poultryrates.today, notified by KP Market Committee". New item
  "Chicken" (چکن) added to the items list.
- COUNT CORRECTION (read this before quoting 38): the research file's
  "38/171" assumed the two AMIS outliers were seeded. The brief explicitly
  excludes them — Kot Adu (FQP 3350, Muzaffargarh) and Sarialamgir (FQP
  5100, Gujrat) sit far below every other market that day (~9,800–13,500)
  and are unverified — so Muzaffargarh and Gujrat gain NO own rows and the
  honest final count is **36/169, not 38**: Punjab 25/41, KPK 4/36, Sindh
  4/31, Balochistan 2/36, ICT 1/1, GB 0/14, AJK 0/10. The 12 (not 14) new
  potato districts are Vehari, Toba Tek Singh, Khanewal, Pakpattan,
  Lodhran, Dera Ghazi Khan, Rajanpur, Jhelum, Mianwali, Chakwal,
  Hafizabad, Khushab. "D.G. Khan" in the research table was mapped to the
  app's canonical district name "Dera Ghazi Khan" (same district — no new
  city was created). The two outlier districts show only the labelled
  Lahore fallback on /api/today (their own history is empty).
- Nowshera: still NO rows — no source exists anywhere; the v2.2 fallback
  covers it (once Peshawar gets a fresh snapshot) and nothing was invented.
- Seeding mechanism: new arrays in seed-data.json + one idempotent block
  in server.js (runs every start, INSERT OR IGNORE, like the Peshawar
  block) — existing deployed DBs gain the rows on restart. The v2.1
  auto-refresh (source 'amis') and v2.2 fallback logic are untouched.
- Baseline test updates (forced by the new seed, not regressions):
  /api/live latest 2026-11-04 -> 2026-11-05, with-rates 13 -> 36;
  cheapest-tomato check replaced (no tomato wholesale rows on 05-11, so
  cheapest tomato is empty that day; cheapest potato is Hafizabad 97.50);
  the Khuzdar/Quetta honest-empty checks moved to Skardu/Gilgit (Khuzdar
  and Quetta now have PBS rows of their own); fail-server rates_date
  2026-11-04 -> 2026-11-05.
- Tests 72 -> 106, all passing on fresh DBs (suite run green 4 times),
  plus a live-server smoke test: /api/live 36 with rates, Nowshera
  honestly empty, Vehari 2 potato rows, Bannu PBS label, Mansehra
  chicken 415, Muzaffargarh Lahore-fallback only, cheapest potato
  Hafizabad 97.50.

## v3.0 — Categories + district rate-admins + ViewPrices fetcher + review queue + grounded chat (2026-11-05 evening, on his order)
- Flow: province → district → category (Vegetables / Fruits / other) →
  table sorted by Urdu name, then price. `category` on every item in
  seed-data.json (28 items: 23 vegetables, 4 fruits, 1 other — Chicken).
  Units in Urdu on every row: کلو kg, درجن dozen (Banana dozen, everything
  else kg unless the source says otherwise). `/api/today?category=`
  filters (400 on a bad value); `/api/meta` items carry category + unit.
- District rate-admins: master creates per-district accounts (scrypt hash,
  timing-safe verify, 24h bearer token, 5-fail/15-min lockout; never
  self-registration, never seeded). Own district only — server-side 403 on
  any other district. Entries need item, price, unit, source name, date;
  labelled with source + date. `district-admin.html` login + panel; master
  keeps all powers. District admins can only delete rows carrying the
  district-admin source marker — AMIS/PBS/survey rows are never touched.
- AMIS ViewPrices fetcher (`lib/viewprices.js`): enumerates commodity IDs
  from the AMIS dropdown (per-<select> classification, so the market select
  is never mistaken for commodities), fetches each commodity per date, maps
  markets → districts from the verified table, stores Min/Max/FQP
  (Rs/100kg) with source "AMIS ViewPrices (Min X–Max Y Rs/100kg)".
  Outliers (median rule: <0.5× or >2× the day's median, ≥5 values) never
  auto-seed — they go to the review queue. Real page structure observed:
  "Commodity: Potato Fresh", "Dated:05-11-2026", 7-col GridView, "-" = no
  data; no-param page returns HTTP 500. "Noshehrawirkan" is Nowshera Virkan
  (Gujranwala), NOT Nowshera KPK — deliberately unmapped. No KP market
  exists in AMIS.
- Review queue: PENDING proposals (item, district, price, unit, source,
  date, proposed-by); district admin or master approves/rejects; only
  approved rows show to the public. Dedupes pending duplicates. District
  admins see/decide only their own district.
- Morning AI search: runbook `scripts/morning-ai-search.md` — executed by
  hasho's morning job, NOT by code in the sleeping container. Official
  Facebook pages first, then Google, AMIS ViewPrices, poultryrates.today.
  Facebook honesty note: login-walled, blocks scrapers, no scraper in the
  app and never one; only publicly visible, dated posts; candidates enter
  the review queue, never straight onto the site.
- Grounded rate chat: POST /api/chat + homepage chat box, 24/7, English +
  Urdu item/district names. Answers ONLY from the app's own rates database
  (rate, Urdu unit, date, source) or "no rate found"; labelled
  nearest-rates fallback when one exists. Never invents a price, never
  guesses, never presents a fallback as the district's own. No LLM, no key.
  Optional upgrade documented in README: OPENAI_API_KEY may be used to
  understand the question only — the NUMBER always comes from the database.
- DISTRICT-LIST CORRECTION (2026-11-05, found by the Bijli QA pass):
  "Bari Swat" (part of Swat, not a district) and "Paharpur" (a tehsil of
  D.I. Khan, not a district) were removed from the KPK list in
  seed-data.json. The list is now **168 districts (KPK 36, not 38); 169
  locations including Karachi**. Neither entry had any rates rows, so
  coverage is unchanged (36 with rates; KPK 4/36). The v1.1–v2.3 log
  entries above that said "38 KPK districts" / "170 districts" / "171
  locations" were corrected in place for the same reason — the earlier
  number counted the two fake entries. (The v2.3 note quoting the research
  file's "38/171" is a quote of that file's figure, kept as the record of
  what was corrected.) Checked: no seed rows, no hub-map entry, no chat
  district name, no test fixture referenced either name; /api/live and
  /api/provinces counts are computed from the DB, so they correct
  themselves on reseed.
- Tests: 175 checks total (91 baseline + 67 v3.0 incl. the 2 district-list
  checks + 17 v2.1), all passing on fresh DBs, suite run green 3 times
  consecutively. Covers: category split + filtered tables, chat
  known/Urdu/fallback/no-rate cases, district-admin create/login/403s/
  validation/lockout, review queue propose/dedupe/scope/reject/approve,
  ViewPrices parser + fixture integration (5 seeded, 1 quarantined,
  1 unmapped), homepage + district-admin page + api docs. Note: one run
  crashed at the v2.1 auto-refresh section — a flaky port-3041 race
  (leftover test server from a crashed run lingers briefly; waitReady can
  even pass against the zombie before the bind fails), NOT an app bug;
  wait a few seconds and re-run.
- NOT pushed: deploy budget is 5/5 used; next window ~08:15 PKT Fri
  2026-11-06. The Mandi push (v2.1 + v2.2 + v2.3 + v3.0 + this correction)
  waits on the window and on Hashir's freshness-window answer.

## 2026-11-05 ~23:20 PKT — master code made private (fail-closed)
- The hardcoded fallback default master code is gone from the repo: server.js
  now reads `ADMIN_CODE` from the environment only and exits(1) with a FATAL
  message if it is unset. No default exists anywhere in the code, tests, UI
  or README. Anyone copying the project from GitHub gets no working code.
- Tests use a test-only code via `TEST_ADMIN_CODE` env (default
  `test-admin-code`, never a real value) and pass it to all four server
  spawns. README states ADMIN_CODE is REQUIRED and must never be committed.
- Verified: fail-closed run exits 1 with FATAL when unset, starts normally
  when set; suite 327 checks ALL TESTS PASSED 3x. The real private code is
  set only as an env var on the host (SnapDeploy) by Hashir — never in the repo.

## 2026-11-05 night — v3.1 licensed district-head model + v3.2–v3.3 manager layer (done, NOT pushed yet)
- Hashir's order: "when it goes publish, the head of the concerned
  district manages the rates for that specific district, district-wise
  admins, no admin can access another district's account, login with
  strict security with their specific role from the govt side, and their
  licence is what lets them enter as admin" — then refined: the head of
  food manages the district's food managers, who work under his order by
  govt post and log in as managers only. Research (mandi-govt-roles-
  research.md): government officers do NOT hold a commercial licence —
  authority is an appointment letter + posting/transfer order + service
  card + CNIC; the Market Committee (Secretary) fixes daily mandi rates
  and must upload arrival + prices to amis.pk. The licence section was
  rebuilt around these REAL documents — no invented licence scheme.
- v3.1 LICENSED DISTRICT HEAD: district admins carry officer_name,
  designation, licence_ref and issuing_authority (all mandatory at
  creation); accounts start INACTIVE, only the master activates them.
  A district with an ACTIVE licensed head is OFFICIAL — only that head
  can enter its rates; the master's direct entries (POST
  /api/admin/snapshot) are rejected 403. Public page shows "Officially
  managed by <designation>, <district>" (designation + district only;
  officer name and licence number never public, never in any public API
  response). Master can suspend (login blocked at once, all sessions
  ended, district stops being official) and reactivate. One head per
  district (second admin for the same district → 409). Audit log
  (master-only) records every district-admin action with designation +
  licence_ref. Strict security kept: scrypt, 24h bearer token,
  5-fail/15-min lockout, real logout, cross-district 403, admins can
  never list admins or read the audit log. HONEST LIMIT: no public API
  verifies a government appointment — the master checks the paper
  document himself and records the reference. Boundary: the official
  rule covers direct master entries only; the review queue stays the
  shared approval path, and the AMIS automatic refresh keeps running.
  Tests: 202 → 236 checks, green 4x in a row; fresh-DB smoke 15/15.
- v3.2 MANAGER LAYER: manager role, one district, places scoped by the
  head only. Managers enter rates ONLY through the review queue; nothing
  goes live until the head approves it (master approves only where no
  head exists). A manager can never approve anything, appoint anyone, or
  see another district/manager's data. Head appoints/activates/suspends/
  sets places for his own managers; master can create a manager ONLY for
  a headless district (bootstrap) + assign its places. Same strict
  security as heads (scrypt, 24h token, 5-fail/15-min lockout, real
  logout, start inactive).
- REGISTRATION + APPROVAL: head/manager register via public form
  (register.html) — name, designation, district, documents — account
  stays PENDING; head approved by master, manager by own-district head.
  Pending/rejected can never log in (same generic 401, no existence
  leak). Approving a manager requires recording the head's appointment
  order. Master direct creation stays as bootstrap.
- LICENCE DOCUMENTS + SCAN UPLOAD: structured fields (type dropdown:
  Appointment Letter / Posting-Transfer Order / Service Card / Market
  Committee Authorisation / CNIC / Other, number, issuing authority,
  issue/expiry dates; CNIC must be 13 digits) in a new
  account_documents table; licence_ref stores the primary document
  reference; official status requires an ACTIVE head AND ≥1 document.
  Scans: multipart upload in native Node (image/PDF, max ~5MB, stored
  under uploads/ with a random filename), served ONLY to the approver
  through an authenticated endpoint — never public, never to another
  district.
- SCOPED PLACES: place field on proposals/snapshots/my-rates;
  assigned_places on the manager account (head sets/changes, own
  district only; master sets for bootstrap managers); manager
  proposes/uploads only for assigned places (403 otherwise); manager
  queue view shows only own proposals + non-manager proposals for own
  places.
- DAILY OFFICIAL RATES-PAGE PHOTO (v3.3): manager uploads a daily photo
  of the official rates page for an assigned place (JPG/PNG/WebP ≤5MB,
  uploads/ random filename, recorded in rates_photos with
  manager/district/place/date/source label/status); head approves or
  rejects; only APPROVED photos show publicly on the district page
  (latest per place + last ~10 history, with date + source label +
  "Official rates page" caption); one approved photo per place per date;
  a new upload supersedes a still-pending one for the same place+date.
  Scans and photos are separate tables/endpoints — scans NEVER go public.
- UI: new register.html/js + manager.html/js; district-admin page gains
  managers (appoint/list/activate/suspend/places/pending approvals/scan
  viewer) + photo approval queue; admin page gains pending-registration
  approval + documents viewer and a documents-based create-head form;
  homepage shows the district's approved photos; api.html documents
  every new endpoint. .gitignore added: uploads/ + data/ + *.sqlite are
  never pushed. HONEST LIMITS: scans/photos live on the container disk
  and are lost on redeploy (the recorded details/rates are the durable
  data); set UPLOADS_DIR=/tmp/mandi-uploads on SnapDeploy.
- PRIVATE FAIL-CLOSED ADMIN_CODE (2026-11-05 ~23:20 PKT): the hardcoded
  fallback default master code is gone — server.js reads ADMIN_CODE from
  the environment only and exits(1) with a FATAL message if it is unset.
  No default exists anywhere in the code, tests, UI or README. Tests use
  a test-only code via TEST_ADMIN_CODE env. The real private code is set
  only as an env var on the host (SnapDeploy) — never in the repo.
- VERIFICATION (all on fresh DBs, local only): full suite `node test.js`
  = 327 checks, ALL TESTS PASSED, 3x in a row. Fresh-DB smoke walk
  48/48 (public visitor, manager, head, master — registration, approval,
  scan, proposal, photo, suspension, bootstrap). Dedicated security pass
  46/46: no-token 401s, manager token on head/master endpoints 403,
  wrong-district head 403s, master code in URL → 403, expired/forged
  token 401, traversal filenames ignored, .php/non-image/oversize/
  missing-file uploads rejected, scan privacy (other head 403, same-
  district other manager 403, guessed scan filename 404), IDOR on every
  id/username, lockout 5 fails → 429 + same generic 401 for nonexistent/
  wrong-password/pending accounts, public surface free of officer names/
  doc numbers/appointment refs, malformed JSON → clean 400 with no stack
  trace, unknown route → 404 with no stack trace.
- NOT pushed yet: v3.1 + v3.2 + v3.3 + QA fixes + fail-closed code all
  wait in the combined morning push (deploy budget 5/5 on the night of
  2026-11-05; next window ~08:15 PKT Fri 2026-11-06).

## 2026-11-06 morning — seed refresh to 2026-11-06 AMIS rates (push-gate repair)
- The suite failed its push gate (325/327): Muzaffargarh and Gujrat
  showed no labelled Lahore fallback because the Lahore seed rates were
  dated 2026-11-04 — two days old — and the strict fallback rule only
  allows hub rates dated today or yesterday. The rule was NOT changed.
- AMIS published 2026-11-06 data this morning (daily-changes page, 337
  rows, 26 cities; ViewPrices potato page "Dated:06-11-2026"). The seed
  was refreshed from that page with the app's own parser: 52 new
  wholesale rows dated 2026-11-06 for the 6 cities AMIS published
  (Lahore 7, Rawalpindi 11, Okara 8, Sahiwal 14, Layyah 2, Rahim Yar
  Khan 10). The other 5 seed cities (Faisalabad, Gujranwala, Multan,
  Sargodha, Kasur) were NOT published today, so their real 2026-11-04
  rows were KEPT — never invented, never re-dated. Seed rows now carry
  their own per-row date; the loader seeds `today` on that date and
  `yesterday` the day before, and rows accumulate like production
  (a refresh never deletes older rows, so history and old city rates
  stay). Wholesale rows: 68 → 120. Lahore tomato is now 175.00/kg
  (2026-11-06, AMIS), cheapest potato Okara 23.50, cheapest tomato
  Sahiwal 148.50. Tests updated to the new real values only (327 checks,
  ALL TESTS PASSED 3x); the two fallback checks pass again.

## 2026-11-06 — nav redesign live (Register + Log in buttons, designed kebab menu, role portals, Back to home)
