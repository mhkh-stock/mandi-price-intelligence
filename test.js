// Mandi Price Intelligence — verification tests (fresh DB, live HTTP).
// Run: node test.js — exits non-zero on any failure.
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PORT = 3040;
const DB = '/tmp/mandi-test.sqlite';
for (const f of [DB, DB + '-shm', DB + '-wal']) { try { fs.unlinkSync(f); } catch {} }
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('PASS: ' + name);
  else { failures++; console.log('FAIL: ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
const j = async (p, opts) => (await (await fetch(BASE + p, opts)).json());
async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE + '/api/meta'); return true; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  return false;
}
(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DB_FILE: DB }, stdio: 'pipe',
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d; });
  child.stderr.on('data', (d) => { serverLog += d; });
  try {
    check('server starts', await waitReady(), serverLog.slice(-500));
    const meta = await j('/api/meta');
    check('meta has Lahore + Karachi', meta.cities.includes('Lahore') && meta.cities.includes('Karachi'), meta.cities);
    check('meta has 20+ items', meta.items.length >= 20, meta.items.length);
    check('latest date is 2026-11-04', meta.latest_date === '2026-11-04', meta.latest_date);
    const lahore = await j('/api/today?city=Lahore');
    check('Lahore today has 9 rows', lahore.rows.length === 9, lahore.rows.length);
    const tom = lahore.rows.find((r) => r.item === 'Tomato');
    check('Lahore tomato wholesale 158.50/kg', tom && tom.wholesale_per_unit === 158.5, tom);
    check('Lahore tomato change -0.94%', tom && tom.change_pct === -0.94, tom);
    const mv = await j('/api/movers?city=Lahore&limit=5');
    check('Lahore top riser is Carrot +17.41%', mv.rises[0] && mv.rises[0].item === 'Carrot' && mv.rises[0].change_pct === 17.41, mv.rises[0]);
    const kasur = await j('/api/today?city=Kasur');
    const kg = kasur.rows.find((r) => r.item === 'Garlic');
    check('Kasur garlic flagged verify (+82.22%)', kg && kg.flag === 'verify' && kg.change_pct === 82.22, kg);
    const cheap = await j('/api/cheapest?item=Tomato');
    check('cheapest tomato city is Layyah at 124', cheap.rows[0] && cheap.rows[0].city === 'Layyah' && cheap.rows[0].per_unit === 124, cheap.rows[0]);
    const over = await j('/api/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ city: 'Karachi', item: 'Tomato', price_paid: 220 }) });
    check('checker: 220 vs official 196 = overcharged +24', over.verdict === 'overcharged' && over.official_bazaar_rate === 196 && over.difference === 24, over);
    const fair = await j('/api/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ city: 'Karachi', item: 'Tomato', price_paid: 190 }) });
    check('checker: 190 vs 196 = fair', fair.verdict === 'fair', fair);
    const hist = await j('/api/history?item=Tomato&city=Lahore');
    check('history Lahore tomato has 2 points', hist.points.length === 2, hist.points);
    const bad = await j('/api/admin/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'wrong', city: 'TestCity', item: 'Onion', date: '2026-11-05' }) });
    check('admin rejects wrong code', bad.error === 'bad admin code', bad);
    const ok = await j('/api/admin/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'mandi-admin', city: 'TestCity', item: 'Onion', date: '2026-11-05', wholesale: 15000, source: 'test' }) });
    check('admin accepts correct code', ok.ok === true, ok);
    const tc = await j('/api/today?city=TestCity');
    check('admin snapshot appears in today', tc.rows.some((r) => r.item === 'Onion' && r.wholesale_per_unit === 150), tc.rows);
    const home = await fetch(BASE + '/');
    check('homepage serves 200', home.status === 200, home.status);
    const adminPage = await fetch(BASE + '/admin.html');
    check('admin page serves 200', adminPage.status === 200, adminPage.status);
  } finally {
    child.kill();
  }
  console.log(failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
})();
