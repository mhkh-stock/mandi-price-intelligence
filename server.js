// Mandi Price Intelligence — daily wholesale + official retail rates for Pakistan,
// with history, trends, spike alerts and an overcharge checker.
// Node.js 24+, native node:http + node:sqlite only. No external dependencies.
// Port 3030. Data: AMIS wholesale (Rs/100kg, per dozen for banana) + Commissioner
// Karachi official retail list. Every rate carries its source and date; nothing is
// estimated. Admin gate is a shared code from env ADMIN_CODE — required,
// no default: the app refuses to start without it. Never commit a code.
// v2: all 168 districts of Pakistan (7 province/territory groups), province-first
// selection, a public no-key JSON API, and a daily AMIS refresh endpoint.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { parseAmisHtml, mapCrop } = require('./lib/amis');
const {
  parseViewPricesHtml, marketToDistrict, normalizeMarket, guessCategory,
  isOutlier, viewPricesUrl,
} = require('./lib/viewprices');

const PORT = Number(process.env.PORT || 3030);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'mandi.sqlite');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_CODE = process.env.ADMIN_CODE;
if (!ADMIN_CODE) { console.error('FATAL: ADMIN_CODE env var is required — set a private code, there is no default.'); process.exit(1); }
const FLAG_THRESHOLD = 40; // |% change| at or above this is flagged "verify"

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS cities (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name_en TEXT NOT NULL UNIQUE,
  name_ur TEXT NOT NULL DEFAULT '', unit TEXT NOT NULL DEFAULT 'kg',
  category TEXT NOT NULL DEFAULT 'vegetables'
);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  city_id INTEGER NOT NULL REFERENCES cities(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  variant TEXT NOT NULL DEFAULT '',
  place TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  wholesale REAL,
  retail_bazaar REAL,
  retail_mandi REAL,
  retail_auction REAL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(city_id, item_id, variant, date, source)
);
-- v3.0: per-district rate admins (created by master only, never seeded).
-- v3.1 (licensed district-head model): each admin carries the officer's
-- name, designation, licence reference and issuing authority. The licence
-- is checked by the MASTER against the paper document at creation — there
-- is no public API that verifies a government licence automatically, and
-- this app never claims otherwise. Accounts start INACTIVE and must be
-- activated by the master; a district with an ACTIVE licensed admin is
-- OFFICIAL and its rates are managed only by that admin.
CREATE TABLE IF NOT EXISTS district_admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  district TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'head',
  officer_name TEXT NOT NULL DEFAULT '',
  designation TEXT NOT NULL DEFAULT '',
  licence_ref TEXT NOT NULL DEFAULT '',
  issuing_authority TEXT NOT NULL DEFAULT '',
  appointed_by TEXT NOT NULL DEFAULT '',
  appointment_ref TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  assigned_places TEXT NOT NULL DEFAULT '[]',
  active INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL DEFAULT 'master',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS district_admin_sessions (
  token TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  district TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
-- v3.2: appointment documents — the REAL credentials of a government
-- officer. Officers hold no commercial licence: their authority is an
-- appointment letter, a posting/transfer order, a service card, a Market
-- Committee authorisation, or their CNIC. One account may hold several
-- documents; a scan (image/PDF) may be attached to each. Scans live on
-- the container disk (lost on redeploy) and are served only to the
-- approver — never public, never to another district. There is no public
-- API that verifies a government appointment; the approver checks the
-- paper document and records the reference.
CREATE TABLE IF NOT EXISTS account_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  doc_number TEXT NOT NULL,
  issuing_authority TEXT NOT NULL DEFAULT '',
  issue_date TEXT NOT NULL DEFAULT '',
  expiry_date TEXT NOT NULL DEFAULT '',
  scan_path TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- v3.1: audit log — every district-admin action records the acting
-- admin's designation + licence reference, so the master can see WHO
-- (which licensed officer) did WHAT, in which district. Master-only.
CREATE TABLE IF NOT EXISTS district_admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  district TEXT NOT NULL,
  designation TEXT NOT NULL DEFAULT '',
  licence_ref TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- v3.0: review queue — proposed rates sit PENDING until a district admin
-- or the master approves them; only approved rows show to the public.
CREATE TABLE IF NOT EXISTS review_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item TEXT NOT NULL,
  district TEXT NOT NULL,
  price REAL NOT NULL,
  unit TEXT NOT NULL DEFAULT 'kg',
  kind TEXT NOT NULL DEFAULT 'retail',
  variant TEXT NOT NULL DEFAULT '',
  place TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,
  date TEXT NOT NULL,
  proposed_by TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_by TEXT,
  decided_at TEXT
);
-- v3.3: daily official rates-page photos. A manager photographs the
-- official rates page published by the government side (Market Committee
-- / District Food Controller daily rate list) for one of their assigned
-- places. The photo waits PENDING until the district head approves it;
-- only APPROVED photos are ever public. Licence scans live in
-- account_documents and are NEVER public — the two upload types are
-- separate tables, separate endpoints, separate rules.
CREATE TABLE IF NOT EXISTS rates_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  district TEXT NOT NULL,
  place TEXT NOT NULL,
  date TEXT NOT NULL,
  source_label TEXT NOT NULL DEFAULT 'Market Committee daily rate list',
  filename TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_by TEXT,
  decided_at TEXT
);
`);

// ---- migrations for databases created before provinces existed ----
try { db.exec('ALTER TABLE cities ADD COLUMN province TEXT DEFAULT \'\''); } catch { /* already there */ }
try { db.exec("ALTER TABLE items ADD COLUMN category TEXT NOT NULL DEFAULT 'vegetables'"); } catch { /* already there */ }
// v3.1 licensed-admin columns — accounts created before this change have
// no licence details and stay INACTIVE (active=0) until the master records
// their licence and activates them. That is deliberate: an unverified
// account must not manage a district's rates.
for (const col of [
  "ALTER TABLE district_admins ADD COLUMN officer_name TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE district_admins ADD COLUMN designation TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE district_admins ADD COLUMN licence_ref TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE district_admins ADD COLUMN issuing_authority TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE district_admins ADD COLUMN active INTEGER NOT NULL DEFAULT 0",
  // v3.2 district-manager role: managers share the admins table (same
  // scrypt / lockout / token machinery) and are told apart by role.
  "ALTER TABLE district_admins ADD COLUMN role TEXT NOT NULL DEFAULT 'head'",
  "ALTER TABLE district_admins ADD COLUMN appointed_by TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE district_admins ADD COLUMN appointment_ref TEXT NOT NULL DEFAULT ''",
  // v3.2: account status (pending/active/suspended/rejected) + assigned
  // places (managers) + place on rates/proposals.
  "ALTER TABLE district_admins ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'",
  "ALTER TABLE district_admins ADD COLUMN assigned_places TEXT NOT NULL DEFAULT '[]'",
  "ALTER TABLE review_queue ADD COLUMN place TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE snapshots ADD COLUMN place TEXT NOT NULL DEFAULT ''",
]) { try { db.exec(col); } catch { /* already there */ } }
// Legacy rows predate the status column: active ones were live accounts,
// inactive ones need (re-)activation either way — both stay inactive
// until the master or head activates them, which is the safe side.
try { db.exec("UPDATE district_admins SET status='active' WHERE active=1"); } catch {}
try { db.exec("UPDATE district_admins SET status='pending' WHERE active=0 AND status<>'rejected' AND status<>'suspended'"); } catch {}
db.prepare('CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)').run();
db.prepare('UPDATE cities SET name=? WHERE name=?').run('Rahim Yar Khan', 'RahimYarKhan');

function cityId(name, province) {
  db.prepare('INSERT OR IGNORE INTO cities(name, province) VALUES(?,?)').run(name, province || '');
  if (province) db.prepare('UPDATE cities SET province=? WHERE name=?').run(province, name);
  return db.prepare('SELECT id FROM cities WHERE name=?').get(name).id;
}
function itemId(en, ur, unit, category) {
  const cat = ['vegetables', 'fruits', 'other'].includes(category) ? category : 'vegetables';
  db.prepare('INSERT OR IGNORE INTO items(name_en, name_ur, unit, category) VALUES(?,?,?,?)').run(en, ur || '', unit || 'kg', cat);
  const row = db.prepare('SELECT id FROM items WHERE name_en=?').get(en);
  if (ur) db.prepare('UPDATE items SET name_ur=? WHERE id=?').run(ur, row.id);
  // Fill the category for items created before categories existed.
  db.prepare("UPDATE items SET category=? WHERE id=? AND (category IS NULL OR category='')").run(cat, row.id);
  return row.id;
}
// Urdu unit words shown on every public row: کلو (per kg), درجن (per dozen).
function unitUrdu(unit) {
  return unit === 'dozen' ? 'درجن' : 'کلو';
}

// ---- seed: real, sourced data (see seed-data.json; wholesale rows carry
// their own per-row dates, refreshed 2026-11-06 where AMIS published) ----
const seedCount = db.prepare('SELECT COUNT(*) c FROM snapshots').get().c;
if (seedCount === 0) {
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-data.json'), 'utf8'));
  for (const it of seed.items) itemId(it.en, it.ur, it.unit, it.category);
  const up = db.prepare(`INSERT OR IGNORE INTO snapshots
    (city_id, item_id, variant, date, wholesale, source) VALUES(?,?,?,?,?, 'amis')`);
  for (const w of seed.wholesale) {
    const ci = cityId(w.city);
    const ii = itemId(w.item, '', 'kg');
    // Per-row date: `today` is dated w.date (default 2026-11-04 for the
    // original rows), `yesterday` is the day before it. Rows accumulate —
    // a refresh never deletes older rows, so history and old city rates stay.
    const d = w.date || '2026-11-04';
    up.run(ci, ii, w.variant || '', dayBefore(d), w.yesterday);
    up.run(ci, ii, w.variant || '', d, w.today);
  }
  const upr = db.prepare(`INSERT OR IGNORE INTO snapshots
    (city_id, item_id, variant, date, retail_bazaar, retail_mandi, retail_auction, source)
    VALUES(?,?,?,?,?,?,?, 'commissioner-karachi')`);
  const khi = cityId('Karachi');
  for (const r of seed.retail_karachi_2026_11_04) {
    upr.run(khi, itemId(r.item, '', 'kg'), r.variant || '', '2026-11-04', r.bazaar, r.mandi, r.auction);
  }
  const SOURCES = seed.sources;
  db.prepare('CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)').run();
  db.prepare('INSERT OR REPLACE INTO meta(k, v) VALUES(?, ?)').run('sources', JSON.stringify(SOURCES));
}

// ---- idempotent: provinces + every district + Peshawar retail (runs every start,
// so databases seeded before this expansion gain the new districts too) ----
{
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-data.json'), 'utf8'));
  // v3.0: backfill categories for items created before categories existed.
  for (const it of seed.items || []) {
    db.prepare("UPDATE items SET category=? WHERE name_en=? AND (category IS NULL OR category='')")
      .run(['vegetables', 'fruits', 'other'].includes(it.category) ? it.category : 'vegetables', it.en);
  }
  for (const [prov, list] of Object.entries(seed.provinces || {})) {
    for (const d of list) cityId(d, prov);
  }
  cityId('Karachi', 'Sindh');
  const psh = cityId('Peshawar', 'Khyber Pakhtunkhwa');
  const upP = db.prepare(`INSERT OR IGNORE INTO snapshots
    (city_id, item_id, variant, date, retail_bazaar, source) VALUES(?,?,?,?,?, 'brecorder-survey')`);
  for (const r of seed.retail_peshawar_2026_11_02 || []) {
    upP.run(psh, itemId(r.item, '', 'kg'), r.variant || '', '2026-11-02', r.bazaar);
  }
}

// ---- v2.3 verified seeds (runs every start, idempotent): AMIS ViewPrices
// potato 2026-11-05 (23 markets; FQP stored as wholesale Rs/100kg, market
// name as variant, Min–Max range in the source), PBS weekly SPI retail
// averages week ended 2026-10-22, Daily Qudrat Islamabad list 2026-10-29,
// poultryrates.today chicken 2026-11-05. Two flagged AMIS outliers
// (Kot Adu FQP 3350, Sarialamgir FQP 5100) are deliberately NOT seeded —
// they sit far below every other market that day and are unverified.
// Research: ~/workspace/new-projects/kpk-punjab-rates-research.md
{
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-data.json'), 'utf8'));
  const upV = db.prepare(`INSERT OR IGNORE INTO snapshots
    (city_id, item_id, variant, date, wholesale, source) VALUES(?,?,?,?,?,?)`);
  for (const w of seed.wholesale_viewprices_2026_11_05 || []) {
    upV.run(cityId(w.district), itemId(w.item, '', 'kg'), w.market + ' market', '2026-11-05', w.fqp,
      `AMIS ViewPrices (Min ${w.min}–Max ${w.max} Rs/100kg)`);
  }
  const upR = db.prepare(`INSERT OR IGNORE INTO snapshots
    (city_id, item_id, variant, date, retail_bazaar, source) VALUES(?,?,?,?,?,?)`);
  for (const r of seed.retail_pbs_spi_2026_10_22 || []) {
    upR.run(cityId(r.district), itemId(r.item, '', 'kg'), '', '2026-10-22', r.retail_bazaar,
      'PBS weekly retail average, week ended 22 Oct 2026');
  }
  for (const r of seed.retail_islamabad_qudrat_2026_10_29 || []) {
    upR.run(cityId('Islamabad', 'Islamabad Capital Territory'), itemId(r.item, '', 'kg'), '', '2026-10-29', r.retail_bazaar,
      'Daily Qudrat Islamabad list, 29 Oct 2026');
  }
  for (const r of seed.retail_chicken_2026_11_05 || []) {
    upR.run(cityId(r.district), itemId('Chicken', 'چکن', 'kg'), '', '2026-11-05', r.retail_bazaar,
      'poultryrates.today, notified by KP Market Committee');
  }
}

function latestDate(cityName) {
  const row = cityName
    ? db.prepare(`SELECT MAX(date) d FROM snapshots s JOIN cities c ON c.id=s.city_id WHERE c.name=?`).get(cityName)
    : db.prepare('SELECT MAX(date) d FROM snapshots').get();
  return row ? row.d : null;
}
// Province hub for the nearest-rates fallback (v2.2): when a district has
// no published rates yet, the page shows its province hub's latest rates
// instead — clearly labelled as nearest rates, never as the district's own.
const PROVINCE_HUBS = {
  'Punjab': 'Lahore',
  'Khyber Pakhtunkhwa': 'Peshawar',
  'Sindh': 'Karachi',
  'Balochistan': 'Quetta',
  'Islamabad Capital Territory': 'Islamabad',
  'Gilgit-Baltistan': 'Gilgit',
  'Azad Jammu and Kashmir': 'Muzaffarabad',
};
function perUnit(value, unit) {
  if (value === null || value === undefined) return null;
  return unit === 'dozen' ? value : value / 100;
}
function rowsFor(cityName, date) {
  const rows = db.prepare(`
    SELECT i.name_en en, i.name_ur ur, i.unit unit, i.category category, s.variant variant, s.place place,
      s.wholesale w, s.retail_bazaar rb, s.retail_mandi rm, s.retail_auction ra, s.source source
    FROM snapshots s JOIN items i ON i.id = s.item_id JOIN cities c ON c.id = s.city_id
    WHERE c.name = ? AND s.date = ? ORDER BY i.name_en, s.variant`).all(cityName, date);
  return rows.map((r) => {
    const prev = db.prepare(`
      SELECT s.wholesale w FROM snapshots s JOIN items i ON i.id = s.item_id
      JOIN cities c ON c.id = s.city_id
      WHERE c.name = ? AND i.name_en = ? AND s.variant = ? AND s.date < ? AND s.wholesale IS NOT NULL
      ORDER BY s.date DESC LIMIT 1`).get(cityName, r.en, r.variant, date);
    const cur = perUnit(r.w, r.unit);
    const prv = prev ? perUnit(prev.w, r.unit) : null;
    const change = cur !== null && prv !== null && prv !== 0 ? ((cur - prv) / prv) * 100 : null;
    return {
      item: r.en, ur: r.ur, unit: r.unit, unit_ur: unitUrdu(r.unit), category: r.category || 'vegetables', variant: r.variant, place: r.place || '',
      wholesale_per_unit: cur === null ? null : Math.round(cur * 100) / 100,
      retail_bazaar: r.rb, retail_mandi: r.rm, retail_auction: r.ra, source: r.source,
      prev_wholesale_per_unit: prv === null ? null : Math.round(prv * 100) / 100,
      change_pct: change === null ? null : Math.round(change * 100) / 100,
      flag: change !== null && Math.abs(change) >= FLAG_THRESHOLD ? 'verify' : null,
    };
  });
}
// Nearest-rates fallback (v2.2, relaxed to 7 days on Hashir's order
// 2026-11-06): the province hub's rows, but ONLY when the hub's latest
// rates are at most 7 days old (PKT) — always date-labelled. A hub older
// than 7 days, or a hub with no rates at all, returns null — the district
// then stays honestly empty. Never invents rates and never relabels hub
// rates as the district's own.
const FALLBACK_MAX_AGE_DAYS = 7;
function nearestFallback(cityName) {
  const row = db.prepare('SELECT province FROM cities WHERE name=?').get(cityName);
  const hub = row ? PROVINCE_HUBS[row.province] : null;
  if (!hub || hub === cityName) return null;
  const hubDate = latestDate(hub);
  if (!hubDate) return null;
  const ageDays = daysOld(hubDate);
  if (ageDays < 0 || ageDays > FALLBACK_MAX_AGE_DAYS) return null;
  const rows = rowsFor(hub, hubDate);
  if (!rows.length) return null;
  return { from: hub, date: hubDate, rows };
}
function todayRows(cityName, category) {
  // Category tables are ordered alphabetically by Urdu name, then by price.
  const sortRows = (rows) => [...rows].sort((a, b) => {
    const byUr = (a.ur || a.item).localeCompare(b.ur || b.item, 'ur');
    if (byUr !== 0) return byUr;
    const pa = a.wholesale_per_unit ?? a.retail_bazaar ?? Infinity;
    const pb = b.wholesale_per_unit ?? b.retail_bazaar ?? Infinity;
    return pa - pb;
  });
  const applyCategory = (rows) => {
    const filtered = category ? rows.filter((r) => r.category === category) : rows;
    return sortRows(filtered);
  };
  const date = latestDate(cityName);
  if (!date) {
    const fb = nearestFallback(cityName);
    if (fb) return { date: fb.date, rows: applyCategory(fb.rows), nearest_rates_from: fb.from, nearest_rates_date: fb.date, official: officialFor(cityName) };
    return { date: null, rows: [], nearest_rates_from: null, nearest_rates_date: null, official: officialFor(cityName) };
  }
  return { date, rows: applyCategory(rowsFor(cityName, date)), nearest_rates_from: null, nearest_rates_date: null, official: officialFor(cityName) };
}
function movers(cityName, limit) {
  const { rows, nearest_rates_from, nearest_rates_date } = todayRows(cityName);
  const withChange = rows.filter((r) => r.change_pct !== null);
  const rises = [...withChange].sort((a, b) => b.change_pct - a.change_pct).slice(0, limit);
  const falls = [...withChange].sort((a, b) => a.change_pct - b.change_pct).slice(0, limit);
  return { rises, falls, nearest_rates_from, nearest_rates_date };
}
function history(itemEn, cityName) {
  return db.prepare(`
    SELECT s.date date, s.wholesale w, s.retail_bazaar rb, i.unit unit
    FROM snapshots s JOIN items i ON i.id = s.item_id JOIN cities c ON c.id = s.city_id
    WHERE i.name_en = ? AND c.name = ? ORDER BY s.date`).all(itemEn, cityName)
    .map((r) => ({
      date: r.date,
      wholesale_per_unit: r.w === null ? null : Math.round(perUnit(r.w, r.unit) * 100) / 100,
      retail_bazaar: r.rb,
    }));
}
function cheapest(itemEn) {
  const date = latestDate(null);
  if (!date) return { date: null, rows: [] };
  const rows = db.prepare(`
    SELECT c.name city, s.wholesale w, i.unit unit FROM snapshots s
    JOIN items i ON i.id = s.item_id JOIN cities c ON c.id = s.city_id
    WHERE i.name_en = ? AND s.date = ? AND s.wholesale IS NOT NULL
    ORDER BY s.wholesale ASC`).all(itemEn, date);
  return {
    date,
    rows: rows.map((r) => ({ city: r.city, per_unit: Math.round(perUnit(r.w, r.unit) * 100) / 100, unit: r.unit })),
  };
}

function provinceGroups() {
  const cities = db.prepare(`SELECT c.name name, c.province province,
    EXISTS(SELECT 1 FROM snapshots s WHERE s.city_id = c.id) has_rates
    FROM cities c ORDER BY c.province, c.name`).all();
  const provinces = [];
  for (const c of cities) {
    const prov = c.province || 'Other';
    let g = provinces.find((x) => x.name === prov);
    if (!g) { g = { name: prov, districts: [] }; provinces.push(g); }
    g.districts.push({ name: c.name, has_rates: !!c.has_rates });
  }
  return { cities, provinces };
}
function liveSummary() {
  const { provinces } = provinceGroups();
  const per_province = provinces.map((g) => ({
    name: g.name, districts: g.districts.length,
    with_rates: g.districts.filter((d) => d.has_rates).length,
  }));
  const lastOk = metaGet('last_refresh');
  const lastAttempt = metaGet('last_refresh_attempt');
  const officialDistricts = db.prepare(`SELECT COUNT(DISTINCT district) c FROM district_admins
    WHERE role='head' AND active=1 AND EXISTS (SELECT 1 FROM account_documents WHERE username=district_admins.username)`).get().c;
  return {
    latest_date: latestDate(null),
    rates_date: latestDate(null),
    last_refresh_at: lastOk ? new Date(Number(lastOk)).toISOString() : null,
    last_refresh_attempt_at: lastAttempt ? new Date(Number(lastAttempt)).toISOString() : null,
    source: 'AMIS Pakistan (amis.pk)',
    provinces: provinces.length,
    districts: per_province.reduce((a, g) => a + g.districts, 0),
    districts_with_rates: per_province.reduce((a, g) => a + g.with_rates, 0),
    official_districts: officialDistricts,
    per_province,
  };
}
// Pakistan calendar date (Asia/Karachi) as YYYY-MM-DD, plus the day before.
function pktToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function dayBefore(iso) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
// Whole days between an ISO date and today (PKT); negative if in the future.
function daysOld(iso) {
  return Math.round((Date.parse(pktToday() + 'T12:00:00Z') - Date.parse(iso + 'T12:00:00Z')) / 86400000);
}
function fetchText(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers: { 'User-Agent': 'Mandi-Price-Intelligence/2.0' } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; if (data.length > 5000000) req.destroy(new Error('response too large')); });
      res.on('end', () => resolve(data));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('fetch timeout')));
    req.on('error', reject);
  });
}

// ---- automatic daily AMIS refresh (v2.1) ----
// The free host sleeps the container after ~15 min idle, so a timer alone
// cannot be trusted: a refresh is attempted on startup and on every visit
// to /api/today or /api/live instead. It runs in the background and never
// blocks a visitor's response. A failed fetch never touches stored rates.
const AMIS_URL = process.env.AMIS_URL || 'http://www.amis.pk/daily%20market%20changes.aspx';
const AUTO_REFRESH = process.env.MANDI_AUTO_REFRESH !== '0';
const REFRESH_ATTEMPT_MIN_MS = 30 * 60 * 1000; // at most one attempt per 30 min
const REFRESH_STALE_MS = 6 * 60 * 60 * 1000;   // refresh if last success is older than 6h
let refreshInFlight = null;
function metaGet(k) {
  const row = db.prepare('SELECT v FROM meta WHERE k=?').get(k);
  return row ? row.v : null;
}
function metaSet(k, v) {
  db.prepare('INSERT OR REPLACE INTO meta(k, v) VALUES(?, ?)').run(k, v);
}

// Fetch the live AMIS daily-changes page and upsert it as a dated snapshot.
// Shared by the admin endpoint and the automatic path. Returns the same
// result shape the admin endpoint has always returned. Records an attempt
// on every try (meta last_refresh_attempt) and a success time only when
// rows were actually stored (meta last_refresh). Never deletes rows.
async function runAmisRefresh(options) {
  const opts = options || {};
  const fetchFn = opts.fetchFn || fetchText;
  metaSet('last_refresh_attempt', String(Date.now()));
  let html;
  try {
    html = await fetchFn(opts.url || AMIS_URL, 30000);
  } catch (e) {
    return { ok: false, reason: 'fetch-failed', detail: e.message };
  }
  let parsed;
  try {
    parsed = parseAmisHtml(html);
  } catch (e) {
    return { ok: false, reason: 'parse-failed', detail: e.message };
  }
  if (parsed.unavailable || parsed.rows.length === 0) {
    return { ok: false, reason: parsed.unavailable ? 'amis-unavailable' : 'no-rows-parsed' };
  }
  const date = pktToday();
  const prevDate = dayBefore(date);
  const itemNames = db.prepare('SELECT name_en FROM items').all().map((r) => r.name_en);
  const cityProv = new Map(db.prepare('SELECT name, province FROM cities').all().map((r) => [r.name, r.province]));
  const upsert = db.prepare(`INSERT INTO snapshots(city_id, item_id, variant, date, wholesale, source)
    VALUES(?,?,?,?,?, 'amis')
    ON CONFLICT(city_id, item_id, variant, date, source) DO UPDATE SET wholesale=excluded.wholesale`);
  const existsStmt = db.prepare(`SELECT 1 FROM snapshots s JOIN cities c ON c.id=s.city_id JOIN items i ON i.id=s.item_id
    WHERE c.name=? AND i.name_en=? AND s.variant=? AND s.date=? AND s.source='amis'`);
  let inserted = 0, updated = 0, skipped = 0;
  const unmatched = new Set();
  for (const row of parsed.rows) {
    if (!cityProv.has(row.city)) { skipped++; continue; }
    const mapped = mapCrop(row.crop, itemNames);
    if (mapped.isNew) unmatched.add(mapped.item);
    const unit = /banana/i.test(mapped.item) ? 'dozen' : 'kg';
    const ci = cityId(row.city, cityProv.get(row.city) || '');
    const ii = itemId(mapped.item, '', unit, guessCategory(mapped.item));
    if (!itemNames.includes(mapped.item)) itemNames.push(mapped.item);
    for (const [d, val] of [[date, row.today], [prevDate, row.yesterday]]) {
      if (existsStmt.get(row.city, mapped.item, mapped.variant, d)) updated++;
      else inserted++;
      upsert.run(ci, ii, mapped.variant, d, val);
    }
  }
  metaSet('last_refresh', String(Date.now()));
  return { ok: true, date, inserted, updated, skipped, unmatched_crops: [...unmatched].sort() };
}

// Is a refresh due? Yes when there are no AMIS rows dated today (PKT) or
// the last successful refresh is older than 6 hours — and only when the
// last attempt is more than 30 minutes ago.
function refreshDue() {
  if (!AUTO_REFRESH) return false;
  const today = pktToday();
  const hasToday = db.prepare("SELECT 1 FROM snapshots WHERE date=? AND source='amis' LIMIT 1").get(today);
  const lastOk = Number(metaGet('last_refresh') || 0);
  const stale = !hasToday || !lastOk || (Date.now() - lastOk > REFRESH_STALE_MS);
  if (!stale) return false;
  const lastAttempt = Number(metaGet('last_refresh_attempt') || 0);
  return !lastAttempt || (Date.now() - lastAttempt > REFRESH_ATTEMPT_MIN_MS);
}

// Fire-and-forget: start a background refresh when one is due. Never
// throws, never blocks the caller, never runs two fetches at once.
function maybeRefresh() {
  if (refreshInFlight) return;
  let due = false;
  try { due = refreshDue(); } catch { return; }
  if (!due) return;
  refreshInFlight = runAmisRefresh({}).catch(() => {}).finally(() => { refreshInFlight = null; });
}

// ---- v3.0: district rate-admins ----
// Passwords are hashed with scrypt (node:crypto, no dependency). Sessions
// are random bearer tokens, 24h expiry. District admins are created by the
// master only — never self-registration, never seeded — and can only touch
// THEIR district (every endpoint enforces it server-side, 403 otherwise).
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPTS = new Map(); // username -> { fails, lockedUntil }
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}
function makeSalt() {
  return crypto.randomBytes(16).toString('hex');
}
function verifyPassword(password, salt, hash) {
  try {
    const a = Buffer.from(hashPassword(password, salt), 'hex');
    const b = Buffer.from(hash, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { return false; }
}
function loginLocked(username) {
  const rec = LOGIN_ATTEMPTS.get(username);
  return !!rec && !!rec.lockedUntil && Date.now() < rec.lockedUntil;
}
function recordLoginFail(username) {
  const rec = LOGIN_ATTEMPTS.get(username) || { fails: 0, lockedUntil: 0 };
  rec.fails += 1;
  if (rec.fails >= LOGIN_MAX_FAILS) rec.lockedUntil = Date.now() + LOGIN_LOCK_MS;
  LOGIN_ATTEMPTS.set(username, rec);
}
function clearLoginFails(username) {
  LOGIN_ATTEMPTS.delete(username);
}
function districtAdminFromToken(token) {
  if (!token) return null;
  const row = db.prepare('SELECT username, district, expires_at FROM district_admin_sessions WHERE token=?').get(token);
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare('DELETE FROM district_admin_sessions WHERE token=?').run(token);
    return null;
  }
  // A suspended/inactive account's token dies with it — even a token issued
  // before the suspension stops working the moment the master suspends.
  const idn = adminIdentity(row.username);
  if (!idn || idn.active !== 1) {
    db.prepare('DELETE FROM district_admin_sessions WHERE token=?').run(token);
    return null;
  }
  return { username: row.username, district: row.district, role: idn.role || 'head', designation: idn.designation, licence_ref: idn.licence_ref, appointed_by: idn.appointed_by, appointment_ref: idn.appointment_ref };
}
function tokenFromReq(req, body) {
  // Bearer tokens travel in the Authorization header or the POST body —
  // never in a URL query string (query strings land in browser history,
  // server logs and referers, and a leaked token stays valid for 24h).
  const h = req.headers.authorization || '';
  if (h.startsWith('Bearer ')) return h.slice(7).trim();
  if (body && body.token) return String(body.token);
  return null;
}
// Master auth: the master code is accepted ONLY via the X-Master-Code
// header on GET endpoints (POST bodies may also carry it, as they always
// have). It must never travel in a URL query string.
function masterHeaderOk(req) {
  return req.headers['x-master-code'] === ADMIN_CODE;
}

// ---- v3.1: licensed district-head model ----
// A district is OFFICIAL when it has an ACTIVE licensed admin — one head
// per district, appointed by the master. Official status is derived, never
// stored: suspend the admin and the district stops being official, so the
// master can step back in. Public responses carry ONLY the designation +
// district (never the officer's name or licence number).
function officialFor(district) {
  if (!district) return null;
  // Official = an ACTIVE head whose appointment documents are on file.
  // (Officers hold no licence — the documents are the credential.)
  const row = db.prepare(`SELECT designation, district FROM district_admins
    WHERE district=? AND role='head' AND active=1
    AND EXISTS (SELECT 1 FROM account_documents WHERE username=district_admins.username)
    ORDER BY id LIMIT 1`).get(district);
  return row ? { designation: row.designation, district: row.district } : null;
}
function isOfficialDistrict(district) {
  return officialFor(district) !== null;
}
function adminIdentity(username) {
  const row = db.prepare(`SELECT username, district, role, officer_name, designation,
    licence_ref, issuing_authority, appointed_by, appointment_ref, active FROM district_admins WHERE username=?`).get(String(username || '').toLowerCase());
  return row || null;
}
// Audit log: every district-admin action records WHO (username + the
// licensed officer's designation + licence reference), WHERE (district)
// and WHAT. The licence details identify the officer in the log; they are
// master-only and never appear in a public response.
function logAdminAudit({ username, district, designation, licence_ref, action, detail }) {
  let d = designation, l = licence_ref;
  if ((d === undefined || l === undefined) && username) {
    const idn = adminIdentity(username);
    if (idn) { d = d ?? idn.designation; l = l ?? idn.licence_ref; }
  }
  db.prepare(`INSERT INTO district_admin_audit(username, district, designation, licence_ref, action, detail)
    VALUES(?,?,?,?,?,?)`).run(String(username || ''), String(district || ''), String(d || ''), String(l || ''), String(action || ''), String(detail || ''));
}
function isValidRateDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const d = new Date(String(s) + 'T12:00:00Z');
  if (Number.isNaN(d.getTime())) return false;
  return String(s) <= pktToday(); // never a future date
}

// ---- v3.2: appointment documents, registration + approval, places ----
// Government officers hold no commercial licence. Their authority is an
// appointment letter, a posting/transfer order, a service card, a Market
// Committee authorisation, or their CNIC. The "licence" section records
// those REAL documents — structured, never a free-text licence number.
// Research: ~/workspace/new-projects/mandi-govt-roles-research.md
const DOC_TYPES = ['Appointment Letter', 'Posting-Transfer Order', 'Service Card', 'Market Committee Authorisation', 'CNIC', 'Other'];
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch (e) { console.error('uploads dir unavailable:', e.message); }
function validDateStr(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const d = new Date(String(s) + 'T12:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === String(s);
}
// Validate a documents array from a registration / creation call. Returns
// { docs } (normalised) or { error }. One to five documents; every field
// checked — a registration with no documents at all is rejected outright.
function validateDocuments(docs) {
  if (!Array.isArray(docs) || docs.length === 0) return { error: 'at least one appointment document is required — appointment letter, posting/transfer order, service card, Market Committee authorisation, or CNIC' };
  if (docs.length > 5) return { error: 'at most 5 documents per account' };
  const out = [];
  for (const d of docs) {
    if (!d || typeof d !== 'object') return { error: 'each document needs doc_type, doc_number, issuing_authority and issue_date' };
    const docType = String(d.doc_type || '').trim();
    const docNumber = String(d.doc_number || '').trim();
    const authority = String(d.issuing_authority || '').trim();
    const issueDate = String(d.issue_date || '').trim();
    const expiryDate = String(d.expiry_date || '').trim();
    if (!DOC_TYPES.includes(docType)) return { error: 'doc_type must be one of: ' + DOC_TYPES.join(', ') };
    if (!docNumber) return { error: 'doc_number required for every document' };
    if (docNumber.length > 100) return { error: 'doc_number too long (max 100 chars)' };
    if (!authority) return { error: 'issuing_authority required for every document' };
    if (authority.length > 150) return { error: 'issuing_authority too long (max 150 chars)' };
    if (!validDateStr(issueDate)) return { error: 'issue_date must be a valid YYYY-MM-DD date' };
    if (issueDate > pktToday()) return { error: 'issue_date cannot be in the future' };
    if (expiryDate) {
      if (!validDateStr(expiryDate)) return { error: 'expiry_date must be a valid YYYY-MM-DD date' };
      if (expiryDate < issueDate) return { error: 'expiry_date cannot be before issue_date' };
    }
    if (docType === 'CNIC' && docNumber.replace(/\D/g, '').length !== 13) return { error: 'a CNIC document number must be 13 digits' };
    out.push({ doc_type: docType, doc_number: docNumber, issuing_authority: authority, issue_date: issueDate, expiry_date: expiryDate });
  }
  return { docs: out };
}
function insertDocuments(username, docs) {
  const ins = db.prepare('INSERT INTO account_documents(username, doc_type, doc_number, issuing_authority, issue_date, expiry_date) VALUES(?,?,?,?,?,?)');
  for (const d of docs) ins.run(username, d.doc_type, d.doc_number, d.issuing_authority, d.issue_date, d.expiry_date || '');
}
// The approver's view of an account's documents: type, number, authority
// and dates, plus whether a scan is attached — never the scan path, never
// the file itself (scans go through the authenticated scan endpoint).
function accountDocuments(username) {
  return db.prepare('SELECT id, doc_type, doc_number, issuing_authority, issue_date, expiry_date, (scan_path IS NOT NULL AND scan_path<>\'\') AS has_scan FROM account_documents WHERE username=? ORDER BY id').all(String(username || '').toLowerCase())
    .map((r) => ({ id: r.id, doc_type: r.doc_type, doc_number: r.doc_number, issuing_authority: r.issuing_authority, issue_date: r.issue_date, expiry_date: r.expiry_date, has_scan: !!r.has_scan }));
}
function hasDocuments(username) {
  const row = db.prepare('SELECT 1 FROM account_documents WHERE username=? LIMIT 1').get(String(username || '').toLowerCase());
  return !!row;
}
// "Appointment Letter #PPSC-2024-118" — the credential reference shown in
// the master console and the audit log. It is a document reference, never
// a licence: officers hold no licence.
function primaryDocRef(username) {
  const row = db.prepare('SELECT doc_type, doc_number FROM account_documents WHERE username=? ORDER BY id LIMIT 1').get(String(username || '').toLowerCase());
  return row ? `${row.doc_type} #${row.doc_number}` : '';
}
// The legacy licence_ref column now stores the primary document reference
// (kept so the master list and audit log keep working). Call it after any
// document insert for an account.
function syncPrimaryRef(username) {
  db.prepare('UPDATE district_admins SET licence_ref=? WHERE username=?').run(primaryDocRef(username), String(username || '').toLowerCase());
}
// Assigned places: the markets/areas inside a district a manager may work
// in. Stored as a JSON array on the account; the head sets it, the manager
// never sets their own.
function assignedPlaces(username) {
  const row = db.prepare('SELECT assigned_places FROM district_admins WHERE username=?').get(String(username || '').toLowerCase());
  if (!row || !row.assigned_places) return [];
  try {
    const arr = JSON.parse(row.assigned_places);
    return Array.isArray(arr) ? arr.filter((p) => typeof p === 'string') : [];
  } catch { return []; }
}
function validatePlaces(places) {
  if (!Array.isArray(places)) return { error: 'places must be an array of market/area names' };
  if (places.length > 20) return { error: 'at most 20 places per manager' };
  const seen = new Set();
  const out = [];
  for (const p of places) {
    const name = String(p || '').trim();
    if (!name) return { error: 'place names cannot be empty' };
    if (name.length > 100) return { error: 'place names are at most 100 characters' };
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push(name);
  }
  return { places: out };
}
function setAssignedPlaces(username, places) {
  db.prepare('UPDATE district_admins SET assigned_places=? WHERE username=?').run(JSON.stringify(places), String(username || '').toLowerCase());
}
// Minimal multipart/form-data parser (native Node, no dependency) for the
// scan upload: text fields as strings, file parts as Buffers. Rejects
// bodies over maxBytes with an error instead of buffering forever.
function parseMultipartBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const ct = req.headers['content-type'] || '';
    const m = ct.match(/multipart\/form-data;\s*boundary=(.+)$/);
    if (!m) return reject(new Error('not multipart'));
    const boundary = Buffer.from('--' + m[1].trim().replace(/^"|"$/g, ''));
    const chunks = [];
    let size = 0;
    let done = false;
    const fail = (e) => { if (!done) { done = true; reject(e); } };
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { req.destroy(); return fail(new Error('upload too large')); }
      chunks.push(c);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try {
        const body = Buffer.concat(chunks);
        const fields = {};
        const files = [];
        let start = 0;
        for (;;) {
          const bIdx = body.indexOf(boundary, start);
          if (bIdx === -1) break;
          const partStart = bIdx + boundary.length;
          if (body[partStart] === 45 && body[partStart + 1] === 45) break; // closing --boundary--
          const headEnd = body.indexOf('\r\n\r\n', partStart);
          if (headEnd === -1) break;
          const head = body.slice(partStart, headEnd).toString('utf8');
          const nextB = body.indexOf(boundary, headEnd + 4);
          if (nextB === -1) break;
          let data = body.slice(headEnd + 4, nextB - 2); // strip trailing CRLF
          const nameM = head.match(/name="([^"]*)"/);
          const fileM = head.match(/filename="([^"]*)"/);
          if (nameM && fileM && fileM[1]) {
            const typeM = head.match(/Content-Type:\s*([^\r\n]+)/i);
            files.push({ name: nameM[1], filename: fileM[1], contentType: (typeM ? typeM[1] : '').trim().toLowerCase(), data });
          } else if (nameM) {
            fields[nameM[1]] = data.toString('utf8');
          }
          start = nextB;
        }
        resolve({ fields, files });
      } catch (e) { reject(e); }
    });
    req.on('error', fail);
  });
}

