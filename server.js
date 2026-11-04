// Mandi Price Intelligence — daily wholesale + official retail rates for Pakistan,
// with history, trends, spike alerts and an overcharge checker.
// Node.js 24+, native node:http + node:sqlite only. No external dependencies.
// Port 3030. Data: AMIS wholesale (Rs/100kg, per dozen for banana) + Commissioner
// Karachi official retail list. Every rate carries its source and date; nothing is
// estimated. Admin gate is a simple shared code (env ADMIN_CODE, default
// 'mandi-admin') — demo-grade, documented in README; change it on deploy.
// v2: all 170 districts of Pakistan (7 province/territory groups), province-first
// selection, a public no-key JSON API, and a daily AMIS refresh endpoint.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { parseAmisHtml, mapCrop } = require('./lib/amis');

const PORT = Number(process.env.PORT || 3030);
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'mandi.sqlite');
const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_CODE = process.env.ADMIN_CODE || 'mandi-admin';
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
  name_ur TEXT NOT NULL DEFAULT '', unit TEXT NOT NULL DEFAULT 'kg'
);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  city_id INTEGER NOT NULL REFERENCES cities(id),
  item_id INTEGER NOT NULL REFERENCES items(id),
  variant TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL,
  wholesale REAL,
  retail_bazaar REAL,
  retail_mandi REAL,
  retail_auction REAL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(city_id, item_id, variant, date, source)
);
`);

// ---- migrations for databases created before provinces existed ----
try { db.exec('ALTER TABLE cities ADD COLUMN province TEXT DEFAULT \'\''); } catch { /* already there */ }
db.prepare('CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT)').run();
db.prepare('UPDATE cities SET name=? WHERE name=?').run('Rahim Yar Khan', 'RahimYarKhan');

function cityId(name, province) {
  db.prepare('INSERT OR IGNORE INTO cities(name, province) VALUES(?,?)').run(name, province || '');
  if (province) db.prepare('UPDATE cities SET province=? WHERE name=?').run(province, name);
  return db.prepare('SELECT id FROM cities WHERE name=?').get(name).id;
}
function itemId(en, ur, unit) {
  db.prepare('INSERT OR IGNORE INTO items(name_en, name_ur, unit) VALUES(?,?,?)').run(en, ur || '', unit || 'kg');
  const row = db.prepare('SELECT id FROM items WHERE name_en=?').get(en);
  if (ur) db.prepare('UPDATE items SET name_ur=? WHERE id=?').run(ur, row.id);
  return row.id;
}

// ---- seed: real, sourced data collected 2026-11-04 (see seed-data.json) ----
const seedCount = db.prepare('SELECT COUNT(*) c FROM snapshots').get().c;
if (seedCount === 0) {
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-data.json'), 'utf8'));
  for (const it of seed.items) itemId(it.en, it.ur, it.unit);
  const up = db.prepare(`INSERT OR IGNORE INTO snapshots
    (city_id, item_id, variant, date, wholesale, source) VALUES(?,?,?,?,?, 'amis')`);
  for (const w of seed.wholesale) {
    const ci = cityId(w.city);
    const ii = itemId(w.item, '', 'kg');
    up.run(ci, ii, w.variant || '', '2026-11-03', w.yesterday);
    up.run(ci, ii, w.variant || '', '2026-11-04', w.today);
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

function latestDate(cityName) {
  const row = cityName
    ? db.prepare(`SELECT MAX(date) d FROM snapshots s JOIN cities c ON c.id=s.city_id WHERE c.name=?`).get(cityName)
    : db.prepare('SELECT MAX(date) d FROM snapshots').get();
  return row ? row.d : null;
}
function perUnit(value, unit) {
  if (value === null || value === undefined) return null;
  return unit === 'dozen' ? value : value / 100;
}
function todayRows(cityName) {
  const date = latestDate(cityName);
  if (!date) return { date: null, rows: [] };
  const rows = db.prepare(`
    SELECT i.name_en en, i.name_ur ur, i.unit unit, s.variant variant,
      s.wholesale w, s.retail_bazaar rb, s.retail_mandi rm, s.retail_auction ra, s.source source
    FROM snapshots s JOIN items i ON i.id = s.item_id JOIN cities c ON c.id = s.city_id
    WHERE c.name = ? AND s.date = ? ORDER BY i.name_en, s.variant`).all(cityName, date);
  const out = rows.map((r) => {
    const prev = db.prepare(`
      SELECT s.wholesale w FROM snapshots s JOIN items i ON i.id = s.item_id
      JOIN cities c ON c.id = s.city_id
      WHERE c.name = ? AND i.name_en = ? AND s.variant = ? AND s.date < ? AND s.wholesale IS NOT NULL
      ORDER BY s.date DESC LIMIT 1`).get(cityName, r.en, r.variant, date);
    const cur = perUnit(r.w, r.unit);
    const prv = prev ? perUnit(prev.w, r.unit) : null;
    const change = cur !== null && prv !== null && prv !== 0 ? ((cur - prv) / prv) * 100 : null;
    return {
      item: r.en, ur: r.ur, unit: r.unit, variant: r.variant,
      wholesale_per_unit: cur === null ? null : Math.round(cur * 100) / 100,
      retail_bazaar: r.rb, retail_mandi: r.rm, retail_auction: r.ra, source: r.source,
      prev_wholesale_per_unit: prv === null ? null : Math.round(prv * 100) / 100,
      change_pct: change === null ? null : Math.round(change * 100) / 100,
      flag: change !== null && Math.abs(change) >= FLAG_THRESHOLD ? 'verify' : null,
    };
  });
  return { date, rows: out };
}
function movers(cityName, limit) {
  const { rows } = todayRows(cityName);
  const withChange = rows.filter((r) => r.change_pct !== null);
  const rises = [...withChange].sort((a, b) => b.change_pct - a.change_pct).slice(0, limit);
  const falls = [...withChange].sort((a, b) => a.change_pct - b.change_pct).slice(0, limit);
  return { rises, falls };
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
  return {
    latest_date: latestDate(null),
    provinces: provinces.length,
    districts: per_province.reduce((a, g) => a + g.districts, 0),
    districts_with_rates: per_province.reduce((a, g) => a + g.with_rates, 0),
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
    if (p === '/api/meta' && req.method === 'GET') {
      const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-data.json'), 'utf8'));
      const { cities, provinces } = provinceGroups();
      const items = db.prepare('SELECT name_en en, name_ur ur, unit FROM items ORDER BY name_en').all();
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
      return sendJson(res, 200, liveSummary());
    }
    if (p === '/api/today' && req.method === 'GET') {
      const city = url.searchParams.get('city') || 'Lahore';
      return sendJson(res, 200, { city, ...todayRows(city) });
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
    if (p === '/api/admin/snapshot' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || body.code !== ADMIN_CODE) return sendJson(res, 403, { error: 'bad admin code' });
      if (!body.city || !body.item || !body.date) return sendJson(res, 400, { error: 'city, item and date required' });
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
      let html;
      try {
        html = await fetchText('http://www.amis.pk/daily%20market%20changes.aspx', 30000);
      } catch (e) {
        return sendJson(res, 200, { ok: false, reason: 'fetch-failed', detail: e.message });
      }
      let parsed;
      try {
        parsed = parseAmisHtml(html);
      } catch (e) {
        return sendJson(res, 200, { ok: false, reason: 'parse-failed', detail: e.message });
      }
      if (parsed.unavailable || parsed.rows.length === 0) {
        return sendJson(res, 200, { ok: false, reason: parsed.unavailable ? 'amis-unavailable' : 'no-rows-parsed' });
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
        const ii = itemId(mapped.item, '', unit);
        if (!itemNames.includes(mapped.item)) itemNames.push(mapped.item);
        for (const [d, val] of [[date, row.today], [prevDate, row.yesterday]]) {
          if (existsStmt.get(row.city, mapped.item, mapped.variant, d)) updated++;
          else inserted++;
          upsert.run(ci, ii, mapped.variant, d, val);
        }
      }
      db.prepare('INSERT OR REPLACE INTO meta(k, v) VALUES(?, ?)').run('last_refresh', String(Date.now()));
      return sendJson(res, 200, { ok: true, date, inserted, updated, skipped,
        unmatched_crops: [...unmatched].sort() });
    }
    if (p === '/api/admin/item' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || body.code !== ADMIN_CODE) return sendJson(res, 403, { error: 'bad admin code' });
      if (!body.name_en) return sendJson(res, 400, { error: 'name_en required' });
      itemId(body.name_en, body.name_ur || '', body.unit || 'kg');
      return sendJson(res, 200, { ok: true });
    }
    if (p === '/api/admin/recent' && req.method === 'GET') {
      if (url.searchParams.get('code') !== ADMIN_CODE) return sendJson(res, 403, { error: 'bad admin code' });
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

server.listen(PORT, () => {
  console.log(`Mandi Price Intelligence running on http://127.0.0.1:${PORT} (DB: ${DB_FILE})`);
});
