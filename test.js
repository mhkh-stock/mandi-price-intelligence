// Mandi Price Intelligence — verification tests (fresh DB, live HTTP).
// Run: node test.js — exits non-zero on any failure.
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { parseAmisHtml, mapCrop } = require('./lib/amis');

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
    const cityNames = meta.cities.map((c) => c.name);
    check('meta has Lahore + Karachi', cityNames.includes('Lahore') && cityNames.includes('Karachi'), cityNames);
    const punjab = meta.provinces.find((g) => g.name === 'Punjab');
    const kpk = meta.provinces.find((g) => g.name === 'Khyber Pakhtunkhwa');
    check('Punjab has all 41 districts', punjab && punjab.districts.length === 41, punjab && punjab.districts.length);
    check('KPK has all 38 districts', kpk && kpk.districts.length === 38, kpk && kpk.districts.length);
    check('Nowshera + Peshawar listed under KPK', kpk && kpk.districts.some((d) => d.name === 'Nowshera') && kpk.districts.some((d) => d.name === 'Peshawar'), kpk && kpk.districts.map((d) => d.name));
    check('Rahim Yar Khan renamed (no old joined name)', cityNames.includes('Rahim Yar Khan') && !cityNames.includes('RahimYarKhan'), cityNames);
    const psh = await j('/api/today?city=Peshawar');
    const pTom = psh.rows.find((r) => r.item === 'Tomato');
    check('Peshawar tomato retail 100 (Business Recorder 2026-11-02)', psh.date === '2026-11-02' && pTom && pTom.retail_bazaar === 100, psh);
    const nows = await j('/api/today?city=Nowshera');
    check('Nowshera honestly empty (no rates invented)', nows.date === null && nows.rows.length === 0, nows);
    check('meta has 7 province groups', meta.provinces.length === 7, meta.provinces.map((g) => g.name));
    const totalDistricts = meta.provinces.reduce((a, g) => a + g.districts.length, 0);
    // 170 seeded districts + Karachi, the retail-list city (not a district) = 171 locations.
    check('meta has 171 locations (170 districts + Karachi retail city)', totalDistricts === 171, totalDistricts);
    const seedLists = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-data.json'), 'utf8'));
    const seedTotal = Object.values(seedLists.provinces).reduce((a, l) => a + l.length, 0);
    check('seed district lists total exactly 170', seedTotal === 170, seedTotal);
    const sindh = meta.provinces.find((g) => g.name === 'Sindh');
    check('Sindh has 30 districts + Karachi retail city, incl Karachi East', sindh && sindh.districts.length === 31 && sindh.districts.some((d) => d.name === 'Karachi East') && sindh.districts.some((d) => d.name === 'Karachi'), sindh && sindh.districts.length);
    const bal = meta.provinces.find((g) => g.name === 'Balochistan');
    check('Balochistan has 36 districts incl Quetta', bal && bal.districts.length === 36 && bal.districts.some((d) => d.name === 'Quetta'), bal && bal.districts.length);
    const ict = meta.provinces.find((g) => g.name === 'Islamabad Capital Territory');
    const gb = meta.provinces.find((g) => g.name === 'Gilgit-Baltistan');
    const ajk = meta.provinces.find((g) => g.name === 'Azad Jammu and Kashmir');
    check('ICT 1 + GB 14 + AJK 10 districts', ict && ict.districts.length === 1 && gb && gb.districts.length === 14 && gb.districts.some((d) => d.name === 'Rondu') && ajk && ajk.districts.length === 10 && ajk.districts.some((d) => d.name === 'Bhimber'), [ict && ict.districts.length, gb && gb.districts.length, ajk && ajk.districts.length]);
    const provs = await j('/api/provinces');
    check('/api/provinces: 7 groups, 171 locations', provs.provinces.length === 7 && provs.provinces.reduce((a, g) => a + g.districts, 0) === 171, provs.provinces);
    const dSindh = await j('/api/districts?province=' + encodeURIComponent('Sindh'));
    check('/api/districts filters Sindh to 31 (30 districts + Karachi)', dSindh.province === 'Sindh' && dSindh.districts.length === 31 && dSindh.districts.some((d) => d.name === 'Karachi East'), dSindh.districts.length);
    const dBal = await j('/api/districts?province=' + encodeURIComponent('Balochistan'));
    check('/api/districts filters Balochistan to 36', dBal.province === 'Balochistan' && dBal.districts.length === 36, dBal.districts.length);
    const live = await j('/api/live');
    check('/api/live counts (171 locations, 13 with rates)', live.latest_date === '2026-11-04' && live.provinces === 7 && live.districts === 171 && live.districts_with_rates === 13, live);
    const lp = Object.fromEntries(live.per_province.map((g) => [g.name, g.with_rates]));
    check('/api/live per-province with-rates (Punjab 11, Sindh 1, KPK 1)', lp['Punjab'] === 11 && lp['Sindh'] === 1 && lp['Khyber Pakhtunkhwa'] === 1, lp);
    const badRefresh = await j('/api/admin/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'wrong' }) });
    check('refresh rejects wrong code', badRefresh.error === 'bad admin code', badRefresh);
    const fixture = '<table id="ctl00_cphPage_GridView1">'
      + '<tr><td>CityName</td><td>CropName</td><td>Today\'s FQP/Average Price</td><td>Yesterday\'s FQP/Average Price</td><td>Change</td><td>Dir</td></tr>'
      + '<tr><td>Lahore</td><td>Onion</td><td>18000</td><td>18500</td><td>-500</td><td></td></tr>'
      + '<tr><td>Lahore</td><td>Tomato</td><td>13250</td><td>14250</td><td>-1000</td><td></td></tr>'
      + '<tr><td>Lahore</td><td>Garlic (Local)</td><td>-</td><td>-</td><td></td><td></td></tr></table>';
    const parsed = parseAmisHtml(fixture);
    check('parser reads fixture rows, skips dash rows', !parsed.unavailable && parsed.rows.length === 2
      && parsed.rows[0].city === 'Lahore' && parsed.rows[0].crop === 'Onion' && parsed.rows[0].today === 18000 && parsed.rows[0].yesterday === 18500
      && parsed.rows[1].crop === 'Tomato' && parsed.rows[1].today === 13250 && parsed.rows[1].yesterday === 14250, parsed.rows);
    check('parser detects unavailable service page', parseAmisHtml('Service is not available today due to Sunday').unavailable === true, null);
    const m1 = mapCrop('Ginger(China)', ['Ginger', 'Tomato']);
    const m2 = mapCrop('Lady Finger/Okra (بھنڈی توری)', ['Okra']);
    const m3 = mapCrop('Potato Store', ['Potato']);
    check('crop mapping handles variants', m1.item === 'Ginger' && m1.variant === 'China' && m2.item === 'Okra' && m2.variant === 'Lady Finger' && m3.item === 'Potato' && m3.variant === 'Store', [m1, m2, m3]);
    const newCity = await j('/api/admin/city', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'mandi-admin', name: 'TestDistrict', province: 'Punjab' }) });
    check('admin/city creates a district', newCity.ok === true, newCity);
    const meta2 = await j('/api/meta');
    check('TestDistrict appears under Punjab', meta2.provinces.find((g) => g.name === 'Punjab').districts.some((d) => d.name === 'TestDistrict'), meta2.provinces.find((g) => g.name === 'Punjab'));
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
    const homeHtml = await home.text();
    check('homepage has districts section + province chips', homeHtml.includes('id="allDistricts"') && homeHtml.includes('id="provinceChips"'), homeHtml.length);
    check('homepage has province-first selects', homeHtml.includes('id="provSelect"') && homeHtml.includes('id="citySelect"') && homeHtml.includes('id="provCheck"') && homeHtml.includes('id="provTrend"'), homeHtml.length);
    const apiPage = await fetch(BASE + '/api.html');
    const apiHtml = await apiPage.text();
    check('api docs page serves 200 and lists /api/live', apiPage.status === 200 && apiHtml.includes('/api/live') && apiHtml.includes('no key'), apiPage.status);
    const adminPage = await fetch(BASE + '/admin.html');
    check('admin page serves 200', adminPage.status === 200, adminPage.status);
    const adminHtml = await adminPage.text();
    check('admin page has add-district form', adminHtml.includes('Add new district') && adminHtml.includes('id="dProv"'), adminHtml.length);
    check('admin page has province-first snapshot + refresh button', adminHtml.includes('id="fProv"') && adminHtml.includes('id="refreshBtn"'), adminHtml.length);
  } finally {
    child.kill();
  }
  console.log(failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
})();