// ---- v3.0: review queue ----
// Proposed rates sit PENDING until a district admin (own district) or the
// master approves them; only approved rows reach the public snapshots.
// proposeReview dedupes: the same item+district+price+source+date pending
// twice is one queue entry, not two.
function proposeReview(r) {
  const dup = db.prepare(`SELECT id FROM review_queue WHERE item=? AND district=? AND price=? AND source=? AND date=? AND kind=? AND variant=? AND place=? AND status='pending'`)
    .get(r.item, r.district, r.price, r.source, r.date, r.kind || 'retail', r.variant || '', r.place || '');
  if (dup) return { id: dup.id, duplicate: true };
  const info = db.prepare(`INSERT INTO review_queue(item, district, price, unit, kind, variant, place, source, date, proposed_by)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(r.item, r.district, r.price, r.unit || 'kg', r.kind || 'retail', r.variant || '', r.place || '', r.source, r.date, r.proposed_by);
  return { id: Number(info.lastInsertRowid), duplicate: false };
}
function approveReviewRow(row, decidedBy) {
  const ci = cityId(row.district);
  const ii = itemId(row.item, '', row.unit || 'kg');
  if (row.kind === 'wholesale') {
    db.prepare(`INSERT INTO snapshots(city_id, item_id, variant, date, wholesale, source, place)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(city_id, item_id, variant, date, source) DO UPDATE SET wholesale=excluded.wholesale, place=excluded.place`)
      .run(ci, ii, row.variant || '', row.date, row.price, row.source, row.place || '');
  } else {
    db.prepare(`INSERT INTO snapshots(city_id, item_id, variant, date, retail_bazaar, source, place)
      VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(city_id, item_id, variant, date, source) DO UPDATE SET retail_bazaar=excluded.retail_bazaar, place=excluded.place`)
      .run(ci, ii, row.variant || '', row.date, row.price, row.source, row.place || '');
  }
  db.prepare("UPDATE review_queue SET status='approved', decided_by=?, decided_at=datetime('now') WHERE id=?")
    .run(decidedBy, row.id);
}

// ---- v3.0: grounded rate chat (no LLM, free forever) ----
// Answers ONLY from this database — the rate, Urdu unit, date and source —
// or says plainly that no rate was found. It never invents a price, never
// guesses, and never presents a fallback rate as the district's own.
// Optional upgrade (README): if OPENAI_API_KEY is ever set, it may be used
// for understanding the question only; the NUMBER always comes from the DB.
function answerChat(q) {
  const raw = String(q || '').trim();
  const isUrdu = /[\u0600-\u06FF]/.test(raw);
  const lower = raw.toLowerCase();
  const ask = (msg) => ({ ok: true, found: false, answer: msg, item: null, district: null, rate: null, unit: null, unit_ur: null, date: null, source: null, nearest_rates_from: null, fallback: false });
  if (!raw) return ask(isUrdu ? 'Kisi sabzi ya phal ka rate poochhein, misal: "tomato rate in Lahore".' : 'Ask about a fruit or vegetable rate, e.g. "tomato rate in Lahore".');
  const items = db.prepare('SELECT name_en, name_ur, unit, category FROM items').all();
  const cities = db.prepare('SELECT name FROM cities').all().map((r) => r.name);
  // District names in Urdu script, for questions asked in Urdu
  // ("پیاز کا ریٹ نوشہرہ میں؟" must find Nowshera). Only the districts
  // people ask about most are listed; Latin names always work too.
  const URDU_DISTRICTS = {
    'لاہور': 'Lahore', 'کراچی': 'Karachi', 'پشاور': 'Peshawar', 'نوشہرہ': 'Nowshera',
    'اسلام آباد': 'Islamabad', 'راولپنڈی': 'Rawalpindi', 'فیصل آباد': 'Faisalabad',
    'ملتان': 'Multan', 'گوجرانوالہ': 'Gujranwala', 'سیالکوٹ': 'Sialkot',
    'سرگودھا': 'Sargodha', 'بہاولپور': 'Bahawalpur', 'کوئٹہ': 'Quetta',
    'حیدرآباد': 'Hyderabad', 'سکھر': 'Sukkur', 'لاڑکانہ': 'Larkana', 'بنوں': 'Bannu',
    'مانسہرہ': 'Mansehra', 'ایبٹ آباد': 'Abbottabad', 'خضدار': 'Khuzdar',
    'مردان': 'Mardan', 'چارسدہ': 'Charsadda', 'صوابی': 'Swabi', 'کوہاٹ': 'Kohat',
    'سوات': 'Swat', 'ڈیرہ غازی خان': 'Dera Ghazi Khan', 'ڈیرہ اسماعیل خان': 'Dera Ismail Khan',
    'جہلم': 'Jhelum', 'گجرات': 'Gujrat', 'چکوال': 'Chakwal', 'جھنگ': 'Jhang',
    'اوکاڑہ': 'Okara', 'قصور': 'Kasur', 'ساہیوال': 'Sahiwal', 'رحیم یار خان': 'Rahim Yar Khan',
    'شیخوپورہ': 'Sheikhupura', 'اٹک': 'Attock', 'ہری پور': 'Haripur', 'مری': 'Murree',
    'گلگت': 'Gilgit', 'سکردو': 'Skardu', 'مظفرآباد': 'Muzaffarabad', 'میرپور': 'Mirpur',
  };
  let district = null;
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [ur, en] of Object.entries(URDU_DISTRICTS)) {
    // Word-boundary match, so a short name never matches inside another word.
    if (new RegExp(`(?<![\u0600-\u06FF])${escRe(ur)}(?![\u0600-\u06FF])`).test(raw)) { district = en; break; }
  }
  if (!district) {
    for (const c of [...cities].sort((a, b) => b.length - a.length)) {
      if (lower.includes(c.toLowerCase())) { district = c; break; }
    }
  }
  let item = null;
  for (const it of [...items].sort((a, b) => (b.name_ur || '').length - (a.name_ur || '').length)) {
    if (it.name_ur && raw.includes(it.name_ur)) { item = it; break; }
  }
  if (!item) {
    for (const it of [...items].sort((a, b) => b.name_en.length - a.name_en.length)) {
      if (lower.includes(it.name_en.toLowerCase())) { item = it; break; }
    }
  }
  if (!item && !district) return ask(isUrdu ? 'Samajh nahi aaya. Kisi sabzi ya phal ka naam aur district batayein, misal: "Lahore mein tomato ka rate".' : 'I could not understand that. Please name a fruit or vegetable and a district, e.g. "tomato rate in Lahore".');
  if (!item) {
    // The district matched but the item did not: the user named something
    // we do not track (e.g. Apple) — say so plainly and list what we do
    // track, instead of asking "which item?" as if they had named none.
    const tracked = items.map((i) => i.name_en).join(', ');
    return ask(isUrdu
      ? `Woh cheez meri list mein nahi hai. ${district} mein main in cheezon ka rate bata sakta hoon: ${tracked}.`
      : `I don't track that item yet. In ${district} I can answer for: ${tracked}.`);
  }
  if (!district) return ask(isUrdu ? `${item.name_en} (${item.name_ur}) kis district mein? District ka naam batayein.` : `Which district for ${item.name_en}? Please name the district.`);
  const fmtRate = (r, src) => {
    const parts = [];
    if (r.wholesale_per_unit !== null && r.wholesale_per_unit !== undefined) parts.push(isUrdu ? `thok (wholesale) Rs ${r.wholesale_per_unit} fi ${unitUrdu(r.unit)}` : `wholesale Rs ${r.wholesale_per_unit} per ${unitUrdu(r.unit)}`);
    if (r.retail_bazaar !== null && r.retail_bazaar !== undefined) parts.push(isUrdu ? `bazaar retail Rs ${r.retail_bazaar} fi ${unitUrdu(r.unit)}` : `retail Rs ${r.retail_bazaar} per ${unitUrdu(r.unit)}`);
    return parts.join(isUrdu ? ' — ' : ' · ');
  };
  const drow = db.prepare(`SELECT MAX(s.date) d FROM snapshots s JOIN items i ON i.id=s.item_id JOIN cities c ON c.id=s.city_id WHERE i.name_en=? AND c.name=?`).get(item.name_en, district);
  if (drow && drow.d) {
    const rows = db.prepare(`SELECT s.wholesale w, s.retail_bazaar rb, s.source source, i.unit unit FROM snapshots s JOIN items i ON i.id=s.item_id JOIN cities c ON c.id=s.city_id WHERE i.name_en=? AND c.name=? AND s.date=?`).all(item.name_en, district, drow.d);
    const best = rows.find((r) => r.rb !== null && r.rb !== undefined) || rows.find((r) => r.w !== null && r.w !== undefined) || rows[0];
    if (best && (best.w !== null || best.rb !== null)) {
      const r = { wholesale_per_unit: best.w === null ? null : Math.round(perUnit(best.w, best.unit) * 100) / 100, retail_bazaar: best.rb, unit: best.unit };
      const main = r.retail_bazaar !== null && r.retail_bazaar !== undefined ? r.retail_bazaar : r.wholesale_per_unit;
      const answer = isUrdu
        ? `${district} mein ${item.name_en} (${item.name_ur}): ${fmtRate(r)} — tareekh ${drow.d}, source: ${best.source}.`
        : `${item.name_en} in ${district}: ${fmtRate(r)} — dated ${drow.d}, source: ${best.source}.`;
      return { ok: true, found: true, answer, item: item.name_en, district, rate: main, unit: best.unit, unit_ur: unitUrdu(best.unit), date: drow.d, source: best.source, nearest_rates_from: null, fallback: false };
    }
  }
  // No own rate: the labelled nearest-rates fallback, never as the district's own.
  const fb = nearestFallback(district);
  if (fb) {
    const fr = fb.rows.find((r) => r.item === item.name_en);
    if (fr) {
      const main = fr.retail_bazaar !== null && fr.retail_bazaar !== undefined ? fr.retail_bazaar : fr.wholesale_per_unit;
      const answer = isUrdu
        ? `${district} mein ${item.name_en} (${item.name_ur}) ka apna rate abhi nahi hai. Nazdeek tareen ${fb.from} ka rate: ${fmtRate(fr)} — tareekh ${fb.date}, source: ${fr.source}. Yeh ${fb.from} ka rate hai, ${district} ka nahi.`
        : `No rate of its own for ${item.name_en} in ${district} yet. Nearest rates (${fb.from}): ${fmtRate(fr)} — dated ${fb.date}, source: ${fr.source}. This is ${fb.from}'s rate, not ${district}'s.`;
      return { ok: true, found: true, answer, item: item.name_en, district, rate: main, unit: fr.unit, unit_ur: unitUrdu(fr.unit), date: fb.date, source: fr.source, nearest_rates_from: fb.from, fallback: true };
    }
  }
  // Nothing on file anywhere (not even a fresh hub fallback): say so plainly,
  // naming the item and district — but never a price.
  return {
    ok: true, found: false,
    answer: isUrdu
      ? `${district} mein ${item.name_en} (${item.name_ur}) ka koi rate abhi maujood nahi hai. Kisi aur district ya item ka poochhein.`
      : `No rate found for ${item.name_en} in ${district} yet. Try another district or item.`,
    item: item.name_en, district, rate: null, unit: item.unit, unit_ur: unitUrdu(item.unit),
    date: null, source: null, nearest_rates_from: null, fallback: false,
  };
}

// ---- v3.0: AMIS ViewPrices fetcher ("all govt rates through APIs") ----
// Reads the AMIS wholesale price database (ViewPrices.aspx, ~140 markets),
// enumerates its commodity dropdown, maps markets to districts, and stores
// Min/Max/FQP per market. The existing daily-changes refresh is untouched.
// Outliers never auto-seed: they go to the review queue instead.
const VIEWPRICES_URL = process.env.AMIS_VIEWPRICES_URL || viewPricesUrl(21);
const VP_MAX_COMMODITIES = 30;
let vpInFlight = null;
async function runViewPricesRefresh(options) {
  const opts = options || {};
  const fetchFn = opts.fetchFn || fetchText;
  const baseUrl = opts.url || VIEWPRICES_URL;
  metaSet('last_viewprices_attempt', String(Date.now()));
  let baseHtml;
  try {
    baseHtml = await fetchFn(baseUrl, 30000);
  } catch (e) {
    return { ok: false, reason: 'fetch-failed', detail: e.message };
  }
  const itemNames0 = db.prepare('SELECT name_en FROM items').all().map((r) => r.name_en);
  let parsed;
  try {
    parsed = parseViewPricesHtml(baseHtml, { itemNames: itemNames0 });
  } catch (e) {
    return { ok: false, reason: 'parse-failed', detail: e.message };
  }
  if (parsed.unavailable) return { ok: false, reason: 'amis-unavailable' };
  let commodities = (parsed.commodities || []).filter((c) => c && c.id);
  if (!commodities.length) commodities = [{ id: 21, name: 'Potato Fresh' }];
  if (!commodities.some((c) => c.id === 21)) commodities.unshift({ id: 21, name: 'Potato Fresh' });
  commodities = commodities.slice(0, VP_MAX_COMMODITIES);
  const date = parsed.date || pktToday();
  const itemNames = db.prepare('SELECT name_en FROM items').all().map((r) => r.name_en);
  const districtNames = db.prepare('SELECT name FROM cities').all().map((r) => r.name);
  const upsert = db.prepare(`INSERT INTO snapshots(city_id, item_id, variant, date, wholesale, source)
    VALUES(?,?,?,?,?,?)
    ON CONFLICT(city_id, item_id, variant, date, source) DO UPDATE SET wholesale=excluded.wholesale`);
  const existsStmt = db.prepare(`SELECT 1 FROM snapshots s JOIN cities c ON c.id=s.city_id JOIN items i ON i.id=s.item_id
    WHERE c.name=? AND i.name_en=? AND s.variant=? AND s.date=? AND s.source=?`);
  let inserted = 0, updated = 0, quarantined = 0, skipped = 0;
  const unmatchedMarkets = new Set();
  const unmatchedCrops = new Set();
  for (const com of commodities) {
    // The base page IS commodity 21's page — reuse it instead of refetching.
    let page = parsed;
    if (com.id !== 21) {
      try {
        const html = await fetchFn(viewPricesUrl(com.id), 30000);
        page = parseViewPricesHtml(html, { itemNames });
      } catch { continue; }
      if (page.unavailable) continue;
    }
    const markets = page.markets || [];
    const fqps = markets.map((m) => m.fqp).filter((v) => v !== null && v !== undefined);
    const commodityName = page.commodity || com.name;
    const mapped = mapCrop(commodityName, itemNames);
    if (mapped.isNew) unmatchedCrops.add(mapped.item);
    const unit = /banana/i.test(mapped.item) ? 'dozen' : 'kg';
    for (const mk of markets) {
      if (mk.fqp === null || mk.fqp === undefined) { skipped++; continue; }
      const district = marketToDistrict(mk.market, districtNames);
      if (!district) { unmatchedMarkets.add(mk.market); skipped++; continue; }
      const source = `AMIS ViewPrices (Min ${mk.min}–Max ${mk.max} Rs/100kg)`;
      const variant = normalizeMarket(mk.market) + ' market';
      if (isOutlier(mk.fqp, fqps)) {
        proposeReview({
          item: mapped.item, district, price: mk.fqp, unit: 'kg', kind: 'wholesale',
          variant, source, date, proposed_by: 'amis-viewprices',
        });
        quarantined++;
        continue;
      }
      const ci = cityId(district);
      const ii = itemId(mapped.item, '', unit, guessCategory(mapped.item));
      if (!itemNames.includes(mapped.item)) itemNames.push(mapped.item);
      if (existsStmt.get(district, mapped.item, variant, date, source)) updated++;
      else inserted++;
      upsert.run(ci, ii, variant, date, mk.fqp, source);
    }
  }
  metaSet('last_viewprices_refresh', String(Date.now()));
  return {
    ok: true, date, commodities: commodities.map((c) => c.name),
    inserted, updated, quarantined, skipped,
    unmatched_markets: [...unmatchedMarkets].sort(),
    unmatched_crops: [...unmatchedCrops].sort(),
  };
}
function viewPricesDue() {
  if (!AUTO_REFRESH) return false;
  const lastOk = Number(metaGet('last_viewprices_refresh') || 0);
  if (lastOk && (Date.now() - lastOk < 6 * 60 * 60 * 1000)) return false;
  const lastAttempt = Number(metaGet('last_viewprices_attempt') || 0);
  return !lastAttempt || (Date.now() - lastAttempt > REFRESH_ATTEMPT_MIN_MS);
}
function maybeViewPricesRefresh() {
  if (vpInFlight) return;
  let due = false;
  try { due = viewPricesDue(); } catch { return; }
  if (!due) return;
  vpInFlight = runViewPricesRefresh({}).catch(() => {}).finally(() => { vpInFlight = null; });
}

// ---- HTTP layer ----
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => { data += c; if (data.length > 200000) req.destroy(); });
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve(null); } });
    req.on('error', reject);
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg' };
function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath === '/') urlPath = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(urlPath).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    // Platform health check: no DB, no auth — answers even on a fresh,
    // still-seeding database. The deploy failed once without this.
    if (p === '/health' && req.method === 'GET') {
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/favicon.ico' && req.method === 'GET') {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y="0.9em" font-size="90">🥬</text></svg>`;
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(svg) });
      return res.end(svg);
    }
    if (p === '/api/meta' && req.method === 'GET') {
      const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-data.json'), 'utf8'));
      const { cities, provinces } = provinceGroups();
      const items = db.prepare('SELECT name_en en, name_ur ur, unit, category FROM items ORDER BY name_en').all();
      return sendJson(res, 200, { cities, provinces, items, latest_date: latestDate(null), sources: seed.sources, flag_threshold: FLAG_THRESHOLD });
    }
    if (p === '/api/provinces' && req.method === 'GET') {
      const { provinces } = provinceGroups();
      return sendJson(res, 200, { provinces: provinces.map((g) => ({
        name: g.name, districts: g.districts.length,
        with_rates: g.districts.filter((d) => d.has_rates).length,
      })) });
    }
    if (p === '/api/districts' && req.method === 'GET') {
      const province = url.searchParams.get('province');
      if (!province) return sendJson(res, 400, { error: 'province required' });
      const { provinces } = provinceGroups();
      const g = provinces.find((x) => x.name === province);
      if (!g) return sendJson(res, 404, { error: 'unknown province' });
      return sendJson(res, 200, { province: g.name, districts: g.districts });
    }
    if (p === '/api/live' && req.method === 'GET') {
      maybeRefresh();
      maybeViewPricesRefresh();
      return sendJson(res, 200, liveSummary());
    }
    if (p === '/api/today' && req.method === 'GET') {
      maybeRefresh();
      maybeViewPricesRefresh();
      const city = url.searchParams.get('city') || 'Lahore';
      const category = url.searchParams.get('category') || null;
      if (category && !['vegetables', 'fruits', 'other'].includes(category)) {
        return sendJson(res, 400, { error: 'category must be vegetables, fruits or other' });
      }
      return sendJson(res, 200, { city, category, ...todayRows(city, category) });
    }
    if (p === '/api/movers' && req.method === 'GET') {
      const city = url.searchParams.get('city') || 'Lahore';
      const limit = Math.min(10, Math.max(1, Number(url.searchParams.get('limit') || 5)));
      return sendJson(res, 200, { city, ...movers(city, limit) });
    }
    if (p === '/api/history' && req.method === 'GET') {
      const item = url.searchParams.get('item');
      const city = url.searchParams.get('city') || 'Lahore';
      if (!item) return sendJson(res, 400, { error: 'item required' });
      return sendJson(res, 200, { item, city, points: history(item, city) });
    }
    if (p === '/api/cheapest' && req.method === 'GET') {
      const item = url.searchParams.get('item');
      if (!item) return sendJson(res, 400, { error: 'item required' });
      return sendJson(res, 200, { item, ...cheapest(item) });
    }
    if (p === '/api/check' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !body.item || body.price_paid === undefined) return sendJson(res, 400, { error: 'item and price_paid required' });
      const paid = Number(body.price_paid);
      if (!Number.isFinite(paid) || paid < 0) return sendJson(res, 400, { error: 'price_paid must be a number' });
      const city = body.city || 'Karachi';
      let row = db.prepare(`
        SELECT s.retail_bazaar rb, s.date date, c.name city FROM snapshots s
        JOIN items i ON i.id = s.item_id JOIN cities c ON c.id = s.city_id
        WHERE i.name_en = ? AND c.name = ? AND s.retail_bazaar IS NOT NULL
        ORDER BY s.date DESC LIMIT 1`).get(body.item, city);
      if (!row) row = db.prepare(`
        SELECT s.retail_bazaar rb, s.date date, c.name city FROM snapshots s
        JOIN items i ON i.id = s.item_id JOIN cities c ON c.id = s.city_id
        WHERE i.name_en = ? AND s.retail_bazaar IS NOT NULL
        ORDER BY s.date DESC LIMIT 1`).get(body.item);
      if (!row) {
        const w = cheapest(body.item);
        return sendJson(res, 200, { item: body.item, verdict: 'no-official-rate',
          note: 'No official retail rate on file for this item yet. Wholesale comparison below is not a retail verdict.',
          cheapest_wholesale: w.rows[0] || null });
      }
      const diff = paid - row.rb;
      const pct = (diff / row.rb) * 100;
      let verdict = 'fair';
      if (pct > 10) verdict = 'overcharged';
      else if (pct > 0) verdict = 'slightly-above';
      return sendJson(res, 200, { item: body.item, city: row.city, date: row.date,
        official_bazaar_rate: row.rb, price_paid: paid, difference: Math.round(diff * 100) / 100,
        difference_pct: Math.round(pct * 100) / 100, verdict });
    }
    if (p === '/api/chat' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || typeof body.q !== 'string') return sendJson(res, 400, { error: 'q (question) required' });
      if (body.q.length > 500) return sendJson(res, 400, { error: 'question too long' });
      return sendJson(res, 200, answerChat(body.q));
    }
    // ---- v3.1: licensed district-head admins ----
    // Creation requires the officer's identity + licence: the master checks
    // the government licence document himself BEFORE creating the account
    // (there is no public API that verifies a licence automatically).
    // officer_name, designation and licence_ref are mandatory; the account
    // starts INACTIVE and only the master can activate it. One head per
    // district — appointing a replacement means removing the old one first.
    // Master bootstrap: create a district head directly. The master has
    // already checked the officer's appointment documents in person. The
    // account starts INACTIVE with its documents on file — the master
    // activates it below, and the district becomes official from that
    // moment. This is the bootstrap path; the normal path is public
    // registration + master approval.
    // (Officers hold no licence: `documents` is the structured appointment
    // record — doc_type, doc_number, issuing_authority, issue_date,
    // optional expiry_date. A free-text licence_ref is not accepted.)
    if (p === '/api/admin/district-admin' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || body.code !== ADMIN_CODE) return sendJson(res, 403, { error: 'bad admin code' });
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');
      const district = String(body.district || '').trim();
      const officerName = String(body.officer_name || '').trim();
      const designation = String(body.designation || '').trim();
      const { docs, error: docError } = validateDocuments(body.documents);
      if (!/^[a-z0-9_.-]{3,40}$/.test(username)) return sendJson(res, 400, { error: 'username must be 3-40 chars (letters, digits, _ . -)' });
      if (password.length < 8) return sendJson(res, 400, { error: 'password must be at least 8 characters' });
      if (!district || !db.prepare('SELECT 1 FROM cities WHERE name=?').get(district)) return sendJson(res, 400, { error: 'unknown district' });
      if (db.prepare('SELECT 1 FROM district_admins WHERE username=?').get(username)) return sendJson(res, 409, { error: 'username already exists' });
      if (db.prepare("SELECT 1 FROM district_admins WHERE district=? AND role='head' AND status IN ('pending','active','suspended')").get(district)) return sendJson(res, 409, { error: 'district already has a district admin — remove it first to appoint a new one' });
      if (!officerName) return sendJson(res, 400, { error: 'officer_name required — the name of the government officer' });
      if (!designation) return sendJson(res, 400, { error: 'designation required — e.g. District Food Controller' });
      if (docError) return sendJson(res, 400, { error: docError });
      const salt = makeSalt();
      db.prepare("INSERT INTO district_admins(username, password_hash, salt, district, role, officer_name, designation, licence_ref, issuing_authority, appointed_by, status, active) VALUES(?,?,?,?, 'head',?,?,'','','master','pending',0)")
        .run(username, hashPassword(password, salt), salt, district, officerName, designation);
      insertDocuments(username, docs);
      syncPrimaryRef(username);
      logAdminAudit({ username, district, designation, licence_ref: primaryDocRef(username), action: 'admin-created', detail: 'created by master with appointment documents on file (inactive — needs activation)' });
      return sendJson(res, 200, { ok: true, username, district, officer_name: officerName, designation, documents: accountDocuments(username), active: false, status: 'pending' });
    }
    if (p === '/api/admin/district-admin/update' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || body.code !== ADMIN_CODE) return sendJson(res, 403, { error: 'bad admin code' });
      const username = String(body.username || '').trim().toLowerCase();
      const officerName = String(body.officer_name || '').trim();
      const designation = String(body.designation || '').trim();
      const appointmentRef = String(body.appointment_ref || '').trim();
      if (!officerName) return sendJson(res, 400, { error: 'officer_name required' });
      if (!designation) return sendJson(res, 400, { error: 'designation required' });
      const row = db.prepare('SELECT district, role FROM district_admins WHERE username=?').get(username);
      if (!row) return sendJson(res, 404, { error: 'unknown district admin' });
      // Identity only — appointment documents are managed through the
      // documents endpoints, never by free text here. A manager's
      // appointment reference is the head's order that appointed them.
      if (row.role === 'manager') {
        if (!appointmentRef) return sendJson(res, 400, { error: 'appointment_ref required for a manager — the head\'s order that appointed them' });
        db.prepare('UPDATE district_admins SET officer_name=?, designation=?, appointment_ref=? WHERE username=?')
          .run(officerName, designation, appointmentRef, username);
        logAdminAudit({ username, district: row.district, designation, licence_ref: primaryDocRef(username), action: 'manager-updated', detail: `appointment ${appointmentRef} updated by master` });
        return sendJson(res, 200, { ok: true, username, district: row.district });
      }
      db.prepare('UPDATE district_admins SET officer_name=?, designation=? WHERE username=?')
        .run(officerName, designation, username);
      logAdminAudit({ username, district: row.district, designation, licence_ref: primaryDocRef(username), action: 'admin-updated', detail: 'name / designation updated by master' });
      return sendJson(res, 200, { ok: true, username, district: row.district });
    }
    // Activate: the master appoints the head — the district becomes OFFICIAL
    // from this moment, and only the licensed admin manages its rates.
    // Activation refuses accounts whose credential is missing: every
    // account needs its appointment documents on file first; a manager
    // additionally needs the head's appointment reference.
    if (p === '/api/admin/district-admin/activate' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || body.code !== ADMIN_CODE) return sendJson(res, 403, { error: 'bad admin code' });
      const username = String(body.username || '').trim().toLowerCase();
      const row = db.prepare('SELECT district, role, officer_name, designation, appointment_ref FROM district_admins WHERE username=?').get(username);
      if (!row) return sendJson(res, 404, { error: 'unknown district admin' });
      if (!row.officer_name || !row.designation) return sendJson(res, 400, { error: 'name / designation missing — record officer_name and designation first, then activate' });
      if (!hasDocuments(username)) return sendJson(res, 400, { error: 'no appointment documents on file — add the officer\'s appointment documents first, then activate' });
      if (row.role === 'manager' && !row.appointment_ref) return sendJson(res, 400, { error: 'appointment_ref missing — record the head\'s order that appointed this manager first, then activate' });
      db.prepare("UPDATE district_admins SET active=1, status='active' WHERE username=?").run(username);
      if (row.role === 'manager') {
        logAdminAudit({ username, district: row.district, designation: row.designation, licence_ref: primaryDocRef(username), action: 'manager-activated', detail: `appointment ${row.appointment_ref} activated by master` });
      } else {
        logAdminAudit({ username, district: row.district, designation: row.designation, licence_ref: primaryDocRef(username), action: 'admin-activated', detail: 'district is now officially managed by this licensed admin' });
      }
      return sendJson(res, 200, { ok: true, username, district: row.district, active: true });
    }
    // Suspend: login is blocked immediately and every live session ends.
    // The district stops being official, so the master can step back in.
    if (p === '/api/admin/district-admin/suspend' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || body.code !== ADMIN_CODE) return sendJson(res, 403, { error: 'bad admin code' });
      const username = String(body.username || '').trim().toLowerCase();
      const row = db.prepare('SELECT district, role, designation, appointment_ref FROM district_admins WHERE username=?').get(username);
      if (!row) return sendJson(res, 404, { error: 'unknown district admin' });
      db.prepare("UPDATE district_admins SET active=0, status='suspended' WHERE username=?").run(username);
      db.prepare('DELETE FROM district_admin_sessions WHERE username=?').run(username);
      if (row.role === 'manager') {
        logAdminAudit({ username, district: row.district, designation: row.designation, licence_ref: primaryDocRef(username), action: 'manager-suspended', detail: `appointment ${row.appointment_ref} suspended by master — login blocked, all sessions ended` });
      } else {
        logAdminAudit({ username, district: row.district, designation: row.designation, licence_ref: primaryDocRef(username), action: 'admin-suspended', detail: 'login blocked, all sessions ended' });
      }
      return sendJson(res, 200, { ok: true, username, district: row.district, active: false });
    }
    if (p === '/api/admin/district-admins' && req.method === 'GET') {
      if (!masterHeaderOk(req)) return sendJson(res, 403, { error: 'bad admin code' });
      const rows = db.prepare('SELECT username, district, role, officer_name, designation, licence_ref, appointed_by, appointment_ref, status, assigned_places, active, created_at FROM district_admins ORDER BY district, role, username').all();
      // Attach each account's appointment documents (type/number/authority/
      // dates + whether a scan is attached — never the scan path). The
      // master console needs them to verify an officer before approving.
      for (const r of rows) {
        r.documents = accountDocuments(r.username);
        r.assigned_places = assignedPlaces(r.username);
      }
      return sendJson(res, 200, { admins: rows });
    }
    if (p === '/api/admin/district-admin/audit' && req.method === 'GET') {
      if (!masterHeaderOk(req)) return sendJson(res, 403, { error: 'bad admin code' });
      const rows = db.prepare(`SELECT id, username, district, designation, licence_ref, action, detail, created_at
        FROM district_admin_audit ORDER BY id DESC LIMIT 100`).all();
      return sendJson(res, 200, { rows });
    }
    if (p === '/api/admin/district-admin/remove' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || body.code !== ADMIN_CODE) return sendJson(res, 403, { error: 'bad admin code' });
      if (!body.username) return sendJson(res, 400, { error: 'username required' });
      const uname = String(body.username).toLowerCase();
      const row = db.prepare('SELECT district, designation, role FROM district_admins WHERE username=?').get(uname);
      // Removing an account removes its documents and their scans too —
      // personal documents must not linger on disk after the account.
      const scans = db.prepare('SELECT scan_path FROM account_documents WHERE username=? AND scan_path<>""').all(uname);
      for (const s of scans) {
        try {
          const f = path.join(UPLOADS_DIR, path.basename(s.scan_path));
          if (f.startsWith(UPLOADS_DIR)) fs.unlinkSync(f);
        } catch { /* already gone */ }
      }
      db.prepare('DELETE FROM account_documents WHERE username=?').run(uname);
      db.prepare('DELETE FROM district_admins WHERE username=?').run(uname);
      db.prepare('DELETE FROM district_admin_sessions WHERE username=?').run(uname);
      if (row) logAdminAudit({ username: uname, district: row.district, designation: row.designation, licence_ref: primaryDocRef(uname), action: row.role === 'manager' ? 'manager-removed' : 'admin-removed', detail: 'account removed by master (documents and scans deleted with it)' });
      return sendJson(res, 200, { ok: true });
    }
    // ---- v3.2: public registration + approval ----
    // The main path for both roles: an officer registers himself with his
    // appointment documents, the account stays PENDING, and the approver
    // (district head for managers, master for heads) checks the documents
    // and APPROVES or REJECTS. A pending or rejected account can never log
    // in. The master may also approve a manager where a district has no
    // head yet (fallback). Registration is public — no code, no token —
    // because the account does nothing until approved.
    function registerAccount(role, body) {
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');
      const district = String(body.district || '').trim();
      const officerName = String(body.name || body.officer_name || '').trim();
      const designation = String(body.designation || '').trim();
      const { docs, error: docError } = validateDocuments(body.documents);
      if (!/^[a-z0-9_.-]{3,40}$/.test(username)) return { error: 'username must be 3-40 chars (letters, digits, _ . -)', code: 400 };
      if (password.length < 8) return { error: 'password must be at least 8 characters', code: 400 };
      if (!district || !db.prepare('SELECT 1 FROM cities WHERE name=?').get(district)) return { error: 'unknown district', code: 400 };
      if (db.prepare('SELECT 1 FROM district_admins WHERE username=?').get(username)) return { error: 'username already exists', code: 409 };
      if (role === 'head' && db.prepare("SELECT 1 FROM district_admins WHERE district=? AND role='head' AND status IN ('pending','active','suspended')").get(district)) return { error: 'district already has a district head — its head must be removed first', code: 409 };
      if (!officerName) return { error: 'name required — the name of the officer', code: 400 };
      if (!designation) return { error: 'designation required — e.g. District Food Controller, Food Inspector, Market Committee Secretary', code: 400 };
      if (docError) return { error: docError, code: 400 };
      const salt = makeSalt();
      db.prepare("INSERT INTO district_admins(username, password_hash, salt, district, role, officer_name, designation, licence_ref, issuing_authority, appointed_by, status, active) VALUES(?,?,?,?,?,?,?,'','','','pending',0)")
        .run(username, hashPassword(password, salt), salt, district, role, officerName, designation);
      insertDocuments(username, docs);
      syncPrimaryRef(username);
      return { ok: true, username, district, role, status: 'pending', documents: accountDocuments(username) };
    }
    if (p === '/api/register/head' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body) return sendJson(res, 400, { error: 'body required' });
      const r = registerAccount('head', body);
      if (r.error) return sendJson(res, r.code || 400, { error: r.error });
      logAdminAudit({ username: r.username, district: r.district, designation: String(body.designation || ''), licence_ref: primaryDocRef(r.username), action: 'head-registered', detail: 'registered with appointment documents — waiting for master approval' });
      return sendJson(res, 200, r);
    }
    if (p === '/api/register/manager' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body) return sendJson(res, 400, { error: 'body required' });
      const r = registerAccount('manager', body);
      if (r.error) return sendJson(res, r.code || 400, { error: r.error });
      logAdminAudit({ username: r.username, district: r.district, designation: String(body.designation || ''), licence_ref: primaryDocRef(r.username), action: 'manager-registered', detail: 'registered with appointment documents — waiting for district-head approval' });
      return sendJson(res, 200, r);
    }
    // Approve / reject a pending registration. Heads approve managers of
    // their own district; the master approves heads and (where a district
    // has no head yet) managers. Approval needs documents on file; the
    // head may record the appointment order (appointment_ref) at approval.
    function decideRegistration({ role, approver, district, body }) {
      const username = String(body.username || '').trim().toLowerCase();
      const decision = body.decision;
      if (!['approve', 'reject'].includes(decision)) return { error: 'decision must be approve or reject', code: 400 };
      const row = db.prepare('SELECT district, role, officer_name, designation, appointment_ref, status FROM district_admins WHERE username=?').get(username);
      if (!row || row.role !== role) return { error: role === 'head' ? 'unknown pending district head' : 'unknown pending manager', code: 404 };
      if (district && row.district.toLowerCase() !== district.toLowerCase()) return { error: 'not your district', code: 404 };
      if (row.status !== 'pending') return { error: 'already decided: ' + row.status, code: 409 };
      if (decision === 'reject') {
        db.prepare("UPDATE district_admins SET active=0, status='rejected' WHERE username=?").run(username);
        return { ok: true, username, district: row.district, decision: 'rejected' };
      }
      if (!row.officer_name || !row.designation) return { error: 'name / designation missing — cannot approve', code: 400 };
      if (!hasDocuments(username)) return { error: 'no appointment documents on file — cannot approve', code: 400 };
      const appointmentRef = String(body.appointment_ref || row.appointment_ref || '').trim();
      // A manager is appointed by the head's written order — approving
      // one without recording the order would leave no paper trail.
      if (role === 'manager' && !appointmentRef) return { error: 'appointment_ref required to approve a manager — the head\'s written order', code: 400 };
      db.prepare("UPDATE district_admins SET active=1, status='active', appointed_by=?, appointment_ref=? WHERE username=?").run(approver, appointmentRef, username);
      return { ok: true, username, district: row.district, decision: 'approved', appointed_by: approver, appointment_ref: appointmentRef };
    }
    if (p === '/api/district-admin/manager/approve' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body) return sendJson(res, 400, { error: 'body required' });
      const { admin, error, message } = headFromToken(req, body);
      if (error) return sendJson(res, error, { error: message || 'district-admin login required' });
      const r = decideRegistration({ role: 'manager', approver: admin.username, district: admin.district, body });
      if (r.error) return sendJson(res, r.code || 400, { error: r.error });
      logAdminAudit({ username: admin.username, district: admin.district, designation: admin.designation, licence_ref: primaryDocRef(admin.username), action: r.decision === 'approved' ? 'manager-approved' : 'manager-rejected', detail: `${r.decision} manager ${r.username} (${r.district})${r.appointment_ref ? ` — appointment order ${r.appointment_ref}` : ''}` });
      return sendJson(res, 200, r);
    }
    if (p === '/api/admin/head/approve' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || body.code !== ADMIN_CODE) return sendJson(res, 403, { error: 'bad admin code' });
      const r = decideRegistration({ role: 'head', approver: 'master', district: null, body });
      if (r.error) return sendJson(res, r.code || 400, { error: r.error });
      const row = db.prepare('SELECT designation FROM district_admins WHERE username=?').get(r.username);
      logAdminAudit({ username: r.username, district: r.district, designation: row ? row.designation : '', licence_ref: primaryDocRef(r.username), action: r.decision === 'approved' ? 'head-approved' : 'head-rejected', detail: `${r.decision} district head ${r.username} (${r.district}) — district is ${r.decision === 'approved' ? 'now officially managed' : 'not official'}` });
      return sendJson(res, 200, r);
    }
    if (p === '/api/admin/manager/approve' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || body.code !== ADMIN_CODE) return sendJson(res, 403, { error: 'bad admin code' });
      const r = decideRegistration({ role: 'manager', approver: 'master', district: null, body });
      if (r.error) return sendJson(res, r.code || 400, { error: r.error });
      const row = db.prepare('SELECT designation FROM district_admins WHERE username=?').get(r.username);
      logAdminAudit({ username: r.username, district: r.district, designation: row ? row.designation : '', licence_ref: primaryDocRef(r.username), action: r.decision === 'approved' ? 'manager-approved' : 'manager-rejected', detail: `${r.decision} manager ${r.username} (${r.district}) by master (no head in this district yet)${r.appointment_ref ? ` — appointment order ${r.appointment_ref}` : ''}` });
      return sendJson(res, 200, r);
    }
    // Pending registrations, for the approver's review (with documents).
    // Heads see only their own district; the master sees all.
    if (p === '/api/district-admin/pending-managers' && req.method === 'GET') {
      const { admin, error, message } = headFromToken(req, null);
      if (error) return sendJson(res, error, { error: message || 'district-admin login required' });
      const rows = db.prepare("SELECT username, district, officer_name, designation, status, created_at FROM district_admins WHERE role='manager' AND district=? AND status='pending' ORDER BY created_at").all(admin.district);
      for (const r of rows) r.documents = accountDocuments(r.username);
      return sendJson(res, 200, { district: admin.district, pending: rows });
    }
    if (p === '/api/admin/pending-heads' && req.method === 'GET') {
      if (!masterHeaderOk(req)) return sendJson(res, 403, { error: 'bad admin code' });
      const rows = db.prepare("SELECT username, district, officer_name, designation, status, created_at FROM district_admins WHERE role='head' AND status='pending' ORDER BY created_at").all();
      for (const r of rows) r.documents = accountDocuments(r.username);
      return sendJson(res, 200, { pending: rows });
    }
    if (p === '/api/admin/pending-managers' && req.method === 'GET') {
      if (!masterHeaderOk(req)) return sendJson(res, 403, { error: 'bad admin code' });
      const rows = db.prepare("SELECT username, district, officer_name, designation, status, created_at FROM district_admins WHERE role='manager' AND status='pending' ORDER BY created_at").all();
      for (const r of rows) r.documents = accountDocuments(r.username);
      return sendJson(res, 200, { pending: rows });
    }
    // Add appointment documents to an existing account (head adds them for
    // one of their managers; master adds them for any account — e.g. to
    // complete a head-appointed manager before activation).
    if (p === '/api/district-admin/manager/documents' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body) return sendJson(res, 400, { error: 'body required' });
      const { admin, error, message } = headFromToken(req, body);
      if (error) return sendJson(res, error, { error: message || 'district-admin login required' });
      const row = managerRowForHead(admin, body.username);
      if (!row) return sendJson(res, 404, { error: 'unknown manager for your district' });
      const { docs, error: docError } = validateDocuments(body.documents);
      if (docError) return sendJson(res, 400, { error: docError });
      insertDocuments(row.username, docs);
      syncPrimaryRef(row.username);
      logAdminAudit({ username: admin.username, district: admin.district, designation: admin.designation, licence_ref: primaryDocRef(admin.username), action: 'manager-documents-added', detail: `added ${docs.length} document(s) for ${row.username}: ${docs.map((d) => d.doc_type + ' #' + d.doc_number).join(', ')}` });
      return sendJson(res, 200, { ok: true, username: row.username, documents: accountDocuments(row.username) });
    }
    if (p === '/api/admin/district-admin/documents' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || body.code !== ADMIN_CODE) return sendJson(res, 403, { error: 'bad admin code' });
      const username = String(body.username || '').trim().toLowerCase();
      if (!db.prepare('SELECT 1 FROM district_admins WHERE username=?').get(username)) return sendJson(res, 404, { error: 'unknown account' });
      const { docs, error: docError } = validateDocuments(body.documents);
      if (docError) return sendJson(res, 400, { error: docError });
      insertDocuments(username, docs);
      syncPrimaryRef(username);
      return sendJson(res, 200, { ok: true, username, documents: accountDocuments(username) });
    }
    // ---- v3.2: document scan upload + authenticated viewing ----
    // Scans are personal documents: they are NEVER public. A scan is
    // uploaded only while the account is still PENDING (the approver
    // checks it before approving), and viewed only by the approver —
    // the head for a manager's scan, the master for a head's scan — or
    // by the account holder themself. Honest limit: scans live on the
    // container disk and are lost on redeploy; the recorded document
    // details (type, number, authority, dates) live in the account
    // record and survive.
    const SCAN_MAX_BYTES = 5 * 1024 * 1024;
    const SCAN_EXTS = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.pdf': 'application/pdf' };
    if (p === '/api/register/scan' && req.method === 'POST') {
      let parsed;
      try {
        parsed = await parseMultipartBody(req, SCAN_MAX_BYTES + 65536);
      } catch (e) {
        return sendJson(res, e.message === 'upload too large' ? 413 : 400, { error: e.message === 'upload too large' ? 'scan is too large — max 5MB' : 'upload must be multipart/form-data with a scan file' });
      }
      const username = String(parsed.fields.username || '').trim().toLowerCase();
      const docNumber = String(parsed.fields.doc_number || '').trim();
      const file = parsed.files.find((f) => f.name === 'scan');
      if (!username || !docNumber) return sendJson(res, 400, { error: 'username and doc_number required (which document is this scan for?)' });
      if (!file) return sendJson(res, 400, { error: 'scan file required (field name "scan")' });
      const ext = path.extname(file.filename || '').toLowerCase();
      if (!SCAN_EXTS[ext]) return sendJson(res, 400, { error: 'scan must be a JPG, PNG, WebP image or a PDF' });
      if (file.data.length > SCAN_MAX_BYTES) return sendJson(res, 413, { error: 'scan is too large — max 5MB' });
      const acct = db.prepare('SELECT status FROM district_admins WHERE username=?').get(username);
      if (!acct) return sendJson(res, 404, { error: 'unknown account' });
      if (acct.status !== 'pending') return sendJson(res, 400, { error: 'scans can only be attached while the account is pending approval' });
      const doc = db.prepare('SELECT id FROM account_documents WHERE username=? AND doc_number=?').get(username, docNumber);
      if (!doc) return sendJson(res, 404, { error: 'no such document on this account — register the document first' });
      const stored = 'scan-' + crypto.randomBytes(16).toString('hex') + ext;
      try {
        fs.writeFileSync(path.join(UPLOADS_DIR, stored), file.data);
      } catch (e) {
        return sendJson(res, 500, { error: 'could not store the scan on this server' });
      }
      db.prepare('UPDATE account_documents SET scan_path=? WHERE id=?').run(stored, doc.id);
      return sendJson(res, 200, { ok: true, username, document_id: doc.id, has_scan: true });
    }
    if (p.startsWith('/api/documents/scan/') && req.method === 'GET') {
      const docId = Number(p.slice('/api/documents/scan/'.length));
      if (!Number.isFinite(docId)) return sendJson(res, 400, { error: 'bad document id' });
      const doc = db.prepare('SELECT username, scan_path FROM account_documents WHERE id=?').get(docId);
      if (!doc || !doc.scan_path) return sendJson(res, 404, { error: 'scan not found' });
      // Who may view it: the master (any scan), the account holder, or
      // the head of the account holder's district (a manager's scan).
      // Anyone else gets 403 — and another district's head/manager never
      // sees it at all.
      let allowed = false;
      if (masterHeaderOk(req)) allowed = true;
      else {
        const viewer = districtAdminFromToken(tokenFromReq(req, null));
        if (viewer && viewer.username === doc.username) allowed = true;
        else if (viewer && viewer.role === 'head') {
          const owner = db.prepare('SELECT district FROM district_admins WHERE username=?').get(doc.username);
          if (owner && owner.district.toLowerCase() === viewer.district.toLowerCase()) allowed = true;
        }
      }
      if (!allowed) return sendJson(res, 403, { error: 'this scan is only visible to its approver' });
      const file = path.join(UPLOADS_DIR, path.basename(doc.scan_path));
      if (!file.startsWith(UPLOADS_DIR) || !fs.existsSync(file)) return sendJson(res, 404, { error: 'scan not found' });
      const ext = path.extname(file).toLowerCase();
      const data = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': SCAN_EXTS[ext] || 'application/octet-stream', 'Content-Length': data.length, 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' });
      return res.end(data);
    }
    if (p === '/api/district-admin/login' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || !body.username || !body.password) return sendJson(res, 400, { error: 'username and password required' });
      const username = String(body.username).trim().toLowerCase();
      if (loginLocked(username)) return sendJson(res, 429, { error: 'too many failed logins — try again in 15 minutes' });
      const row = db.prepare('SELECT username, password_hash, salt, district, role, active FROM district_admins WHERE username=?').get(username);
      // Inactive (never activated) and suspended accounts get the same
      // generic error as a wrong password — never a hint that the account
      // exists but is inactive. No failed-login is recorded for them, so
      // an inactive account is not pushed deeper into lockout.
      if (!row || row.active !== 1 || !verifyPassword(String(body.password), row.salt, row.password_hash)) {
        if (row && row.active === 1) recordLoginFail(username);
        return sendJson(res, 401, { error: 'bad username or password' });
      }
      clearLoginFails(username);
      // Prune expired sessions on every successful login.
      db.prepare('DELETE FROM district_admin_sessions WHERE expires_at < ?').run(Date.now());
      const token = crypto.randomBytes(32).toString('hex');
      db.prepare('INSERT INTO district_admin_sessions(token, username, district, expires_at) VALUES(?,?,?,?)')
        .run(token, row.username, row.district, Date.now() + SESSION_TTL_MS);
      return sendJson(res, 200, { ok: true, token, username: row.username, district: row.district, role: row.role || 'head', assigned_places: (row.role || 'head') === 'manager' ? assignedPlaces(row.username) : [] });
    }
    // Server-side logout: the token is deleted, so "log out" actually ends
    // the session — clearing browser storage alone left it valid for 24h.
    if (p === '/api/district-admin/logout' && req.method === 'POST') {
      const body = await readBody(req);
      const token = tokenFromReq(req, body);
      if (token) db.prepare('DELETE FROM district_admin_sessions WHERE token=?').run(token);
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/district-admin/change-password' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body) return sendJson(res, 400, { error: 'body required' });
      const admin = districtAdminFromToken(tokenFromReq(req, body));
      if (!admin) return sendJson(res, 401, { error: 'district-admin login required' });
      const row = db.prepare('SELECT password_hash, salt FROM district_admins WHERE username=?').get(admin.username);
      if (!row || !verifyPassword(String(body.old_password || ''), row.salt, row.password_hash)) {
        return sendJson(res, 401, { error: 'old password is wrong' });
      }
      if (String(body.new_password || '').length < 8) return sendJson(res, 400, { error: 'new password must be at least 8 characters' });
      const salt = makeSalt();
      db.prepare('UPDATE district_admins SET password_hash=?, salt=? WHERE username=?')
        .run(hashPassword(String(body.new_password), salt), salt, admin.username);
      // End every other session for this account; the current one stays.
      const token = tokenFromReq(req, body);
      if (token) db.prepare('DELETE FROM district_admin_sessions WHERE username=? AND token<>?').run(admin.username, token);
      else db.prepare('DELETE FROM district_admin_sessions WHERE username=?').run(admin.username);
      logAdminAudit({ username: admin.username, district: admin.district, designation: admin.designation, licence_ref: admin.licence_ref, action: 'password-changed', detail: 'district admin changed their own password' });
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/admin/district-admin/reset-password' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || body.code !== ADMIN_CODE) return sendJson(res, 403, { error: 'bad admin code' });
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (password.length < 8) return sendJson(res, 400, { error: 'password must be at least 8 characters' });
      if (!db.prepare('SELECT 1 FROM district_admins WHERE username=?').get(username)) return sendJson(res, 404, { error: 'unknown district admin' });
      const salt = makeSalt();
      db.prepare('UPDATE district_admins SET password_hash=?, salt=? WHERE username=?')
        .run(hashPassword(password, salt), salt, username);
      // A reset ends all sessions for that account.
      db.prepare('DELETE FROM district_admin_sessions WHERE username=?').run(username);
      logAdminAudit({ username, action: 'password-reset', detail: 'master reset the password (all sessions ended)' });
      return sendJson(res, 200, { ok: true, username });
    }
    // ---- v3.2: district managers ----
    // Managers work UNDER the district head: the head appoints them by
    // written order (appointment_ref), they enter rates, and nothing they
    // propose goes live until the head — or the master, where no head
    // exists yet — approves it in the review queue. A manager's credential
    // is their own appointment documents (same real-document rule as
    // heads); the head's order is what appoints them to the district.
    // Same strict security as heads: scrypt, 24h bearer token, 5-fail /
    // 15-min lockout, real logout, accounts start inactive.
    function headFromToken(req, body) {
      const a = districtAdminFromToken(tokenFromReq(req, body));
      if (!a) return { error: 401 };
      if (a.role !== 'head') return { error: 403, message: 'district heads only — managers cannot appoint or manage other accounts' };
      return { admin: a };
    }
    function managerRowForHead(admin, username) {
      // Scoped lookup: a username from another district reads as "unknown"
      // — never a hint that it exists elsewhere.
      return db.prepare("SELECT username, district, officer_name, designation, appointment_ref, appointed_by, active FROM district_admins WHERE username=? AND role='manager' AND district=?").get(String(username || '').toLowerCase(), admin.district);
    }
    // Head appoints a manager for their own district.
    if (p === '/api/district-admin/manager' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body) return sendJson(res, 400, { error: 'body required' });
      const { admin, error, message } = headFromToken(req, body);
      if (error) return sendJson(res, error, { error: message || 'district-admin login required' });
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');
      const officerName = String(body.name || body.officer_name || '').trim();
      const designation = String(body.designation || '').trim();
      const appointmentRef = String(body.appointment_ref || '').trim();
      const reqDistrict = String(body.district || '').trim();
      if (reqDistrict && reqDistrict.toLowerCase() !== admin.district.toLowerCase()) return sendJson(res, 403, { error: 'district heads can only appoint managers for their own district' });
      if (!/^[a-z0-9_.-]{3,40}$/.test(username)) return sendJson(res, 400, { error: 'username must be 3-40 chars (letters, digits, _ . -)' });
      if (password.length < 8) return sendJson(res, 400, { error: 'password must be at least 8 characters' });
      if (!officerName) return sendJson(res, 400, { error: 'name required — the name of the manager' });
      if (!designation) return sendJson(res, 400, { error: 'designation required — the manager\'s government post' });
      if (!appointmentRef) return sendJson(res, 400, { error: 'appointment_ref required — the head\'s written order that appoints this manager' });
      if (appointmentRef.length > 100) return sendJson(res, 400, { error: 'appointment_ref too long (max 100 chars)' });
      // Documents are optional here (the head may add them right after);
      // activation still refuses an account with no documents on file.
      let docs = [];
      if (body.documents !== undefined) {
        const v = validateDocuments(body.documents);
        if (v.error) return sendJson(res, 400, { error: v.error });
        docs = v.docs;
      }
      if (db.prepare('SELECT 1 FROM district_admins WHERE username=?').get(username)) return sendJson(res, 409, { error: 'username already exists' });
      const salt = makeSalt();
      db.prepare("INSERT INTO district_admins(username, password_hash, salt, district, role, officer_name, designation, licence_ref, issuing_authority, appointed_by, appointment_ref, status, active) VALUES(?,?,?,?,'manager',?,?,'','',?,?,'pending',0)")
        .run(username, hashPassword(password, salt), salt, admin.district, officerName, designation, admin.username, appointmentRef);
      if (docs.length) { insertDocuments(username, docs); syncPrimaryRef(username); }
      logAdminAudit({ username: admin.username, district: admin.district, designation: admin.designation, licence_ref: primaryDocRef(admin.username), action: 'manager-created', detail: `appointed ${username} (${officerName}, ${designation}) by order ${appointmentRef} — inactive until activated` });
      return sendJson(res, 200, { ok: true, username, district: admin.district, name: officerName, designation, appointment_ref: appointmentRef, appointed_by: admin.username, documents: accountDocuments(username), active: false, status: 'pending' });
    }
    // Head activates one of their own managers.
    if (p === '/api/district-admin/manager/activate' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body) return sendJson(res, 400, { error: 'body required' });
      const { admin, error, message } = headFromToken(req, body);
      if (error) return sendJson(res, error, { error: message || 'district-admin login required' });
      const row = managerRowForHead(admin, body.username);
      if (!row) return sendJson(res, 404, { error: 'unknown manager for your district' });
      if (!row.officer_name || !row.designation || !row.appointment_ref) return sendJson(res, 400, { error: 'appointment details missing — record name, designation and appointment_ref first, then activate' });
      if (!hasDocuments(row.username)) return sendJson(res, 400, { error: 'no appointment documents on file for this manager — add their documents first, then activate' });
      db.prepare("UPDATE district_admins SET active=1, status='active' WHERE username=?").run(row.username);
      logAdminAudit({ username: admin.username, district: admin.district, designation: admin.designation, licence_ref: primaryDocRef(admin.username), action: 'manager-activated', detail: `activated ${row.username} (appointment ${row.appointment_ref})` });
      return sendJson(res, 200, { ok: true, username: row.username, district: row.district, active: true });
    }
    // Head suspends one of their own managers: login blocked at once, every
    // live session ends.
    if (p === '/api/district-admin/manager/suspend' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body) return sendJson(res, 400, { error: 'body required' });
      const { admin, error, message } = headFromToken(req, body);
      if (error) return sendJson(res, error, { error: message || 'district-admin login required' });
      const row = managerRowForHead(admin, body.username);
      if (!row) return sendJson(res, 404, { error: 'unknown manager for your district' });
      db.prepare("UPDATE district_admins SET active=0, status='suspended' WHERE username=?").run(row.username);
      db.prepare('DELETE FROM district_admin_sessions WHERE username=?').run(row.username);
      logAdminAudit({ username: admin.username, district: admin.district, designation: admin.designation, licence_ref: primaryDocRef(admin.username), action: 'manager-suspended', detail: `suspended ${row.username} (appointment ${row.appointment_ref}) — login blocked, all sessions ended` });
      return sendJson(res, 200, { ok: true, username: row.username, district: row.district, active: false });
    }
    // Head lists their own district's managers (safe fields only — never
    // password hashes or salts). Documents and assigned places included so
    // the head can verify a manager before activating them.
    if (p === '/api/district-admin/managers' && req.method === 'GET') {
      const { admin, error, message } = headFromToken(req, null);
      if (error) return sendJson(res, error, { error: message || 'district-admin login required' });
      const rows = db.prepare("SELECT username, officer_name, designation, appointment_ref, appointed_by, status, active, created_at FROM district_admins WHERE role='manager' AND district=? ORDER BY username").all(admin.district);
      for (const r of rows) {
        r.documents = accountDocuments(r.username);
        r.assigned_places = assignedPlaces(r.username);
      }
      return sendJson(res, 200, { district: admin.district, managers: rows });
    }
    // Head assigns (or changes) a manager's places — the markets/areas
    // inside their own district that manager may work in. Only the head
    // sets this, only for their own district's managers, and only at any
    // time. A manager with no places assigned cannot propose anything.
    if (p === '/api/district-admin/manager/places' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body) return sendJson(res, 400, { error: 'body required' });
      const { admin, error, message } = headFromToken(req, body);
      if (error) return sendJson(res, error, { error: message || 'district-admin login required' });
      const row = managerRowForHead(admin, body.username);
      if (!row) return sendJson(res, 404, { error: 'unknown manager for your district' });
      const { places, error: placesError } = validatePlaces(body.places);
      if (placesError) return sendJson(res, 400, { error: placesError });
      setAssignedPlaces(row.username, places);
      logAdminAudit({ username: admin.username, district: admin.district, designation: admin.designation, licence_ref: primaryDocRef(admin.username), action: 'manager-places-updated', detail: `${row.username} now works in: ${places.length ? places.join(', ') : '(no places assigned)'}` });
      return sendJson(res, 200, { ok: true, username: row.username, district: row.district, places });
    }
    // Master bootstrap: a manager may be created by the master ONLY for a
    // district that has no head yet. Once a head exists, only the head
    // appoints managers for that district.
    if (p === '/api/admin/district-manager' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || body.code !== ADMIN_CODE) return sendJson(res, 403, { error: 'bad admin code' });
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');
      const district = String(body.district || '').trim();
      const officerName = String(body.name || body.officer_name || '').trim();
      const designation = String(body.designation || '').trim();
      const appointmentRef = String(body.appointment_ref || '').trim();
      if (!/^[a-z0-9_.-]{3,40}$/.test(username)) return sendJson(res, 400, { error: 'username must be 3-40 chars (letters, digits, _ . -)' });
      if (password.length < 8) return sendJson(res, 400, { error: 'password must be at least 8 characters' });
      if (!district || !db.prepare('SELECT 1 FROM cities WHERE name=?').get(district)) return sendJson(res, 400, { error: 'unknown district' });
      if (db.prepare("SELECT 1 FROM district_admins WHERE district=? AND role='head'").get(district)) return sendJson(res, 409, { error: 'district already has a district head — its head appoints managers' });
      if (!officerName) return sendJson(res, 400, { error: 'name required — the name of the manager' });
      if (!designation) return sendJson(res, 400, { error: 'designation required — the manager\'s government post' });
      if (!appointmentRef) return sendJson(res, 400, { error: 'appointment_ref required — the written order that appoints this manager' });
      if (appointmentRef.length > 100) return sendJson(res, 400, { error: 'appointment_ref too long (max 100 chars)' });
      // Documents are optional here (the master may add them right after);
      // activation still refuses an account with no documents on file.
      let docs = [];
      if (body.documents !== undefined) {
        const v = validateDocuments(body.documents);
        if (v.error) return sendJson(res, 400, { error: v.error });
        docs = v.docs;
      }
      if (db.prepare('SELECT 1 FROM district_admins WHERE username=?').get(username)) return sendJson(res, 409, { error: 'username already exists' });
      const salt = makeSalt();
      db.prepare("INSERT INTO district_admins(username, password_hash, salt, district, role, officer_name, designation, licence_ref, issuing_authority, appointed_by, appointment_ref, status, active) VALUES(?,?,?,?,'manager',?,?,'','','master',?,'pending',0)")
        .run(username, hashPassword(password, salt), salt, district, officerName, designation, appointmentRef);
      if (docs.length) { insertDocuments(username, docs); syncPrimaryRef(username); }
      logAdminAudit({ username, district, designation, licence_ref: '', action: 'manager-created', detail: `created by master (bootstrap — no head in ${district} yet), appointment ${appointmentRef} — inactive until activated` });
      return sendJson(res, 200, { ok: true, username, district, name: officerName, designation, appointment_ref: appointmentRef, appointed_by: 'master', documents: accountDocuments(username), active: false, status: 'pending' });
    }
    // Master lists every manager (safe fields only).
    if (p === '/api/admin/district-managers' && req.method === 'GET') {
      if (!masterHeaderOk(req)) return sendJson(res, 403, { error: 'bad admin code' });
      const rows = db.prepare("SELECT username, district, officer_name, designation, appointment_ref, appointed_by, status, active, created_at FROM district_admins WHERE role='manager' ORDER BY district, username").all();
      for (const r of rows) {
        r.documents = accountDocuments(r.username);
        r.assigned_places = assignedPlaces(r.username);
      }
      return sendJson(res, 200, { managers: rows });
    }
    // Master assigns a manager's places — only used where a district has
    // no head yet (bootstrap). Once a head exists, the head owns places.
    if (p === '/api/admin/manager/places' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || body.code !== ADMIN_CODE) return sendJson(res, 403, { error: 'bad admin code' });
      const username = String(body.username || '').trim().toLowerCase();
      const row = db.prepare("SELECT username, district, role FROM district_admins WHERE username=? AND role='manager'").get(username);
      if (!row) return sendJson(res, 404, { error: 'unknown manager' });
      const { places, error: placesError } = validatePlaces(body.places);
      if (placesError) return sendJson(res, 400, { error: placesError });
      setAssignedPlaces(row.username, places);
      logAdminAudit({ username: row.username, district: row.district, designation: '', licence_ref: primaryDocRef(row.username), action: 'manager-places-updated', detail: `master set places for ${row.username}: ${places.length ? places.join(', ') : '(no places assigned)'}` });
      return sendJson(res, 200, { ok: true, username: row.username, district: row.district, places });
    }
    if (p === '/api/district-admin/rate' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body) return sendJson(res, 400, { error: 'body required' });
      const admin = districtAdminFromToken(tokenFromReq(req, body));
      if (!admin) return sendJson(res, 401, { error: 'district-admin login required' });
      // Direct rate entry is the head's power only. Managers ENTER rates
      // through the review queue — a manager here gets a clear 403, never
      // a silent publish.
      if (admin.role !== 'head') return sendJson(res, 403, { error: 'managers propose rates through the review queue — they cannot add rates directly' });
      const district = String(body.district || '').trim();
      if (district.toLowerCase() !== admin.district.toLowerCase()) return sendJson(res, 403, { error: 'district admins can only add rates for their own district' });
      const item = String(body.item || '').trim();
      const price = Number(body.price);
      const unit = String(body.unit || 'kg');
      const sourceName = String(body.source || '').trim();
      const date = String(body.date || '').trim();
      const kind = body.kind === 'wholesale' ? 'wholesale' : 'retail';
      const place = String(body.place || '').trim();
      if (!item || !db.prepare('SELECT 1 FROM items WHERE name_en=?').get(item)) return sendJson(res, 400, { error: 'unknown item — ask the master to add it first' });
      if (!Number.isFinite(price) || price <= 0) return sendJson(res, 400, { error: 'price must be a number above 0' });
      if (!['kg', 'dozen'].includes(unit)) return sendJson(res, 400, { error: 'unit must be kg or dozen' });
      if (!sourceName) return sendJson(res, 400, { error: 'source name required' });
      if (!isValidRateDate(date)) return sendJson(res, 400, { error: 'date must be YYYY-MM-DD and not in the future' });
      if (place.length > 100) return sendJson(res, 400, { error: 'place name too long (max 100 chars)' });
      const source = `${sourceName} · district admin ${admin.district}`;
      const ci = cityId(admin.district);
      const ii = itemId(item, '', unit);
      if (kind === 'wholesale') {
        // Wholesale is stored Rs/100kg (the AMIS convention) for kg — and
        // as-is per dozen for dozen items. Never *100 a dozen price: that
        // showed Banana at Rs 12,500/dozen instead of Rs 125.
        const stored = unit === 'dozen' ? price : price * 100;
        db.prepare(`INSERT INTO snapshots(city_id, item_id, variant, date, wholesale, source, place)
          VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(city_id, item_id, variant, date, source) DO UPDATE SET wholesale=excluded.wholesale, place=excluded.place`)
          .run(ci, ii, '', date, stored, source, place);
      } else {
        db.prepare(`INSERT INTO snapshots(city_id, item_id, variant, date, retail_bazaar, source, place)
          VALUES(?,?,?,?,?,?,?)
          ON CONFLICT(city_id, item_id, variant, date, source) DO UPDATE SET retail_bazaar=excluded.retail_bazaar, place=excluded.place`)
          .run(ci, ii, '', date, price, source, place);
      }
      logAdminAudit({ username: admin.username, district: admin.district, designation: admin.designation, licence_ref: primaryDocRef(admin.username), action: 'rate-added', detail: `${item} ${price}/${unit} (${kind}), ${date}, source: ${sourceName}${place ? ', place: ' + place : ''}` });
      return sendJson(res, 200, { ok: true, district: admin.district, item, price, unit, source, date, place });
    }
    if (p === '/api/district-admin/rate/delete' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body) return sendJson(res, 400, { error: 'body required' });
      const admin = districtAdminFromToken(tokenFromReq(req, body));
      if (!admin) return sendJson(res, 401, { error: 'district-admin login required' });
      if (admin.role !== 'head') return sendJson(res, 403, { error: 'rate deletion is for district heads — managers propose through the review queue' });
      const district = String(body.district || '').trim();
      if (district.toLowerCase() !== admin.district.toLowerCase()) return sendJson(res, 403, { error: 'district admins can only delete rates for their own district' });
      // Only rows a district admin created (source carries the marker) can
      // be deleted here — AMIS / PBS / survey rows are never touched.
      const info = db.prepare(`DELETE FROM snapshots WHERE id IN (
        SELECT s.id FROM snapshots s JOIN cities c ON c.id=s.city_id JOIN items i ON i.id=s.item_id
        WHERE c.name=? AND i.name_en=? AND s.date=? AND s.source LIKE '%district admin%')`)
        .run(admin.district, String(body.item || ''), String(body.date || ''));
      // Say so plainly when nothing was deleted — the UI used to report
      // "Deleted" even when the row was an AMIS row (untouchable here) or
      // did not exist at all.
      if (info.changes === 0) return sendJson(res, 404, { error: 'nothing deleted — only your own district-admin entries can be deleted' });
      logAdminAudit({ username: admin.username, district: admin.district, designation: admin.designation, licence_ref: admin.licence_ref, action: 'rate-deleted', detail: `${String(body.item || '')} ${String(body.date || '')} (${info.changes} row${info.changes === 1 ? '' : 's'})` });
      return sendJson(res, 200, { ok: true, deleted: info.changes });
    }
    if (p === '/api/district-admin/my-rates' && req.method === 'GET') {
      const admin = districtAdminFromToken(tokenFromReq(req, null));
      if (!admin) return sendJson(res, 401, { error: 'district-admin login required' });
      if (admin.role !== 'head') return sendJson(res, 403, { error: 'this list is for district heads — managers track their proposals in the review queue' });
      const rows = db.prepare(`SELECT s.date date, i.name_en item, i.unit unit, s.wholesale w, s.retail_bazaar rb, s.source source, s.place place
        FROM snapshots s JOIN items i ON i.id=s.item_id JOIN cities c ON c.id=s.city_id
        WHERE c.name=? AND s.source LIKE '%district admin%' ORDER BY s.date DESC, s.id DESC LIMIT 50`)
        .all(admin.district);
      return sendJson(res, 200, { district: admin.district, rows });
    }
    // ---- v3.0: review queue ----
    // Managers ENTER rates here — they never publish directly. A proposal
    // goes live only when the district head approves it (or the master,
    // where no head exists). Managers must name one of their ASSIGNED
    // places; anything else is a 403. Heads and the master may propose
    // for a whole district (place optional).
    if (p === '/api/review/propose' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body) return sendJson(res, 400, { error: 'body required' });
      let proposedBy = null;
      let scopeDistrict = null;
      let proposer = null;
      if (body.code === ADMIN_CODE) { proposedBy = 'master'; }
      else {
        const admin = districtAdminFromToken(tokenFromReq(req, body));
        if (!admin) return sendJson(res, 401, { error: 'master code or district-admin login required' });
        proposer = admin;
        // The row says WHO proposed it, so the head can never mistake a
        // manager's draft for their own.
        proposedBy = (admin.role === 'manager' ? 'manager:' : 'district-admin:') + admin.username;
        scopeDistrict = admin.district;
      }
      const item = String(body.item || '').trim();
      const district = String(body.district || '').trim();
      const price = Number(body.price);
      const unit = String(body.unit || 'kg');
      const kind = body.kind === 'wholesale' ? 'wholesale' : 'retail';
      const source = String(body.source || '').trim();
      const date = String(body.date || '').trim();
      const place = String(body.place || '').trim();
      if (scopeDistrict && district.toLowerCase() !== scopeDistrict.toLowerCase()) return sendJson(res, 403, { error: 'district admins can only propose rates for their own district' });
      if (proposer && proposer.role === 'manager') {
        // A manager works only in the places their head assigned them.
        const places = assignedPlaces(proposer.username);
        if (!place) return sendJson(res, 403, { error: 'managers must name one of their assigned places — no places assigned yet? Ask your district head' });
        if (!places.some((x) => x.toLowerCase() === place.toLowerCase())) return sendJson(res, 403, { error: `place "${place}" is not assigned to you — your places are: ${places.length ? places.join(', ') : '(none yet — ask your district head)'}` });
        if (place.length > 100) return sendJson(res, 400, { error: 'place name too long (max 100 chars)' });
      } else if (place.length > 100) return sendJson(res, 400, { error: 'place name too long (max 100 chars)' });
      if (!item || !db.prepare('SELECT 1 FROM items WHERE name_en=?').get(item)) return sendJson(res, 400, { error: 'unknown item — ask the master to add it first' });
      if (!district || !db.prepare('SELECT 1 FROM cities WHERE name=?').get(district)) return sendJson(res, 400, { error: 'unknown district' });
      if (!Number.isFinite(price) || price <= 0) return sendJson(res, 400, { error: 'price must be a number above 0' });
      if (!['kg', 'dozen'].includes(unit)) return sendJson(res, 400, { error: 'unit must be kg or dozen' });
      if (!source) return sendJson(res, 400, { error: 'source name required' });
      if (!isValidRateDate(date)) return sendJson(res, 400, { error: 'date must be YYYY-MM-DD and not in the future' });
      const r = proposeReview({ item, district, price, unit, kind, variant: String(body.variant || ''), place, source, date, proposed_by: proposedBy });
      if (scopeDistrict && proposer) {
        const detail = proposer.role === 'manager'
          ? `${item} ${price}/${unit} (${kind}), ${date}, place: ${place}, source: ${source}, queue #${r.id} — appointed by ${proposer.appointed_by}, order ${proposer.appointment_ref}`
          : `${item} ${price}/${unit} (${kind}), ${date}, source: ${source}, queue #${r.id}`;
        logAdminAudit({ username: proposer.username, district: proposer.district, designation: proposer.designation, licence_ref: primaryDocRef(proposer.username), action: 'review-proposed', detail });
      }
      return sendJson(res, 200, { ok: true, id: r.id, duplicate: r.duplicate });
    }
    if (p === '/api/review/queue' && req.method === 'GET') {
      let scopeDistrict = null;
      let viewer = null;
      if (!masterHeaderOk(req)) {
        const admin = districtAdminFromToken(tokenFromReq(req, null));
        if (!admin) return sendJson(res, 401, { error: 'master code or district-admin login required' });
        scopeDistrict = admin.district;
        viewer = admin;
      }
      const status = url.searchParams.get('status') || 'pending';
      if (!['pending', 'approved', 'rejected'].includes(status)) return sendJson(res, 400, { error: 'bad status' });
      let rows;
      if (!scopeDistrict) {
        rows = db.prepare('SELECT * FROM review_queue WHERE status=? ORDER BY id').all(status);
      } else if (viewer && viewer.role === 'manager') {
        // A manager sees ONLY their own proposals, plus non-manager
        // proposals for their own assigned places — never another
        // manager's places or data.
        const places = assignedPlaces(viewer.username);
        if (places.length) {
          const ph = places.map(() => '?').join(',');
          rows = db.prepare(`SELECT * FROM review_queue WHERE status=? AND district=? AND (proposed_by=? OR (place IN (${ph}) AND proposed_by NOT LIKE 'manager:%')) ORDER BY id`)
            .all(status, scopeDistrict, 'manager:' + viewer.username, ...places);
        } else {
          rows = db.prepare('SELECT * FROM review_queue WHERE status=? AND district=? AND proposed_by=? ORDER BY id')
            .all(status, scopeDistrict, 'manager:' + viewer.username);
        }
      } else {
        rows = db.prepare('SELECT * FROM review_queue WHERE status=? AND district=? ORDER BY id').all(status, scopeDistrict);
      }
      return sendJson(res, 200, { rows });
    }
    if (p === '/api/review/decide' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body) return sendJson(res, 400, { error: 'body required' });
      let decidedBy = null;
      let scopeDistrict = null;
      let decider = null;
      if (body.code === ADMIN_CODE) { decidedBy = 'master'; }
      else {
        const admin = districtAdminFromToken(tokenFromReq(req, body));
        if (!admin) return sendJson(res, 401, { error: 'master code or district-admin login required' });
        // Managers NEVER approve anything — not even someone else's
        // proposal, and never their own. Approval belongs to the head
        // (own district) or the master.
        if (admin.role === 'manager') return sendJson(res, 403, { error: 'managers cannot approve or reject proposals — only the district head or the master can' });
        decidedBy = 'district-admin:' + admin.username;
        scopeDistrict = admin.district;
        decider = admin;
      }
      const id = Number(body.id);
      const decision = body.decision;
      if (!Number.isFinite(id) || !['approve', 'reject'].includes(decision)) return sendJson(res, 400, { error: 'id and decision (approve/reject) required' });
      const row = db.prepare('SELECT * FROM review_queue WHERE id=?').get(id);
      if (!row) return sendJson(res, 404, { error: 'queue entry not found' });
      if (row.status !== 'pending') return sendJson(res, 409, { error: 'already decided: ' + row.status });
      if (scopeDistrict && row.district.toLowerCase() !== scopeDistrict.toLowerCase()) return sendJson(res, 403, { error: 'district admins can only decide their own district' });
      if (decision === 'approve') {
        approveReviewRow(row, decidedBy);
        if (scopeDistrict && decider) {
          logAdminAudit({ username: decider.username, district: decider.district, designation: decider.designation, licence_ref: primaryDocRef(decider.username), action: 'review-decided', detail: `approved queue #${id} (${row.item} ${row.price}/${row.unit}, ${row.district})` });
        }
        return sendJson(res, 200, { ok: true, id, decision: 'approved' });
      }
      db.prepare("UPDATE review_queue SET status='rejected', decided_by=?, decided_at=datetime('now') WHERE id=?").run(decidedBy, id);
      if (scopeDistrict && decider) {
        logAdminAudit({ username: decider.username, district: decider.district, designation: decider.designation, licence_ref: primaryDocRef(decider.username), action: 'review-decided', detail: `rejected queue #${id} (${row.item} ${row.price}/${row.unit}, ${row.district})` });
      }
      return sendJson(res, 200, { ok: true, id, decision: 'rejected' });
    }
    // ---- v3.3: daily official rates-page photos ----
    // A manager photographs the official rates page the government side
    // publishes each day (Market Committee / District Food Controller
    // daily rate list) for one of their assigned places. The photo waits
    // PENDING until the district head approves it; only APPROVED photos
    // are ever public. This is NOT the licence scan — scans are personal
    // documents and are never public; photos are public evidence once
    // approved. Photos live on the container disk and are lost on
    // redeploy (the recorded rates themselves are the durable data);
    // a re-upload after a redeploy restores the photo.
    const PHOTO_MAX_BYTES = 5 * 1024 * 1024;
    const PHOTO_EXTS = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
    function photoPublicView(r) {
      return { id: r.id, place: r.place, date: r.date, source_label: r.source_label, file_url: '/api/photos/file/' + r.filename, created_at: r.created_at };
    }
    if (p === '/api/district-manager/photo' && req.method === 'POST') {
      // Multipart upload — the token travels in the Authorization header
      // (a multipart body carries no JSON token).
      const h = req.headers.authorization || '';
      const mgr = districtAdminFromToken(h.startsWith('Bearer ') ? h.slice(7).trim() : null);
      if (!mgr) return sendJson(res, 401, { error: 'manager login required' });
      if (mgr.role !== 'manager') return sendJson(res, 403, { error: 'only district managers upload rates-page photos — heads approve them' });
      let parsed;
      try {
        parsed = await parseMultipartBody(req, PHOTO_MAX_BYTES + 65536);
      } catch (e) {
        return sendJson(res, e.message === 'upload too large' ? 413 : 400, { error: e.message === 'upload too large' ? 'photo is too large — max 5MB' : 'upload must be multipart/form-data with a photo file' });
      }
      const place = String(parsed.fields.place || '').trim();
      const date = String(parsed.fields.date || pktToday()).trim();
      const sourceLabel = String(parsed.fields.source_label || 'Market Committee daily rate list').trim() || 'Market Committee daily rate list';
      const file = parsed.files.find((f) => f.name === 'photo');
      const places = assignedPlaces(mgr.username);
      if (!place) return sendJson(res, 403, { error: 'name one of your assigned places — no places assigned yet? Ask your district head' });
      if (!places.some((x) => x.toLowerCase() === place.toLowerCase())) return sendJson(res, 403, { error: `place "${place}" is not assigned to you — your places are: ${places.length ? places.join(', ') : '(none yet — ask your district head)'}` });
      if (!validDateStr(date) || date > pktToday()) return sendJson(res, 400, { error: 'date must be a valid YYYY-MM-DD date and not in the future' });
      if (sourceLabel.length > 150) return sendJson(res, 400, { error: 'source label too long (max 150 chars)' });
      if (!file) return sendJson(res, 400, { error: 'photo file required (field name "photo")' });
      const ext = path.extname(file.filename || '').toLowerCase();
      if (!PHOTO_EXTS[ext]) return sendJson(res, 400, { error: 'photo must be a JPG, PNG or WebP image — PDFs and other files are not rates-page photos' });
      if (file.data.length > PHOTO_MAX_BYTES) return sendJson(res, 413, { error: 'photo is too large — max 5MB' });
      const stored = 'photo-' + crypto.randomBytes(16).toString('hex') + ext;
      try {
        fs.writeFileSync(path.join(UPLOADS_DIR, stored), file.data);
      } catch (e) {
        return sendJson(res, 500, { error: 'could not store the photo on this server' });
      }
      // One pending photo per place per date: a new upload supersedes a
      // still-pending one, so the head never faces two of the same day.
      db.prepare("UPDATE rates_photos SET status='superseded', decided_by=?, decided_at=datetime('now') WHERE district=? AND place=? AND date=? AND status='pending'")
        .run('superseded by a newer upload', mgr.district, place, date);
      const info = db.prepare('INSERT INTO rates_photos(username, district, place, date, source_label, filename) VALUES(?,?,?,?,?,?)')
        .run(mgr.username, mgr.district, place, date, sourceLabel, stored);
      logAdminAudit({ username: mgr.username, district: mgr.district, designation: mgr.designation, licence_ref: primaryDocRef(mgr.username), action: 'photo-uploaded', detail: `rates-page photo for ${place}, ${date} (${sourceLabel}) — waiting for head approval` });
      return sendJson(res, 200, { ok: true, id: Number(info.lastInsertRowid), district: mgr.district, place, date, source_label: sourceLabel, status: 'pending', file_url: '/api/photos/file/' + stored });
    }
    // Head's approval queue for their own district's photos.
    if (p === '/api/district-admin/photos' && req.method === 'GET') {
      const { admin, error, message } = headFromToken(req, null);
      if (error) return sendJson(res, error, { error: message || 'district-admin login required' });
      const status = url.searchParams.get('status') || 'pending';
      if (!['pending', 'approved', 'rejected', 'superseded'].includes(status)) return sendJson(res, 400, { error: 'bad status' });
      const rows = db.prepare('SELECT * FROM rates_photos WHERE district=? AND status=? ORDER BY date DESC, id DESC').all(admin.district, status);
      return sendJson(res, 200, { district: admin.district, photos: rows.map((r) => ({ ...r, file_url: '/api/photos/file/' + r.filename })) });
    }
    // Master sees every district's photos (oversight + no-head districts).
    if (p === '/api/admin/photos' && req.method === 'GET') {
      if (!masterHeaderOk(req)) return sendJson(res, 403, { error: 'bad admin code' });
      const status = url.searchParams.get('status') || 'pending';
      const district = url.searchParams.get('district') || null;
      if (!['pending', 'approved', 'rejected', 'superseded'].includes(status)) return sendJson(res, 400, { error: 'bad status' });
      const rows = district
        ? db.prepare('SELECT * FROM rates_photos WHERE district=? AND status=? ORDER BY date DESC, id DESC').all(district, status)
        : db.prepare('SELECT * FROM rates_photos WHERE status=? ORDER BY date DESC, id DESC').all(status);
      return sendJson(res, 200, { photos: rows.map((r) => ({ ...r, file_url: '/api/photos/file/' + r.filename })) });
    }
    // Approve / reject a photo: the district head (own district) or the
    // master (where no head exists). Approving one supersedes any other
    // APPROVED photo for the same place+date — one official photo per
    // place per day.
    if (p === '/api/photo/decide' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body) return sendJson(res, 400, { error: 'body required' });
      let decidedBy = null;
      let scopeDistrict = null;
      let decider = null;
      if (body.code === ADMIN_CODE) { decidedBy = 'master'; }
      else {
        const admin = districtAdminFromToken(tokenFromReq(req, body));
        if (!admin) return sendJson(res, 401, { error: 'master code or district-admin login required' });
        if (admin.role !== 'head') return sendJson(res, 403, { error: 'only the district head or the master approves rates-page photos' });
        decidedBy = 'district-admin:' + admin.username;
        scopeDistrict = admin.district;
        decider = admin;
      }
      const id = Number(body.id);
      const decision = body.decision;
      if (!Number.isFinite(id) || !['approve', 'reject'].includes(decision)) return sendJson(res, 400, { error: 'id and decision (approve/reject) required' });
      const row = db.prepare('SELECT * FROM rates_photos WHERE id=?').get(id);
      if (!row) return sendJson(res, 404, { error: 'photo not found' });
      if (row.status !== 'pending') return sendJson(res, 409, { error: 'already decided: ' + row.status });
      if (scopeDistrict && row.district.toLowerCase() !== scopeDistrict.toLowerCase()) return sendJson(res, 403, { error: 'district heads can only decide their own district\'s photos' });
      if (decision === 'approve') {
        db.prepare("UPDATE rates_photos SET status='superseded', decided_by=?, decided_at=datetime('now') WHERE district=? AND place=? AND date=? AND status='approved' AND id<>?")
          .run('superseded by a newer approved photo', row.district, row.place, row.date, id);
        db.prepare("UPDATE rates_photos SET status='approved', decided_by=?, decided_at=datetime('now') WHERE id=?").run(decidedBy, id);
      } else {
        db.prepare("UPDATE rates_photos SET status='rejected', decided_by=?, decided_at=datetime('now') WHERE id=?").run(decidedBy, id);
      }
      if (decider) {
        logAdminAudit({ username: decider.username, district: decider.district, designation: decider.designation, licence_ref: primaryDocRef(decider.username), action: decision === 'approve' ? 'photo-approved' : 'photo-rejected', detail: `${decision}d rates-page photo #${id} (${row.place}, ${row.date})` });
      }
      return sendJson(res, 200, { ok: true, id, decision: decision === 'approve' ? 'approved' : 'rejected' });
    }
    // Public: the latest approved photo per place + recent history, for
    // one district. Pending/rejected photos never appear here.
    if (p === '/api/district/photos' && req.method === 'GET') {
      const district = url.searchParams.get('district');
      if (!district) return sendJson(res, 400, { error: 'district required' });
      if (!db.prepare('SELECT 1 FROM cities WHERE name=?').get(district)) return sendJson(res, 404, { error: 'unknown district' });
      const approved = db.prepare("SELECT * FROM rates_photos WHERE district=? AND status='approved' ORDER BY date DESC, id DESC").all(district);
      const latestByPlace = {};
      for (const r of approved) {
        if (!latestByPlace[r.place]) latestByPlace[r.place] = photoPublicView(r);
      }
      return sendJson(res, 200, { district, latest_by_place: latestByPlace, history: approved.slice(0, 10).map(photoPublicView) });
    }
    // Serve a photo file. Approved photos are public; anything else needs
    // the head of that district or the master. Licence scans NEVER come
    // through this endpoint — they have their own authenticated one.
    if (p.startsWith('/api/photos/file/') && req.method === 'GET') {
      const filename = path.basename(p.slice('/api/photos/file/'.length));
      if (!filename || filename.includes('/') || filename.includes('\\')) return sendJson(res, 400, { error: 'bad filename' });
      const row = db.prepare('SELECT * FROM rates_photos WHERE filename=?').get(filename);
      if (!row) return sendJson(res, 404, { error: 'photo not found' });
      let allowed = row.status === 'approved';
      if (!allowed) {
        if (masterHeaderOk(req)) allowed = true;
        else {
          const viewer = districtAdminFromToken(tokenFromReq(req, null));
          if (viewer && viewer.role === 'head' && viewer.district.toLowerCase() === row.district.toLowerCase()) allowed = true;
          else if (viewer && viewer.username === row.username) allowed = true;
        }
      }
      if (!allowed) return sendJson(res, 403, { error: 'this photo is waiting for approval and is not public yet' });
      const file = path.join(UPLOADS_DIR, filename);
      if (!file.startsWith(UPLOADS_DIR) || !fs.existsSync(file)) return sendJson(res, 404, { error: 'photo not found' });
      const ext = path.extname(file).toLowerCase();
      const data = fs.readFileSync(file);
      res.writeHead(200, { 'Content-Type': PHOTO_EXTS[ext] || 'application/octet-stream', 'Content-Length': data.length, 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline' });
      return res.end(data);
    }
    if (p === '/api/admin/refresh-viewprices' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || body.code !== ADMIN_CODE) return sendJson(res, 403, { error: 'bad admin code' });
      const REFRESH_INTERVAL_MS = 30 * 60 * 1000;
      const lastRow = db.prepare('SELECT v FROM meta WHERE k=?').get('last_viewprices_refresh');
      const lastMs = lastRow ? Number(lastRow.v) : 0;
      if (lastMs && Date.now() - lastMs < REFRESH_INTERVAL_MS && body.force !== true) {
        return sendJson(res, 200, { ok: false, reason: 'too-soon',
          retry_after_seconds: Math.ceil((REFRESH_INTERVAL_MS - (Date.now() - lastMs)) / 1000) });
      }
      const result = await runViewPricesRefresh({});
      return sendJson(res, 200, result);
    }
    if (p === '/api/admin/snapshot' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || body.code !== ADMIN_CODE) return sendJson(res, 403, { error: 'bad admin code' });
      if (!body.city || !body.item || !body.date) return sendJson(res, 400, { error: 'city, item and date required' });
      // v3.1 official-district rule: once a district has an active licensed
      // head, its rates are managed ONLY by that head. The master's direct
      // entries for it are rejected — the head enters the rates, or they go
      // through the review queue. (The AMIS automatic refresh is a system
      // process, not a master entry, so it keeps running for every district.)
      const official = officialFor(String(body.city));
      if (official) return sendJson(res, 403, { error: `district is officially managed by its ${official.designation} — the master cannot enter rates directly for ${official.district}; its licensed district admin manages them` });
      const ci = cityId(body.city);
      const ii = itemId(body.item, body.name_ur || '', body.unit || 'kg');
      db.prepare(`INSERT INTO snapshots(city_id, item_id, variant, date, wholesale, retail_bazaar, retail_mandi, retail_auction, source)
        VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(city_id, item_id, variant, date, source) DO UPDATE SET
        wholesale=excluded.wholesale, retail_bazaar=excluded.retail_bazaar,
        retail_mandi=excluded.retail_mandi, retail_auction=excluded.retail_auction`)
        .run(ci, ii, body.variant || '', body.date,
          body.wholesale === undefined ? null : Number(body.wholesale),
          body.retail_bazaar === undefined ? null : Number(body.retail_bazaar),
          body.retail_mandi === undefined ? null : Number(body.retail_mandi),
          body.retail_auction === undefined ? null : Number(body.retail_auction),
          body.source || 'admin-entry');
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/admin/city' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || body.code !== ADMIN_CODE) return sendJson(res, 403, { error: 'bad admin code' });
      if (!body.name) return sendJson(res, 400, { error: 'name required' });
      cityId(body.name, body.province || '');
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/admin/refresh' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || body.code !== ADMIN_CODE) return sendJson(res, 403, { error: 'bad admin code' });
      const REFRESH_INTERVAL_MS = 30 * 60 * 1000;
      const lastRow = db.prepare('SELECT v FROM meta WHERE k=?').get('last_refresh');
      const lastMs = lastRow ? Number(lastRow.v) : 0;
      if (lastMs && Date.now() - lastMs < REFRESH_INTERVAL_MS && body.force !== true) {
        return sendJson(res, 200, { ok: false, reason: 'too-soon',
          retry_after_seconds: Math.ceil((REFRESH_INTERVAL_MS - (Date.now() - lastMs)) / 1000) });
      }
      const result = await runAmisRefresh({});
      return sendJson(res, 200, result);
    }
    if (p === '/api/admin/item' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || body.code !== ADMIN_CODE) return sendJson(res, 403, { error: 'bad admin code' });
      if (!body.name_en) return sendJson(res, 400, { error: 'name_en required' });
      itemId(body.name_en, body.name_ur || '', body.unit || 'kg', body.category || 'vegetables');
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/admin/recent' && req.method === 'GET') {
      if (!masterHeaderOk(req)) return sendJson(res, 403, { error: 'bad admin code' });
      const rows = db.prepare(`
        SELECT s.date date, c.name city, i.name_en item, s.variant variant, s.wholesale w,
          s.retail_bazaar rb, s.source source FROM snapshots s
        JOIN items i ON i.id = s.item_id JOIN cities c ON c.id = s.city_id
        ORDER BY s.date DESC, s.id DESC LIMIT 60`).all();
      return sendJson(res, 200, { rows });
    }
    if (req.method === 'GET') return serveStatic(req, res);
    res.writeHead(405); res.end('Method not allowed');
  } catch (e) {
    console.error(e);
    sendJson(res, 500, { error: 'server error' });
  }
});

// First visit / wake-up refresh: the container sleeps on the free host, so
// check on startup whether today's rates are already in.
maybeRefresh();
maybeViewPricesRefresh();

// Bind explicitly to all interfaces (the deploy failed once when the
// platform could not reach the app) and log the real bind address.
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Mandi Price Intelligence running on http://0.0.0.0:${PORT} (DB: ${DB_FILE})`);
});
