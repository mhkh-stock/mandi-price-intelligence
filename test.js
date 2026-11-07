// Mandi Price Intelligence — verification tests (fresh DB, live HTTP).
// Run: node test.js — exits non-zero on any failure.
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { parseAmisHtml, mapCrop } = require('./lib/amis');
const os = require('node:os');
const { writableBase } = require('./lib/writable');

const PORT = 3040;
const DB = '/tmp/mandi-test.sqlite';
for (const f of [DB, DB + '-shm', DB + '-wal']) { try { fs.unlinkSync(f); } catch {} }
const BASE = `http://127.0.0.1:${PORT}`;
const CODE = process.env.TEST_ADMIN_CODE || 'test-admin-code'; // test-only master code, never a real one
let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('PASS: ' + name);
  else { failures++; console.log('FAIL: ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function pktTodayStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
// Whole days between an ISO date and today (PKT); ISO date n days before today.
function daysAgo(iso) {
  return Math.round((Date.parse(pktTodayStr() + 'T12:00:00Z') - Date.parse(iso + 'T12:00:00Z')) / 86400000);
}
function daysBeforeStr(n) {
  const d = new Date(pktTodayStr() + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
const jFor = (port) => async (p, opts) => (await (await fetch(`http://127.0.0.1:${port}` + p, opts)).json());
const j = jFor(PORT);
async function waitReady(port) {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${port}/api/meta`); return true; } catch { await sleep(200); }
  }
  return false;
}
(async () => {
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    // Auto-refresh OFF here: the 46 original checks assert the seeded
    // data (2026-11-06 refresh + 2026-11-04 rows kept), so no live fetch may run against this server.
    env: { ...process.env, PORT: String(PORT), DB_FILE: DB, MANDI_AUTO_REFRESH: '0', ADMIN_CODE: CODE }, stdio: 'pipe',
  });
  let serverLog = '';
  child.stdout.on('data', (d) => { serverLog += d; });
  child.stderr.on('data', (d) => { serverLog += d; });
  try {
    check('server starts', await waitReady(PORT), serverLog.slice(-500));
    // Writable-dir fallback helper (lib/writable.js, FoodScope pattern):
    // a writable dir is kept as-is; an unwritable one (here /proc, which
    // is read-only even for root, so the check is deterministic) falls
    // back to the same-named directory under the OS temp dir.
    check('writableBase keeps a writable app dir', writableBase(__dirname, 'mandi-test-fallback') === __dirname);
    check('writableBase falls back to tmp when the dir is not writable',
      writableBase('/proc/mandi-readonly-test', 'mandi-test-fallback') === path.join(os.tmpdir(), 'mandi-test-fallback'));
    const meta = await j('/api/meta');
    const cityNames = meta.cities.map((c) => c.name);
    check('meta has Lahore + Karachi', cityNames.includes('Lahore') && cityNames.includes('Karachi'), cityNames);
    const punjab = meta.provinces.find((g) => g.name === 'Punjab');
    const kpk = meta.provinces.find((g) => g.name === 'Khyber Pakhtunkhwa');
    check('Punjab has all 41 districts', punjab && punjab.districts.length === 41, punjab && punjab.districts.length);
    check('KPK has all 36 districts', kpk && kpk.districts.length === 36, kpk && kpk.districts.length);
    check('Nowshera + Peshawar listed under KPK', kpk && kpk.districts.some((d) => d.name === 'Nowshera') && kpk.districts.some((d) => d.name === 'Peshawar'), kpk && kpk.districts.map((d) => d.name));
    check('Rahim Yar Khan renamed (no old joined name)', cityNames.includes('Rahim Yar Khan') && !cityNames.includes('RahimYarKhan'), cityNames);
    const psh = await j('/api/today?city=Peshawar');
    const pTom = psh.rows.find((r) => r.item === 'Tomato');
    check('Peshawar tomato retail 100 (Business Recorder 2026-11-02)', psh.date === '2026-11-02' && pTom && pTom.retail_bazaar === 100, psh);
    const nows = await j('/api/today?city=Nowshera');
    // Peshawar's seed rates are dated 2026-11-02: while they are within the
    // 7-day window the fallback shows them date-labelled; once they age past
    // 7 days the district is honestly empty again. The expectation follows
    // the calendar, so this check stays true on any run date.
    const pshAge = daysAgo('2026-11-02');
    if (pshAge <= 7) {
      check('Nowshera shows Peshawar 2 Nov rates, date-labelled (7-day window)',
        nows.date === '2026-11-02' && nows.rows.length > 0 && nows.nearest_rates_from === 'Peshawar' && nows.nearest_rates_date === '2026-11-02', nows);
    } else {
      check('Nowshera honestly empty (hub older than 7 days gives no fallback)',
        nows.date === null && nows.rows.length === 0 && nows.nearest_rates_from === null && nows.nearest_rates_date === null, nows);
    }
    check('meta has 7 province groups', meta.provinces.length === 7, meta.provinces.map((g) => g.name));
    const totalDistricts = meta.provinces.reduce((a, g) => a + g.districts.length, 0);
    // 168 seeded districts + Karachi, the retail-list city (not a district) = 169 locations.
    check('meta has 169 locations (168 districts + Karachi retail city)', totalDistricts === 169, totalDistricts);
    const seedLists = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-data.json'), 'utf8'));
    const seedTotal = Object.values(seedLists.provinces).reduce((a, l) => a + l.length, 0);
    check('seed district lists total exactly 168', seedTotal === 168, seedTotal);
    // District-list correction (2026-11-05): "Bari Swat" is part of Swat and
    // "Paharpur" is a tehsil of D.I. Khan — neither is a district, so neither
    // may appear in any province list. KPK is 36, not 38.
    const allSeedDistricts = Object.values(seedLists.provinces).flat();
    check('no fake districts: Bari Swat and Paharpur are gone, KPK is 36',
      seedTotal === 168 && !allSeedDistricts.includes('Bari Swat') && !allSeedDistricts.includes('Paharpur')
      && seedLists.provinces['Khyber Pakhtunkhwa'].length === 36, seedLists.provinces['Khyber Pakhtunkhwa'].length);
    const dKpk = await j('/api/districts?province=' + encodeURIComponent('Khyber Pakhtunkhwa'));
    check('/api/districts filters KPK to 36 without the fake entries',
      dKpk.province === 'Khyber Pakhtunkhwa' && dKpk.districts.length === 36
      && !dKpk.districts.some((d) => d.name === 'Bari Swat' || d.name === 'Paharpur'), dKpk.districts.length);
    const sindh = meta.provinces.find((g) => g.name === 'Sindh');
    check('Sindh has 30 districts + Karachi retail city, incl Karachi East', sindh && sindh.districts.length === 31 && sindh.districts.some((d) => d.name === 'Karachi East') && sindh.districts.some((d) => d.name === 'Karachi'), sindh && sindh.districts.length);
    const bal = meta.provinces.find((g) => g.name === 'Balochistan');
    check('Balochistan has 36 districts incl Quetta', bal && bal.districts.length === 36 && bal.districts.some((d) => d.name === 'Quetta'), bal && bal.districts.length);
    const ict = meta.provinces.find((g) => g.name === 'Islamabad Capital Territory');
    const gb = meta.provinces.find((g) => g.name === 'Gilgit-Baltistan');
    const ajk = meta.provinces.find((g) => g.name === 'Azad Jammu and Kashmir');
    check('ICT 1 + GB 14 + AJK 10 districts', ict && ict.districts.length === 1 && gb && gb.districts.length === 14 && gb.districts.some((d) => d.name === 'Rondu') && ajk && ajk.districts.length === 10 && ajk.districts.some((d) => d.name === 'Bhimber'), [ict && ict.districts.length, gb && gb.districts.length, ajk && ajk.districts.length]);
    const provs = await j('/api/provinces');
    check('/api/provinces: 7 groups, 169 locations', provs.provinces.length === 7 && provs.provinces.reduce((a, g) => a + g.districts, 0) === 169, provs.provinces);
    const dSindh = await j('/api/districts?province=' + encodeURIComponent('Sindh'));
    check('/api/districts filters Sindh to 31 (30 districts + Karachi)', dSindh.province === 'Sindh' && dSindh.districts.length === 31 && dSindh.districts.some((d) => d.name === 'Karachi East'), dSindh.districts.length);
    const dBal = await j('/api/districts?province=' + encodeURIComponent('Balochistan'));
    check('/api/districts filters Balochistan to 36', dBal.province === 'Balochistan' && dBal.districts.length === 36, dBal.districts.length);
    const live = await j('/api/live');
    check('/api/live counts (169 locations, 36 with rates after v2.3 seeds)', live.latest_date === '2026-11-06' && live.provinces === 7 && live.districts === 169 && live.districts_with_rates === 36, live);
    check('/api/live returns freshness fields (nulls before any refresh)', live.last_refresh_at === null && live.last_refresh_attempt_at === null && live.rates_date === '2026-11-06' && live.source === 'AMIS Pakistan (amis.pk)', live);
    const lp = Object.fromEntries(live.per_province.map((g) => [g.name, g.with_rates]));
    check('/api/live per-province with-rates (Punjab 25, KPK 4, Sindh 4, Balochistan 2, ICT 1, GB 0, AJK 0)', lp['Punjab'] === 25 && lp['Khyber Pakhtunkhwa'] === 4 && lp['Sindh'] === 4 && lp['Balochistan'] === 2 && lp['Islamabad Capital Territory'] === 1 && lp['Gilgit-Baltistan'] === 0 && lp['Azad Jammu and Kashmir'] === 0, lp);
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
    const newCity = await j('/api/admin/city', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, name: 'TestDistrict', province: 'Punjab' }) });
    check('admin/city creates a district', newCity.ok === true, newCity);
    const meta2 = await j('/api/meta');
    check('TestDistrict appears under Punjab', meta2.provinces.find((g) => g.name === 'Punjab').districts.some((d) => d.name === 'TestDistrict'), meta2.provinces.find((g) => g.name === 'Punjab'));
    check('meta has 20+ items', meta.items.length >= 20, meta.items.length);
    check('latest date is 2026-11-06', meta.latest_date === '2026-11-06', meta.latest_date);
    const lahore = await j('/api/today?city=Lahore');
    check('Lahore today has 7 rows', lahore.rows.length === 7, lahore.rows.length);
    const tom = lahore.rows.find((r) => r.item === 'Tomato');
    check('Lahore tomato wholesale 175.00/kg', tom && tom.wholesale_per_unit === 175, tom);
    check('Lahore tomato change +9.38%', tom && tom.change_pct === 9.38, tom);
    const mv = await j('/api/movers?city=Lahore&limit=5');
    check('Lahore top riser is Tomato +9.38%', mv.rises[0] && mv.rises[0].item === 'Tomato' && mv.rises[0].change_pct === 9.38, mv.rises[0]);
    const kasur = await j('/api/today?city=Kasur');
    const kg = kasur.rows.find((r) => r.item === 'Garlic');
    check('Kasur garlic flagged verify (+82.22%)', kg && kg.flag === 'verify' && kg.change_pct === 82.22, kg);
    const cheap = await j('/api/cheapest?item=Potato');
    check('cheapest potato is Okara at 23.50 (AMIS 2026-11-06)', cheap.date === '2026-11-06' && cheap.rows[0] && cheap.rows[0].city === 'Okara' && cheap.rows[0].per_unit === 23.5, cheap.rows[0]);
    const cheapTom = await j('/api/cheapest?item=Tomato');
    check('cheapest tomato is Sahiwal at 148.50 (AMIS 2026-11-06)', cheapTom.date === '2026-11-06' && cheapTom.rows[0] && cheapTom.rows[0].city === 'Sahiwal' && cheapTom.rows[0].per_unit === 148.5, cheapTom.rows[0]);
    const over = await j('/api/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ city: 'Karachi', item: 'Tomato', price_paid: 220 }) });
    check('checker: 220 vs official 196 = overcharged +24', over.verdict === 'overcharged' && over.official_bazaar_rate === 196 && over.difference === 24, over);
    const fair = await j('/api/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ city: 'Karachi', item: 'Tomato', price_paid: 190 }) });
    check('checker: 190 vs 196 = fair', fair.verdict === 'fair', fair);
    const banCheck = await j('/api/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ city: 'Peshawar', item: 'Banana', price_paid: 125 }) });
    check('checker: banana carries its own unit (dozen / درجن), not a hard-coded kg',
      banCheck.verdict === 'fair' && banCheck.unit === 'dozen' && banCheck.unit_ur === 'درجن' && banCheck.official_bazaar_rate === 125, banCheck);
    const mvBadLimit = await j('/api/movers?city=Lahore&limit=abc');
    check('movers: a non-numeric limit falls back to the default instead of returning empty',
      Array.isArray(mvBadLimit.rises) && mvBadLimit.rises.length >= 1 && mvBadLimit.rises.length <= 5, mvBadLimit);
    const hist = await j('/api/history?item=Tomato&city=Lahore');
    check('history Lahore tomato has 4 points', hist.points.length === 4, hist.points);
    const bad = await j('/api/admin/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'wrong', city: 'TestCity', item: 'Onion', date: '2026-11-05' }) });
    check('admin rejects wrong code', bad.error === 'bad admin code', bad);
    const ok = await j('/api/admin/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, city: 'TestCity', item: 'Onion', date: '2026-11-05', wholesale: 15000, source: 'test' }) });
    check('admin accepts correct code', ok.ok === true, ok);
    const tc = await j('/api/today?city=TestCity');
    check('admin snapshot appears in today', tc.rows.some((r) => r.item === 'Onion' && r.wholesale_per_unit === 150), tc.rows);
    const snapFuture = await j('/api/admin/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, city: 'TestCity', item: 'Onion', date: '2999-01-01', wholesale: 15000, source: 'test' }) });
    check('admin snapshot with a future date is rejected', snapFuture.error === 'date must be YYYY-MM-DD and not in the future', snapFuture);
    const snapBadPrice = await j('/api/admin/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, city: 'TestCity', item: 'Onion', date: '2026-11-05', wholesale: 'abc', source: 'test' }) });
    check('admin snapshot with a non-numeric price is rejected', snapBadPrice.error === 'wholesale must be a number of 0 or more', snapBadPrice);
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
    const home2 = await fetch(BASE + '/');
    const home2Html = await home2.text();
    check('homepage has freshness line element', home2Html.includes('id="freshnessLine"'), home2Html.length);

    // ---- nav redesign (sticky header + kebab menu + portals) ----
    const css = await (await fetch(BASE + '/styles.css')).text();
    check('header CSS is sticky with kebab menu, two header buttons, back button and role-card styles',
      css.includes('position: sticky') && css.includes('.menu-btn') && css.includes('.cta-register') && css.includes('.btn-login') && css.includes('.back-btn') && css.includes('.role-card'), css.length);
    const homeNavHtml = await (await fetch(BASE + '/')).text();
    check('homepage header has Register + Log in buttons and grouped kebab menu (Rates + Admin)',
      homeNavHtml.includes('id="menuBtn"') && homeNavHtml.includes('aria-haspopup="menu"') && homeNavHtml.includes('aria-controls="siteMenu"') && homeNavHtml.includes('id="siteMenu"') && homeNavHtml.includes('>Rates<') && homeNavHtml.includes('>Admin<') && homeNavHtml.includes('class="cta-register"') && homeNavHtml.includes('href="register.html">Register</a>') && homeNavHtml.includes('class="btn-login"') && homeNavHtml.includes('href="login.html">Log in</a>'), homeNavHtml.length);
    check('homepage menu lists all 8 destinations; Register and Log in each appear once, as header buttons only',
      ['href="#today"', 'href="#allDistricts"', 'href="#movers"', 'href="#checker"', 'href="#chat"', 'href="admin.html"', 'href="district-admin.html"', 'href="manager.html"'].every((h) => homeNavHtml.includes(h)) && (homeNavHtml.match(/href="register\.html"/g) || []).length === 1 && (homeNavHtml.match(/href="login\.html"/g) || []).length === 1, homeNavHtml.length);
    const navJs = await fetch(BASE + '/nav.js');
    const navJsText = await navJs.text();
    check('shared nav.js serves 200 with menu toggle, Escape close and aria-current',
      navJs.status === 200 && navJsText.includes('aria-expanded') && navJsText.includes('Escape') && navJsText.includes('aria-current'), navJsText.length);
    for (const page of ['admin.html', 'district-admin.html', 'manager.html', 'register.html', 'api.html', 'login.html']) {
      const r = await fetch(BASE + '/' + page);
      const h = await r.text();
      check(page + ' serves 200 with kebab menu + back button',
        r.status === 200 && h.includes('id="menuBtn"') && h.includes('id="siteMenu"') && h.includes('class="back-btn"') && h.includes('← Back to home'), h.length);
    }
    const regHtml = await (await fetch(BASE + '/register.html')).text();
    check('register portal has two role cards and a hidden form with the role preselected on choice',
      regHtml.includes('data-role="head"') && regHtml.includes('data-role="manager"') && regHtml.includes('Register as District Head') && regHtml.includes('Register as Food Manager') && !regHtml.includes('select id="regRole"') && regHtml.includes('id="regForm" hidden') && regHtml.includes('id="regRoleLabel"') && regHtml.includes('id="changeRoleBtn"'), regHtml.length);
    const loginHtml = await (await fetch(BASE + '/login.html')).text();
    check('login portal lists head + manager logins as separate cards, no master login form',
      loginHtml.includes('Log in as District Head') && loginHtml.includes('Log in as Manager') && loginHtml.includes('href="district-admin.html"') && loginHtml.includes('href="manager.html"') && !loginHtml.includes('Admin code') && !loginHtml.includes('X-Master-Code'), loginHtml.length);

    // ---- v2.2 nearest-rates fallback ----
    // (b) a district WITH rates returns its own rates, no fallback flag.
    const lahore2 = await j('/api/today?city=Lahore');
    check('district with rates returns its own, no fallback flag', lahore2.date === '2026-11-06' && lahore2.rows.length === 7 && lahore2.nearest_rates_from === null && lahore2.nearest_rates_date === null, lahore2);
    // (a) give the hub fresh rates for today, then the empty district falls
    // back to it — requested name kept, hub named explicitly.
    const todayStr = pktTodayStr();
    const pshFresh1 = await j('/api/admin/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, city: 'Peshawar', item: 'Tomato', date: todayStr, wholesale: 15000 }) });
    const pshFresh2 = await j('/api/admin/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, city: 'Peshawar', item: 'Onion', date: todayStr, wholesale: 12000 }) });
    check('admin adds fresh Peshawar snapshots for today', pshFresh1.ok === true && pshFresh2.ok === true, [pshFresh1, pshFresh2]);
    const nows2 = await j('/api/today?city=Nowshera');
    const nowsTom = nows2.rows.find((r) => r.item === 'Tomato');
    check('Nowshera falls back to fresh Peshawar rates, labelled', nows2.city === 'Nowshera' && nows2.date === todayStr && nows2.nearest_rates_from === 'Peshawar' && nows2.nearest_rates_date === todayStr && nowsTom && nowsTom.wholesale_per_unit === 150, nows2);
    const mvNows = await j('/api/movers?city=Nowshera&limit=5');
    check('movers pass the fallback label through', mvNows.nearest_rates_from === 'Peshawar' && mvNows.nearest_rates_date === todayStr, mvNows);
    // (c) hub with no rates at all -> honest empty, no fallback.
    // (Khuzdar + Quetta now have PBS rows of their own — see v2.3 checks —
    // so the hub-empty case uses Gilgit-Baltistan, whose hub Gilgit has none.)
    const skardu = await j('/api/today?city=Skardu');
    check('Skardu honestly empty (hub Gilgit has no rates)', skardu.date === null && skardu.rows.length === 0 && skardu.nearest_rates_from === null && skardu.nearest_rates_date === null, skardu);
    const gilgit = await j('/api/today?city=Gilgit');
    check('Gilgit itself honestly empty', gilgit.date === null && gilgit.rows.length === 0 && gilgit.nearest_rates_from === null, gilgit);
    // ---- 7-day fallback window (Hashir's order 2026-11-06) ----
    // Gilgit has no seed rates, so it is the clean stale-hub fixture.
    // (d) hub 8 days old -> honestly empty, no fallback.
    const d8 = daysBeforeStr(8);
    const gil8 = await j('/api/admin/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, city: 'Gilgit', item: 'Tomato', date: d8, wholesale: 14000 }) });
    check('admin adds Gilgit snapshot 8 days old', gil8.ok === true, gil8);
    const skardu8 = await j('/api/today?city=Skardu');
    check('Skardu honestly empty (hub 8 days old is past the 7-day window)', skardu8.date === null && skardu8.rows.length === 0 && skardu8.nearest_rates_from === null && skardu8.nearest_rates_date === null, skardu8);
    // (e) hub exactly 7 days old -> fallback shows, date-labelled.
    const d7 = daysBeforeStr(7);
    const gil7 = await j('/api/admin/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, city: 'Gilgit', item: 'Tomato', date: d7, wholesale: 14500 }) });
    check('admin adds Gilgit snapshot 7 days old', gil7.ok === true, gil7);
    const skardu7 = await j('/api/today?city=Skardu');
    const skTom = skardu7.rows.find((r) => r.item === 'Tomato');
    check('Skardu falls back to 7-day-old Gilgit rates, date-labelled', skardu7.date === d7 && skardu7.rows.length > 0 && skardu7.nearest_rates_from === 'Gilgit' && skardu7.nearest_rates_date === d7 && skTom && skTom.wholesale_per_unit === 145, skardu7);
    const mvSkardu = await j('/api/movers?city=Skardu&limit=5');
    check('movers pass the 7-day fallback label through', mvSkardu.nearest_rates_from === 'Gilgit' && mvSkardu.nearest_rates_date === d7, mvSkardu);
    // UI: the fallback line element exists on the homepage.
    const home3 = await fetch(BASE + '/');
    const home3Html = await home3.text();
    check('homepage has nearest-rates line element', home3Html.includes('id="nearestNote"'), home3Html.length);

    // ---- v2.3 verified seeds (AMIS ViewPrices potato, PBS weekly SPI,
    // Daily Qudrat Islamabad, poultryrates chicken) ----
    // (a) the 12 NEW potato districts each return their potato row, dated
    // 2026-11-05, source AMIS ViewPrices. (The research file's "14" counts
    // Muzaffargarh + Gujrat, whose only markets are the two excluded
    // outliers — see the outlier checks below. Honest total is 36, not 38.)
    for (const d of ['Vehari', 'Toba Tek Singh', 'Khanewal', 'Pakpattan', 'Lodhran', 'Dera Ghazi Khan', 'Rajanpur', 'Jhelum', 'Mianwali', 'Chakwal', 'Hafizabad', 'Khushab']) {
      const t = await j('/api/today?city=' + encodeURIComponent(d));
      const pot = t.rows.filter((r) => r.item === 'Potato');
      check(`ViewPrices potato: ${d} has a potato row dated 2026-11-05`, t.date === '2026-11-05' && pot.length >= 1 && pot.every((r) => r.source.includes('AMIS ViewPrices')) && pot.every((r) => r.wholesale_per_unit !== null), t);
    }
    // Khanewal has 3 markets: Kabirwala 115, Jahanian 105, Abdulhakim 116.50.
    const kha = await j('/api/today?city=Khanewal');
    const khaPots = kha.rows.filter((r) => r.item === 'Potato').map((r) => r.wholesale_per_unit).sort((a, b) => a - b);
    check('Khanewal keeps all 3 market potato rows (105 / 115 / 116.50)', khaPots.length === 3 && khaPots[0] === 105 && khaPots[1] === 115 && khaPots[2] === 116.5, khaPots);
    const khaVar = kha.rows.filter((r) => r.item === 'Potato').map((r) => r.variant).sort();
    check('Khanewal potato rows carry their market names as variants', khaVar.includes('Kabirwala market') && khaVar.includes('Jahanian market') && khaVar.includes('Abdulhakim market'), khaVar);
    const khaSrc = kha.rows.find((r) => r.item === 'Potato' && r.variant === 'Kabirwala market');
    check('ViewPrices source records the Min–Max range', khaSrc && khaSrc.source === 'AMIS ViewPrices (Min 10000–Max 13000 Rs/100kg)', khaSrc && khaSrc.source);
    // (b) the 2 flagged outliers were NOT seeded — no own rows at all.
    // (History has no fallback, so empty history proves no seeded rows;
    // /api/today shows the honest Lahore fallback instead, never fake rows.)
    for (const d of ['Muzaffargarh', 'Gujrat']) {
      const h = await j('/api/history?item=Potato&city=' + encodeURIComponent(d));
      check(`outlier district ${d} has no seeded potato rows`, h.points.length === 0, h.points);
      const t = await j('/api/today?city=' + encodeURIComponent(d));
      check(`outlier district ${d} shows only the labelled Lahore fallback`, t.nearest_rates_from === 'Lahore' && t.rows.length > 0 && t.rows.every((r) => r.source === 'amis'), t);
    }
    // (c) PBS weekly SPI rows: 9 new districts, weekly label, dated 22 Oct.
    const PBS_LABEL = 'PBS weekly retail average, week ended 22 Oct 2026';
    const bannu = await j('/api/today?city=Bannu');
    const bTom = bannu.rows.find((r) => r.item === 'Tomato');
    const bOn = bannu.rows.find((r) => r.item === 'Onion');
    check('Bannu PBS tomato 89.63 / onion 180, weekly label, 2026-10-22', bannu.date === '2026-10-22' && bTom && bTom.retail_bazaar === 89.63 && bTom.source === PBS_LABEL && bOn && bOn.retail_bazaar === 180 && bOn.source === PBS_LABEL, bannu);
    const sial = await j('/api/today?city=Sialkot');
    check('Sialkot PBS tomato 100 / onion 200, weekly label', sial.date === '2026-10-22' && sial.rows.some((r) => r.item === 'Tomato' && r.retail_bazaar === 100 && r.source === PBS_LABEL) && sial.rows.some((r) => r.item === 'Onion' && r.retail_bazaar === 200 && r.source === PBS_LABEL), sial);
    const qta = await j('/api/today?city=Quetta');
    check('Quetta PBS tomato 94.51 / onion 144.68, weekly label', qta.date === '2026-10-22' && qta.rows.some((r) => r.item === 'Tomato' && r.retail_bazaar === 94.51) && qta.rows.some((r) => r.item === 'Onion' && r.retail_bazaar === 144.68), qta);
    const khz = await j('/api/today?city=Khuzdar');
    check('Khuzdar PBS garlic 600 + tomato 78.30, weekly label', khz.date === '2026-10-22' && khz.rows.some((r) => r.item === 'Garlic' && r.retail_bazaar === 600 && r.source === PBS_LABEL) && khz.rows.some((r) => r.item === 'Tomato' && r.retail_bazaar === 78.3), khz);
    const hyd = await j('/api/today?city=Hyderabad');
    check('Hyderabad PBS garlic 289.83, weekly label', hyd.date === '2026-10-22' && hyd.rows.some((r) => r.item === 'Garlic' && r.retail_bazaar === 289.83 && r.source === PBS_LABEL), hyd);
    const lar = await j('/api/today?city=Larkana');
    check('Larkana PBS potato 31.58, weekly label', lar.date === '2026-10-22' && lar.rows.some((r) => r.item === 'Potato' && r.retail_bazaar === 31.58 && r.source === PBS_LABEL), lar);
    const bah = await j('/api/today?city=Bahawalpur');
    check('Bahawalpur PBS potato 33.02, weekly label', bah.date === '2026-10-22' && bah.rows.some((r) => r.item === 'Potato' && r.retail_bazaar === 33.02 && r.source === PBS_LABEL), bah);
    // (d) Islamabad: Qudrat list (29 Oct, 8 items) is the latest snapshot;
    // the PBS rows (22 Oct) stay in history with their own date.
    const isb = await j('/api/today?city=Islamabad');
    check('Islamabad latest is the Qudrat list: 8 items, 2026-10-29, onion 195', isb.date === '2026-10-29' && isb.rows.length === 8 && isb.rows.some((r) => r.item === 'Onion' && r.retail_bazaar === 195 && r.source === 'Daily Qudrat Islamabad list, 29 Oct 2026'), isb);
    const isbHist = await j('/api/history?item=Tomato&city=Islamabad');
    check('Islamabad PBS tomato 167.43 stays in history dated 2026-10-22', isbHist.points.some((p) => p.date === '2026-10-22' && p.retail_bazaar === 167.43), isbHist.points);
    // (e) Chicken, 05 Nov 2026, Mansehra + Abbottabad, retail live 415.
    for (const d of ['Mansehra', 'Abbottabad']) {
      const t = await j(`/api/today?city=${d}`);
      const ch = t.rows.find((r) => r.item === 'Chicken');
      check(`${d} chicken retail live 415, 2026-11-05`, t.date === '2026-11-05' && ch && ch.retail_bazaar === 415 && ch.source === 'poultryrates.today, notified by KP Market Committee', t);
    }
    // (f) Nowshera still has no rows of its own — the fallback covers it,
    // nothing was invented for it.
    const nowsHist = await j('/api/history?item=Potato&city=Nowshera');
    check('Nowshera has no seeded rows (fallback only, nothing invented)', nowsHist.points.length === 0, nowsHist.points);
    // (g) the 4 new sources are documented in /api/meta.
    const meta3 = await j('/api/meta');
    check('meta documents the 4 new v2.3 sources', ['amis-viewprices', 'pbs-spi', 'daily-qudrat', 'poultryrates'].every((id) => meta3.sources.some((s) => s.id === id)), meta3.sources.map((s) => s.id));
    check('meta lists Chicken as an item', meta3.items.some((i) => i.en === 'Chicken'), meta3.items.length);

    // ---- v3.0: categories + Urdu units ----
    const metaV3 = await j('/api/meta');
    const itemByName = Object.fromEntries(metaV3.items.map((i) => [i.en, i]));
    check('meta items carry categories (Tomato vegetables, Banana fruits, Chicken other)',
      itemByName['Tomato'] && itemByName['Tomato'].category === 'vegetables'
      && itemByName['Banana'] && itemByName['Banana'].category === 'fruits' && itemByName['Banana'].unit === 'dozen'
      && itemByName['Chicken'] && itemByName['Chicken'].category === 'other'
      && itemByName['Pomegranate'] && itemByName['Pomegranate'].category === 'fruits', metaV3.items.length);
    const lahFruits = await j('/api/today?city=Lahore&category=fruits');
    check('Lahore fruits table: 1 row (Pomegranate), all fruits with Urdu unit کلو',
      lahFruits.rows.length === 1 && lahFruits.rows.every((r) => r.category === 'fruits' && r.unit_ur === 'کلو')
      && lahFruits.rows.some((r) => r.item === 'Pomegranate'), lahFruits.rows);
    const lahVeg = await j('/api/today?city=Lahore&category=vegetables');
    check('Lahore vegetables table: 6 rows, all vegetables',
      lahVeg.rows.length === 6 && lahVeg.rows.every((r) => r.category === 'vegetables'), lahVeg.rows.length);
    const okFruits = await j('/api/today?city=Sahiwal&category=fruits');
    check('Sahiwal fruits table: Banana only, dozen, unit_ur درجن',
      okFruits.rows.length === 1 && okFruits.rows[0].item === 'Banana' && okFruits.rows[0].unit === 'dozen' && okFruits.rows[0].unit_ur === 'درجن' && okFruits.rows[0].wholesale_per_unit === 80, okFruits.rows);
    const badCat = await j('/api/today?city=Lahore&category=bogus');
    check('bad category returns 400', badCat.error === 'category must be vegetables, fruits or other', badCat);
    const lahAll = await j('/api/today?city=Lahore');
    check('unfiltered Lahore still has all 7 rows with unit_ur', lahAll.rows.length === 7 && lahAll.rows.every((r) => r.unit_ur), lahAll.rows.length);

    // ---- v3.0: grounded rate chat (before Nowshera gains its own rows) ----
    const chatTom = await j('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: 'tomato rate in Lahore?' }) });
    check('chat answers a known rate: Lahore tomato 175.00/kg, dated, sourced',
      chatTom.found === true && chatTom.rate === 175 && chatTom.unit === 'kg' && chatTom.unit_ur === 'کلو' && chatTom.date === '2026-11-06' && chatTom.source === 'amis' && chatTom.fallback === false, chatTom);
    const chatUr = await j('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: 'ٹماٹر کا ریٹ لاہور میں؟' }) });
    check('chat answers in Urdu: ٹماٹر لاہور 175.00',
      chatUr.found === true && chatUr.rate === 175 && chatUr.district === 'Lahore' && chatUr.item === 'Tomato', chatUr);
    const chatBan = await j('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: 'banana price Okara' }) });
    check('chat: Okara banana 110 per dozen (درجن)',
      chatBan.found === true && chatBan.rate === 110 && chatBan.unit === 'dozen' && chatBan.unit_ur === 'درجن', chatBan);
    const chatNows = await j('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: 'tomato rate in Nowshera' }) });
    check('chat: Nowshera tomato has no own rate — labelled Peshawar fallback 150',
      chatNows.found === true && chatNows.fallback === true && chatNows.nearest_rates_from === 'Peshawar' && chatNows.rate === 150 && chatNows.district === 'Nowshera', chatNows);
    const chatNowsUr = await j('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: 'پیاز کا ریٹ نوشہرہ میں؟' }) });
    check('chat Urdu: Nowshera onion falls back to Peshawar 120, labelled',
      chatNowsUr.found === true && chatNowsUr.fallback === true && chatNowsUr.nearest_rates_from === 'Peshawar' && chatNowsUr.rate === 120 && chatNowsUr.item === 'Onion', chatNowsUr);
    const chatBanLhr = await j('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: 'banana price Lahore' }) });
    check('chat: no banana in Lahore — no rate found, no price returned',
      chatBanLhr.found === false && chatBanLhr.rate === null && chatBanLhr.item === 'Banana' && chatBanLhr.district === 'Lahore', chatBanLhr);
    const chatUnknown = await j('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: 'dragon fruit rate in Lahore' }) });
    check('chat: unknown item — no rate found, no price invented',
      chatUnknown.found === false && chatUnknown.rate === null, chatUnknown);
    const chatNoDist = await j('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: 'tomato rate' }) });
    check('chat: no district named — asks for the district, no price',
      chatNoDist.found === false && chatNoDist.rate === null && /district/i.test(chatNoDist.answer), chatNoDist);

    // ---- v3.0: district rate-admins ----
    const daBadCode = await j('/api/admin/district-admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'wrong', username: 'x-admin', password: 'StrongPass1', district: 'Nowshera' }) });
    check('district-admin create rejects wrong master code', daBadCode.error === 'bad admin code', daBadCode);
    const daCreate = await j('/api/admin/district-admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, username: 'nowshera-admin', password: 'StrongPass1', district: 'Nowshera', officer_name: 'Test Officer', designation: 'District Food Controller', documents: [{ doc_type: 'Posting-Transfer Order', doc_number: 'DFC-NSR-2026-014', issuing_authority: 'Food Department, Khyber Pakhtunkhwa', issue_date: '2026-01-10' }] }) });
    check('master creates district admin for Nowshera (no hash leaked)',
      daCreate.ok === true && daCreate.username === 'nowshera-admin' && daCreate.district === 'Nowshera' && !daCreate.password_hash, daCreate);
    const daActivate = await j('/api/admin/district-admin/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, username: 'nowshera-admin' }) });
    check('master activates the Nowshera admin (accounts start inactive)',
      daActivate.ok === true && daActivate.active === true && daActivate.district === 'Nowshera', daActivate);
    const daDup = await j('/api/admin/district-admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, username: 'nowshera-admin', password: 'StrongPass1', district: 'Mardan' }) });
    check('duplicate district-admin username rejected', daDup.error === 'username already exists', daDup);
    const daShort = await j('/api/admin/district-admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, username: 'short-admin', password: 'short', district: 'Mardan' }) });
    check('short district-admin password rejected', daShort.error === 'password must be at least 8 characters', daShort);
    const daNoDist = await j('/api/admin/district-admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, username: 'nowhere-admin', password: 'StrongPass1', district: 'Nowhere' }) });
    check('district-admin for unknown district rejected', daNoDist.error === 'unknown district', daNoDist);
    const daBadLogin = await j('/api/district-admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'nowshera-admin', password: 'WrongPass1' }) });
    check('district-admin login rejects wrong password', daBadLogin.error === 'bad username or password', daBadLogin);
    const daLogin = await j('/api/district-admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'nowshera-admin', password: 'StrongPass1' }) });
    check('district-admin login returns a token for Nowshera',
      daLogin.ok === true && typeof daLogin.token === 'string' && daLogin.token.length === 64 && daLogin.district === 'Nowshera', { ok: daLogin.ok, district: daLogin.district, tokenLen: daLogin.token && daLogin.token.length });
    const daToken = daLogin.token;
    const daList = await j('/api/admin/district-admins', { headers: { 'X-Master-Code': CODE } });
    check('master lists district admins (nowshera-admin → Nowshera)',
      daList.admins && daList.admins.some((a) => a.username === 'nowshera-admin' && a.district === 'Nowshera') && !daList.admins.some((a) => a.password_hash), daList.admins);
    const daListBad = await j('/api/admin/district-admins', { headers: { 'X-Master-Code': 'wrong' } });
    check('district-admin list rejects wrong master code', daListBad.error === 'bad admin code', daListBad);
    const daRate = await j('/api/district-admin/rate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: daToken, district: 'Nowshera', item: 'Tomato', price: 145, unit: 'kg', source: 'Nowshera market committee list', date: todayStr }) });
    check('district admin adds a rate for their own district',
      daRate.ok === true && daRate.district === 'Nowshera' && daRate.item === 'Tomato' && daRate.price === 145, daRate);
    const nowsOwn = await j('/api/today?city=Nowshera');
    check('Nowshera now shows its own Tomato 145 retail, labelled with source',
      nowsOwn.date === todayStr && nowsOwn.nearest_rates_from === null && nowsOwn.rows.some((r) => r.item === 'Tomato' && r.retail_bazaar === 145 && r.source.includes('Nowshera market committee list')), nowsOwn);
    const daOther = await j('/api/district-admin/rate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: daToken, district: 'Lahore', item: 'Tomato', price: 145, unit: 'kg', source: 'x', date: todayStr }) });
    check('district admin gets 403 on another district', daOther.error === 'district admins can only add rates for their own district', daOther);
    const daNoSource = await j('/api/district-admin/rate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: daToken, district: 'Nowshera', item: 'Tomato', price: 145, unit: 'kg', source: '', date: todayStr }) });
    check('district-admin rate without a source is rejected', daNoSource.error === 'source name required', daNoSource);
    const daFuture = await j('/api/district-admin/rate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: daToken, district: 'Nowshera', item: 'Tomato', price: 145, unit: 'kg', source: 'x', date: '2999-01-01' }) });
    check('district-admin rate with a future date is rejected', daFuture.error === 'date must be YYYY-MM-DD and not in the future', daFuture);
    const daBadItem = await j('/api/district-admin/rate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: daToken, district: 'Nowshera', item: 'Dragon Fruit', price: 145, unit: 'kg', source: 'x', date: todayStr }) });
    check('district-admin rate for an unknown item is rejected', daBadItem.error === 'unknown item — ask the master to add it first', daBadItem);
    const daMyRates = await j('/api/district-admin/my-rates', { headers: { Authorization: 'Bearer ' + daToken } });
    check('district admin sees their own entries',
      daMyRates.district === 'Nowshera' && daMyRates.rows.some((r) => r.item === 'Tomato' && r.rb === 145), daMyRates);
    const chatOwn = await j('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: 'tomato rate in Nowshera' }) });
    check('chat: Nowshera tomato is now its own rate 145, no fallback',
      chatOwn.found === true && chatOwn.fallback === false && chatOwn.rate === 145 && chatOwn.nearest_rates_from === null, chatOwn);
    const daDel = await j('/api/district-admin/rate/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: daToken, district: 'Nowshera', item: 'Tomato', date: todayStr }) });
    check('district admin deletes their own rate', daDel.ok === true && daDel.deleted === 1, daDel);
    const nowsAfterDel = await j('/api/today?city=Nowshera');
    check('Nowshera is back to the labelled Peshawar fallback after delete',
      nowsAfterDel.nearest_rates_from === 'Peshawar' && nowsAfterDel.rows.length > 0, nowsAfterDel);

    // ---- v3.0: review queue ----
    const rq1 = await j('/api/review/propose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, item: 'Onion', district: 'Mardan', price: 175, unit: 'kg', source: 'Mardan market list', date: todayStr }) });
    check('master proposes a rate to the review queue', rq1.ok === true && Number.isFinite(rq1.id) && rq1.duplicate === false, rq1);
    const rqDup = await j('/api/review/propose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, item: 'Onion', district: 'Mardan', price: 175, unit: 'kg', source: 'Mardan market list', date: todayStr }) });
    check('same proposal twice is one queue entry (deduped)', rqDup.ok === true && rqDup.duplicate === true && rqDup.id === rq1.id, rqDup);
    const rqList = await j('/api/review/queue', { headers: { 'X-Master-Code': CODE } });
    check('master sees the pending Mardan proposal',
      rqList.rows.some((r) => r.id === rq1.id && r.status === 'pending' && r.item === 'Onion' && r.district === 'Mardan'), rqList.rows);
    const rqOther = await j('/api/review/propose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: daToken, item: 'Onion', district: 'Lahore', price: 175, unit: 'kg', source: 'x', date: todayStr }) });
    check('district admin cannot propose for another district', rqOther.error === 'district admins can only propose rates for their own district', rqOther);
    const rqOwn = await j('/api/review/propose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: daToken, item: 'Onion', district: 'Nowshera', price: 120, unit: 'kg', source: 'Nowshera market list', date: todayStr }) });
    check('district admin proposes for their own district', rqOwn.ok === true && Number.isFinite(rqOwn.id), rqOwn);
    const rqScoped = await j('/api/review/queue', { headers: { Authorization: 'Bearer ' + daToken } });
    check('district admin sees only their own district in the queue',
      rqScoped.rows.some((r) => r.id === rqOwn.id) && !rqScoped.rows.some((r) => r.id === rq1.id), rqScoped.rows);
    const rqDecideOther = await j('/api/review/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: daToken, id: rq1.id, decision: 'approve' }) });
    check('district admin cannot decide another district’s proposal', rqDecideOther.error === 'district admins can only decide their own district', rqDecideOther);
    const rqReject = await j('/api/review/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, id: rq1.id, decision: 'reject' }) });
    check('master rejects the Mardan proposal', rqReject.ok === true && rqReject.decision === 'rejected', rqReject);
    const mardanHist = await j('/api/history?item=Onion&city=Mardan');
    check('rejected proposal never reaches the public (Mardan onion history empty)', mardanHist.points.length === 0, mardanHist.points);
    const rqDecideAgain = await j('/api/review/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, id: rq1.id, decision: 'approve' }) });
    check('deciding an already-decided entry returns 409', rqDecideAgain.error === 'already decided: rejected', rqDecideAgain);
    const rqApprove = await j('/api/review/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, id: rqOwn.id, decision: 'approve' }) });
    check('master approves the Nowshera proposal', rqApprove.ok === true && rqApprove.decision === 'approved', rqApprove);
    const nowsOnion = await j('/api/today?city=Nowshera');
    check('approved Nowshera onion 120 shows to the public with its source',
      nowsOnion.rows.some((r) => r.item === 'Onion' && r.retail_bazaar === 120 && r.source === 'Nowshera market list'), nowsOnion);
    // Review-queue wholesale convention: proposals are entered per unit
    // ("Rs per kg" on the form, like a head's direct entry), and approval
    // must store them as Rs/100kg — approving 175/kg used to publish
    // Rs 1.75/kg. A dozen proposal stays per dozen.
    const rqWs = await j('/api/review/propose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, item: 'Tomato', district: 'Harnai', price: 175, unit: 'kg', kind: 'wholesale', source: 'Harnai market list', date: todayStr }) });
    check('wholesale proposal (per kg) enters the queue', rqWs.ok === true && Number.isFinite(rqWs.id), rqWs);
    const rqWsOk = await j('/api/review/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, id: rqWs.id, decision: 'approve' }) });
    check('wholesale proposal approves', rqWsOk.ok === true && rqWsOk.decision === 'approved', rqWsOk);
    const harnai = await j('/api/today?city=Harnai');
    check('approved wholesale proposal publishes as 175/kg (not 1.75)',
      harnai.rows.some((r) => r.item === 'Tomato' && r.wholesale_per_unit === 175 && r.source === 'Harnai market list'), harnai);
    const rqDz = await j('/api/review/propose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, item: 'Banana', district: 'Chagai', price: 125, unit: 'dozen', kind: 'wholesale', source: 'Chagai market list', date: todayStr }) });
    check('wholesale dozen proposal enters the queue', rqDz.ok === true && Number.isFinite(rqDz.id), rqDz);
    const rqDzOk = await j('/api/review/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, id: rqDz.id, decision: 'approve' }) });
    check('wholesale dozen proposal approves', rqDzOk.ok === true && rqDzOk.decision === 'approved', rqDzOk);
    const zhob = await j('/api/today?city=Chagai');
    check('approved wholesale dozen proposal publishes as 125/dozen',
      zhob.rows.some((r) => r.item === 'Banana' && r.wholesale_per_unit === 125 && r.unit === 'dozen'), zhob);

    // ---- v3.0: district-admin login lockout ----
    const daLock = await j('/api/admin/district-admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, username: 'lockout-admin', password: 'StrongPass1', district: 'Mardan', officer_name: 'Lockout Officer', designation: 'District Food Controller', documents: [{ doc_type: 'Posting-Transfer Order', doc_number: 'DFC-MRD-2026-009', issuing_authority: 'Food Department, Khyber Pakhtunkhwa', issue_date: '2026-01-10' }] }) });
    check('lockout test admin created', daLock.ok === true, daLock);
    const daLockAct = await j('/api/admin/district-admin/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, username: 'lockout-admin' }) });
    check('lockout test admin activated', daLockAct.ok === true && daLockAct.active === true, daLockAct);
    for (let i = 0; i < 5; i++) {
      await j('/api/district-admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'lockout-admin', password: 'WrongPass1' }) });
    }
    const daLocked = await j('/api/district-admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'lockout-admin', password: 'StrongPass1' }) });
    check('5 failed logins lock the account (6th attempt 429 even with the right password)',
      daLocked.error === 'too many failed logins — try again in 15 minutes', daLocked);

    // ---- QA pass (2026-11-05): security, wholesale dozen bug, sessions, chat, polish ----
    const health = await j('/health');
    check('GET /health answers {ok:true} (platform health check, no auth, no DB)',
      health.ok === true, health);
    const fav = await fetch(BASE + '/favicon.ico');
    check('favicon serves 200 (no 404 in the console)', fav.status === 200 && (await fav.text()).includes('<svg'), fav.status);
    const robots = await fetch(BASE + '/robots.txt');
    check('robots.txt serves 200', robots.status === 200 && (await robots.text()).includes('User-agent'), robots.status);
    const recentQuery = await j(`/api/admin/recent?code=${CODE}`);
    check('master code in a URL is rejected (no secrets in query strings)',
      recentQuery.error === 'bad admin code', recentQuery);
    const recentHeader = await j('/api/admin/recent', { headers: { 'X-Master-Code': CODE } });
    check('master code via X-Master-Code header works for admin reads',
      Array.isArray(recentHeader.rows), recentHeader);
    const queueQuery = await j(`/api/review/queue?code=${CODE}`);
    check('review queue via ?code= in a URL is rejected',
      queueQuery.error === 'master code or district-admin login required', queueQuery);
    const myRatesQuery = await j('/api/district-admin/my-rates?token=' + encodeURIComponent(daToken));
    check('district-admin token in a URL is rejected (Authorization header only)',
      myRatesQuery.error === 'district-admin login required', myRatesQuery);
    const admHtml = await (await fetch(BASE + '/admin.html')).text();
    check('admin page never shows the master code in its UI',
      !admHtml.includes(CODE), admHtml.length);
    const homeQaHtml = await (await fetch(BASE + '/')).text();
    check('homepage has an About / How it works section with the owner contact',
      homeQaHtml.includes('id="about"') && homeQaHtml.includes('mhkh3200@gmail.com') && homeQaHtml.includes('How it works'), homeQaHtml.length);
    const cssText = await (await fetch(BASE + '/styles.css')).text();
    check('controls are 44px min-height and 16px font (mobile touch targets, no iOS zoom)',
      cssText.includes('min-height: 44px') && cssText.includes('font-size: 16px'), cssText.length);
    const daBananaWs = await j('/api/district-admin/rate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: daToken, district: 'Nowshera', item: 'Banana', price: 125, unit: 'dozen', source: 'Nowshera market committee list', date: todayStr, kind: 'wholesale' }) });
    check('district admin adds a wholesale Banana 125/dozen',
      daBananaWs.ok === true && daBananaWs.price === 125, daBananaWs);
    const nowsBanana = await j('/api/today?city=Nowshera');
    check('wholesale dozen is NOT multiplied by 100 (Banana shows 125/dozen, not 12,500)',
      nowsBanana.rows.some((r) => r.item === 'Banana' && r.unit === 'dozen' && r.wholesale_per_unit === 125), nowsBanana.rows);
    const daTomatoWs = await j('/api/district-admin/rate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: daToken, district: 'Nowshera', item: 'Tomato', price: 145, unit: 'kg', source: 'Nowshera market committee list', date: todayStr, kind: 'wholesale' }) });
    const nowsTomatoWs = await j('/api/today?city=Nowshera');
    check('wholesale kg still converts Rs/kg to Rs/100kg (Tomato 145/kg shows 145)',
      daTomatoWs.ok === true && nowsTomatoWs.rows.some((r) => r.item === 'Tomato' && r.wholesale_per_unit === 145), nowsTomatoWs.rows);
    const daMyRates2 = await j('/api/district-admin/my-rates', { headers: { Authorization: 'Bearer ' + daToken } });
    check('my-rates stores the dozen wholesale as-is (raw 125, not 12500)',
      daMyRates2.rows.some((r) => r.item === 'Banana' && r.w === 125), daMyRates2.rows);
    const daDelNone = await j('/api/district-admin/rate/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: daToken, district: 'Nowshera', item: 'Tomato', date: '2026-01-01' }) });
    check('deleting a rate that does not exist returns 404, not a false "Deleted"',
      daDelNone.error === 'nothing deleted — only your own district-admin entries can be deleted', daDelNone);
    const chatApple = await j('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q: 'apple rate in Nowshera?' }) });
    check('chat says plainly when an item is not tracked, and names what is tracked',
      chatApple.found === false && /don.t track/i.test(chatApple.answer || '') && (chatApple.answer || '').includes('Tomato'), chatApple);
    const rqKindA = await j('/api/review/propose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, item: 'Onion', district: 'Mardan', price: 175, unit: 'kg', source: 'Mardan market list', date: todayStr }) });
    const rqKindB = await j('/api/review/propose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, item: 'Onion', district: 'Mardan', price: 175, unit: 'kg', source: 'Mardan market list', date: todayStr, kind: 'wholesale' }) });
    check('review dedupe treats retail and wholesale as different proposals (kind is part of the key)',
      rqKindA.ok === true && rqKindB.ok === true && rqKindB.duplicate === false && rqKindB.id !== rqKindA.id, { a: rqKindA, b: rqKindB });
    await j('/api/review/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, id: rqKindA.id, decision: 'reject' }) });
    await j('/api/review/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, id: rqKindB.id, decision: 'reject' }) });
    const pwCreate = await j('/api/admin/district-admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, username: 'pwchange-admin', password: 'StrongPass1', district: 'Swabi', officer_name: 'Pw Officer', designation: 'District Food Controller', documents: [{ doc_type: 'Appointment Letter', doc_number: 'PPSC-2024-122', issuing_authority: 'Punjab Public Service Commission', issue_date: '2024-06-15' }] }) });
    check('password-change test admin created', pwCreate.ok === true, pwCreate);
    const pwAct = await j('/api/admin/district-admin/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, username: 'pwchange-admin' }) });
    check('password-change test admin activated', pwAct.ok === true && pwAct.active === true, pwAct);
    const pwLogin = await j('/api/district-admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'pwchange-admin', password: 'StrongPass1' }) });
    check('password-change test admin logs in', pwLogin.ok === true && typeof pwLogin.token === 'string', { ok: pwLogin.ok });
    const pwToken = pwLogin.token;
    const pwChange = await j('/api/district-admin/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + pwToken }, body: JSON.stringify({ old_password: 'StrongPass1', new_password: 'NewStrongPass2' }) });
    check('district admin changes their own password', pwChange.ok === true, pwChange);
    const pwOld = await j('/api/district-admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'pwchange-admin', password: 'StrongPass1' }) });
    check('old password stops working after a change', pwOld.error === 'bad username or password', pwOld);
    const pwNew = await j('/api/district-admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'pwchange-admin', password: 'NewStrongPass2' }) });
    check('new password works', pwNew.ok === true && typeof pwNew.token === 'string', { ok: pwNew.ok });
    const pwReset = await j('/api/admin/district-admin/reset-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, username: 'pwchange-admin', password: 'ResetPass123' }) });
    check('master can reset a district-admin password', pwReset.ok === true && pwReset.username === 'pwchange-admin', pwReset);
    const pwResetLogin = await j('/api/district-admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'pwchange-admin', password: 'ResetPass123' }) });
    check('reset password works, previous password does not',
      pwResetLogin.ok === true, { ok: pwResetLogin.ok });
    const pwResetOld = await j('/api/district-admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'pwchange-admin', password: 'NewStrongPass2' }) });
    check('reset ends the previous password', pwResetOld.error === 'bad username or password', pwResetOld);
    const loLogin = await j('/api/district-admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'pwchange-admin', password: 'ResetPass123' }) });
    const loOut = await j('/api/district-admin/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + loLogin.token }, body: JSON.stringify({}) });
    check('server-side logout answers ok', loOut.ok === true, loOut);
    const loAfter = await j('/api/district-admin/my-rates', { headers: { Authorization: 'Bearer ' + loLogin.token } });
    check('after logout the token is dead (401), not valid for 24h',
      loAfter.error === 'district-admin login required', loAfter);

    // ---- v3.1: licensed district-head admins (official districts) ----
    // v3.2 rework: officers hold NO licence — the credential is the
    // appointment document (appointment letter / posting-transfer order /
    // service card / Market Committee authorisation / CNIC). Creation takes
    // a structured `documents` array; a free-text licence_ref is not
    // accepted any more. The licence_ref column now stores the primary
    // document reference ("Appointment Letter #PPSC-2024-118").
    const LIC_LHR = 'PPSC-2024-118';
    const DOC_LHR = [{ doc_type: 'Appointment Letter', doc_number: LIC_LHR, issuing_authority: 'Punjab Public Service Commission', issue_date: '2024-06-15' }];
    const licNoDocs = await j('/api/admin/district-admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, username: 'licence-test-admin', password: 'StrongPass1', district: 'Multan', officer_name: 'Test Officer', designation: 'District Food Controller' }) });
    check('district-admin creation without documents is rejected',
      licNoDocs.error && licNoDocs.error.includes('at least one appointment document'), licNoDocs);
    const licBadType = await j('/api/admin/district-admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, username: 'licence-test-admin', password: 'StrongPass1', district: 'Multan', officer_name: 'Test Officer', designation: 'District Food Controller', documents: [{ doc_type: 'Driving Licence', doc_number: 'DL-1', issuing_authority: 'X', issue_date: '2024-01-01' }] }) });
    check('an invented document type is rejected (only real govt documents)',
      licBadType.error && licBadType.error.includes('doc_type must be one of'), licBadType);
    const licNoDesig = await j('/api/admin/district-admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, username: 'licence-test-admin', password: 'StrongPass1', district: 'Multan', officer_name: 'Test Officer', documents: DOC_LHR }) });
    check('district-admin creation without designation is rejected',
      licNoDesig.error && licNoDesig.error.startsWith('designation required'), licNoDesig);
    const licNoOfficer = await j('/api/admin/district-admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, username: 'licence-test-admin', password: 'StrongPass1', district: 'Multan', designation: 'District Food Controller', documents: DOC_LHR }) });
    check('district-admin creation without officer_name is rejected',
      licNoOfficer.error && licNoOfficer.error.startsWith('officer_name required'), licNoOfficer);
    const licLhr = await j('/api/admin/district-admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, username: 'lahore-admin', password: 'StrongPass1', district: 'Lahore', officer_name: 'Ahmed Raza', designation: 'District Food Controller', documents: DOC_LHR }) });
    check('licensed district admin is created INACTIVE with documents on file (no hash leaked)',
      licLhr.ok === true && licLhr.active === false && licLhr.designation === 'District Food Controller' && licLhr.documents && licLhr.documents[0].doc_number === LIC_LHR && licLhr.documents[0].doc_type === 'Appointment Letter' && !licLhr.password_hash, licLhr);
    const licLoginInactive = await j('/api/district-admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'lahore-admin', password: 'StrongPass1' }) });
    check('inactive account cannot log in (generic error, no hint it exists)',
      licLoginInactive.error === 'bad username or password', licLoginInactive);
    const licList = await j('/api/admin/district-admins', { headers: { 'X-Master-Code': CODE } });
    const licRow = licList.admins.find((a) => a.username === 'lahore-admin');
    check('master list shows designation, documents and inactive status',
      !!licRow && licRow.designation === 'District Food Controller' && licRow.documents && licRow.documents[0].doc_number === LIC_LHR && licRow.licence_ref === 'Appointment Letter #' + LIC_LHR && licRow.active === 0 && licRow.officer_name === 'Ahmed Raza' && !licRow.password_hash, licRow);
    const licAct = await j('/api/admin/district-admin/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, username: 'lahore-admin' }) });
    check('master activates the licensed Lahore admin',
      licAct.ok === true && licAct.active === true && licAct.district === 'Lahore', licAct);
    const licToday = await j('/api/today?city=Lahore');
    check('official district carries designation + district in the public response',
      !!licToday.official && licToday.official.designation === 'District Food Controller' && licToday.official.district === 'Lahore', licToday.official);
    const licLive = await j('/api/live');
    check('live summary counts 4 official districts (Nowshera, Mardan, Swabi, Lahore)',
      licLive.official_districts === 4, licLive.official_districts);
    const licLeak = JSON.stringify(licToday) + JSON.stringify(licLive) + JSON.stringify(await j('/api/meta'));
    check('document numbers and officer name never appear in any public response',
      !licLeak.includes(LIC_LHR) && !licLeak.includes('Ahmed Raza'), licLeak.slice(0, 200));
    const licMasterSnap = await j('/api/admin/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, city: 'Lahore', item: 'Onion', date: todayStr, wholesale: 15000, source: 'test' }) });
    check('official district rejects the master direct rate entry (403)',
      licMasterSnap.error && licMasterSnap.error.includes('officially managed'), licMasterSnap);
    const licLogin = await j('/api/district-admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'lahore-admin', password: 'StrongPass1' }) });
    check('licensed admin logs in after activation', licLogin.ok === true && licLogin.district === 'Lahore' && typeof licLogin.token === 'string', { ok: licLogin.ok, district: licLogin.district });
    const licToken = licLogin.token;
    const licRate = await j('/api/district-admin/rate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: licToken, district: 'Lahore', item: 'Tomato', price: 150, unit: 'kg', source: 'Lahore market committee list', date: todayStr }) });
    check('licensed admin manages their own district',
      licRate.ok === true && licRate.district === 'Lahore' && licRate.item === 'Tomato' && licRate.price === 150, licRate);
    const licToday2 = await j('/api/today?city=Lahore');
    check('official district shows its own rate + the managed-by designation',
      licToday2.rows.some((r) => r.item === 'Tomato' && r.retail_bazaar === 150) && licToday2.official && licToday2.official.designation === 'District Food Controller', licToday2);
    const licRwp = await j('/api/admin/district-admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, username: 'rawalpindi-admin', password: 'StrongPass1', district: 'Rawalpindi', officer_name: 'Sara Khan', designation: 'District Food Controller', documents: [{ doc_type: 'Posting-Transfer Order', doc_number: 'DFC-RWP-2026-007', issuing_authority: 'Food Department, Punjab', issue_date: '2026-02-01' }] }) });
    check('second licensed admin created for Rawalpindi (inactive)',
      licRwp.ok === true && licRwp.active === false, licRwp);
    const licRwpAct = await j('/api/admin/district-admin/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, username: 'rawalpindi-admin' }) });
    check('Rawalpindi admin activated', licRwpAct.ok === true && licRwpAct.active === true, licRwpAct);
    const licCross = await j('/api/district-admin/rate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: licToken, district: 'Rawalpindi', item: 'Tomato', price: 150, unit: 'kg', source: 'x', date: todayStr }) });
    check('admin A gets 403 on admin B’s district rates',
      licCross.error === 'district admins can only add rates for their own district', licCross);
    const licListAsAdmin = await j('/api/admin/district-admins', { headers: { Authorization: 'Bearer ' + licToken } });
    check('district admin cannot list admins (master-only endpoint)',
      licListAsAdmin.error === 'bad admin code', licListAsAdmin);
    const licAuditAsAdmin = await j('/api/admin/district-admin/audit', { headers: { Authorization: 'Bearer ' + licToken } });
    check('district admin cannot read the audit log (master-only)',
      licAuditAsAdmin.error === 'bad admin code', licAuditAsAdmin);
    const licDupDistrict = await j('/api/admin/district-admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, username: 'lahore-second-admin', password: 'StrongPass1', district: 'Lahore', officer_name: 'Second Officer', designation: 'District Food Controller', documents: DOC_LHR }) });
    check('one head per district: a second admin for Lahore is rejected',
      licDupDistrict.error && licDupDistrict.error.startsWith('district already has a district admin'), licDupDistrict);
    const licSusp = await j('/api/admin/district-admin/suspend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, username: 'lahore-admin' }) });
    check('master suspends the Lahore admin', licSusp.ok === true && licSusp.active === false, licSusp);
    const licLoginSusp = await j('/api/district-admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'lahore-admin', password: 'StrongPass1' }) });
    check('suspended account login is blocked (generic error)',
      licLoginSusp.error === 'bad username or password', licLoginSusp);
    const licDeadToken = await j('/api/district-admin/my-rates', { headers: { Authorization: 'Bearer ' + licToken } });
    check('suspension ends the live session immediately (old token 401)',
      licDeadToken.error === 'district-admin login required', licDeadToken);
    const licToday3 = await j('/api/today?city=Lahore');
    check('suspended district is no longer official (managed-by line gone)',
      licToday3.official === null, licToday3.official);
    const licMasterSnap2 = await j('/api/admin/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, city: 'Lahore', item: 'Onion', date: todayStr, wholesale: 15000, source: 'test' }) });
    check('master can enter rates again once the district is not official',
      licMasterSnap2.ok === true, licMasterSnap2);
    const licReact = await j('/api/admin/district-admin/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, username: 'lahore-admin' }) });
    check('master reactivates the Lahore admin', licReact.ok === true && licReact.active === true, licReact);
    const licLogin2 = await j('/api/district-admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'lahore-admin', password: 'StrongPass1' }) });
    check('reactivated admin logs in again', licLogin2.ok === true && typeof licLogin2.token === 'string', { ok: licLogin2.ok });
    const licToday4 = await j('/api/today?city=Lahore');
    check('reactivated district is official again',
      !!licToday4.official && licToday4.official.designation === 'District Food Controller' && licToday4.official.district === 'Lahore', licToday4.official);
    const licMultan = await j('/api/today?city=Multan');
    check('non-official district shows no managed-by line',
      licMultan.official === null, licMultan.official);
    const licHome = await (await fetch(BASE + '/')).text();
    check('homepage has the official-managed-by line element',
      licHome.includes('id="officialLine"'), licHome.length);
    const licAudit = await j('/api/admin/district-admin/audit', { headers: { 'X-Master-Code': CODE } });
    const licRows = licAudit.rows.filter((r) => r.username === 'lahore-admin');
    const licActions = new Set(licRows.map((r) => r.action));
    check('audit log records the licensed admin’s actions with designation + document reference',
      ['admin-created', 'admin-activated', 'admin-suspended', 'rate-added'].every((a) => licActions.has(a))
      && licRows.every((r) => r.designation === 'District Food Controller' && r.licence_ref === 'Appointment Letter #' + LIC_LHR), licRows.map((r) => r.action));

    // ---- v3.2: registration + approval, documents + scans, scoped places, managers ----
    // Per the govt-roles research: officers hold NO commercial licence.
    // Their credential is the appointment document — appointment letter,
    // posting-transfer order, service card, Market Committee authorisation
    // or CNIC. A manager registers, the district head approves; a head
    // registers, the master approves. Pending/rejected accounts can never
    // log in. Places are assigned by the head only, never requested.
    const DOC_MGR_LHR = [{ doc_type: 'Appointment Letter', doc_number: 'PPSC-2024-201', issuing_authority: 'Punjab Public Service Commission', issue_date: '2024-06-15' }];
    const png1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    async function postMultipart(url, token, fields, fileField, fileBytes, fileName, fileType) {
      const fd = new FormData();
      for (const [k, v] of Object.entries(fields)) fd.append(k, String(v));
      if (fileBytes !== null) fd.append(fileField, new Blob([fileBytes], { type: fileType || 'image/png' }), fileName || 'file.png');
      const r = await fetch(BASE + url, { method: 'POST', headers: token ? { Authorization: 'Bearer ' + token } : {}, body: fd });
      const t = await r.text();
      let parsed = null;
      try { parsed = JSON.parse(t); } catch { parsed = null; }
      return { status: r.status, body: parsed, raw: t };
    }
    async function headToken(username, password) {
      const r = await j('/api/district-admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }) });
      return r.token || null;
    }
    // --- head registration + master approval (Faisalabad has no head yet) ---
    const m2HeadReg = await j('/api/register/head', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'faisalabad-head', password: 'StrongPass1', district: 'Faisalabad', officer_name: 'Bilal Ahmed', designation: 'District Food Controller', documents: [{ doc_type: 'Appointment Letter', doc_number: 'PPSC-2024-301', issuing_authority: 'Punjab Public Service Commission', issue_date: '2024-06-15' }] }) });
    check('head registration creates a PENDING account (cannot log in yet)',
      m2HeadReg.ok === true && m2HeadReg.status === 'pending' && m2HeadReg.documents && m2HeadReg.documents[0].doc_number === 'PPSC-2024-301' && !m2HeadReg.password_hash, m2HeadReg);
    const m2HeadLoginPending = await headToken('faisalabad-head', 'StrongPass1');
    check('pending head cannot log in (generic error, no hint it exists)',
      m2HeadLoginPending === null, m2HeadLoginPending);
    const m2HeadRegNoDocs = await j('/api/register/head', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'nodocs-head', password: 'StrongPass1', district: 'Gujrat', officer_name: 'No Docs', designation: 'District Food Controller' }) });
    check('head registration without documents is rejected',
      m2HeadRegNoDocs.error && m2HeadRegNoDocs.error.includes('at least one appointment document'), m2HeadRegNoDocs);
    const m2HeadRegBadCnic = await j('/api/register/head', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'badcnic-head', password: 'StrongPass1', district: 'Gujrat', officer_name: 'Bad Cnic', designation: 'District Food Controller', documents: [{ doc_type: 'CNIC', doc_number: '12345', issuing_authority: 'NADRA', issue_date: '2020-01-01' }] }) });
    check('CNIC document with a wrong number (not 13 digits) is rejected',
      m2HeadRegBadCnic.error && m2HeadRegBadCnic.error.includes('CNIC document number must be 13 digits'), m2HeadRegBadCnic);
    const m2HeadRegLhr = await j('/api/register/head', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'lahore-head-2', password: 'StrongPass1', district: 'Lahore', officer_name: 'Second', designation: 'District Food Controller', documents: DOC_MGR_LHR }) });
    check('head registration for a district that already has a head is rejected',
      m2HeadRegLhr.error && m2HeadRegLhr.error.includes('already has a district head'), m2HeadRegLhr);
    const m2PendingHeads = await j('/api/admin/pending-heads', { headers: { 'X-Master-Code': CODE } });
    check('master sees the pending head registration (with documents, no hash)',
      Array.isArray(m2PendingHeads.pending) && m2PendingHeads.pending.some((r) => r.username === 'faisalabad-head' && r.documents && r.documents[0].doc_number === 'PPSC-2024-301' && !r.password_hash), m2PendingHeads);
    const m2ApproveHead = await j('/api/admin/head/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, username: 'faisalabad-head', decision: 'approve' }) });
    check('master approves the head registration',
      m2ApproveHead.ok === true && m2ApproveHead.decision === 'approved' && m2ApproveHead.appointed_by === 'master', m2ApproveHead);
    const m2FsdToken = await headToken('faisalabad-head', 'StrongPass1');
    check('approved head can log in (role head)', !!m2FsdToken, m2FsdToken);
    // Rejection path: Gujrat head registers, master rejects, login stays blocked.
    const m2GujReg = await j('/api/register/head', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'gujrat-head', password: 'StrongPass1', district: 'Gujrat', officer_name: 'Gujrat Officer', designation: 'District Food Controller', documents: [{ doc_type: 'Posting-Transfer Order', doc_number: 'DFC-GJT-2026-003', issuing_authority: 'Food Department, Punjab', issue_date: '2026-02-01' }] }) });
    check('Gujrat head registration is pending', m2GujReg.ok === true && m2GujReg.status === 'pending', m2GujReg);
    const m2RejectHead = await j('/api/admin/head/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, username: 'gujrat-head', decision: 'reject' }) });
    check('master rejects the Gujrat head registration',
      m2RejectHead.ok === true && m2RejectHead.decision === 'rejected', m2RejectHead);
    const m2GujLogin = await headToken('gujrat-head', 'StrongPass1');
    check('rejected head cannot log in', m2GujLogin === null, m2GujLogin);
    const m2GujReg2 = await j('/api/register/head', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'gujrat-head-2', password: 'StrongPass1', district: 'Gujrat', officer_name: 'Gujrat Officer 2', designation: 'District Food Controller', documents: [{ doc_type: 'Appointment Letter', doc_number: 'PPSC-2024-302', issuing_authority: 'Punjab Public Service Commission', issue_date: '2024-06-15' }] }) });
    check('district stays open after a rejection (fresh registration allowed)',
      m2GujReg2.ok === true && m2GujReg2.status === 'pending', m2GujReg2);
    // --- licence scan upload (pending account only, approver-only viewing) ---
    const m2ScanDocId = m2GujReg2.documents[0].id;
    const m2ScanUp = await postMultipart('/api/register/scan', null, { username: 'gujrat-head-2', doc_number: 'PPSC-2024-302' }, 'scan', png1, 'letter.png', 'image/png');
    check('scan upload works for a pending account',
      m2ScanUp.status === 200 && m2ScanUp.body && m2ScanUp.body.ok === true && m2ScanUp.body.has_scan === true, m2ScanUp);
    const m2ScanOverwrite = await postMultipart('/api/register/scan', null, { username: 'gujrat-head-2', doc_number: 'PPSC-2024-302' }, 'scan', png1, 'letter2.png', 'image/png');
    check('a second scan upload cannot silently replace the first (409 — first upload wins)',
      m2ScanOverwrite.status === 409 && m2ScanOverwrite.body && /already attached/.test(m2ScanOverwrite.body.error || ''), m2ScanOverwrite);
    const m2ScanNoAuth = await fetch(BASE + '/api/documents/scan/' + m2ScanDocId);
    check('licence scan is not public (no auth → 403)', m2ScanNoAuth.status === 403, m2ScanNoAuth.status);
    const m2ScanMaster = await fetch(BASE + '/api/documents/scan/' + m2ScanDocId, { headers: { 'X-Master-Code': CODE } });
    check('master can view the scan (image returned)',
      m2ScanMaster.status === 200 && (m2ScanMaster.headers.get('content-type') || '').includes('image/png'), m2ScanMaster.status);
    const m2LhrToken = await headToken('lahore-admin', 'StrongPass1');
    const m2ScanOther = await fetch(BASE + '/api/documents/scan/' + m2ScanDocId, { headers: { Authorization: 'Bearer ' + m2LhrToken } });
    check('another district\'s head cannot view the scan (403)', m2ScanOther.status === 403, m2ScanOther.status);
    const m2ScanBad = await postMultipart('/api/register/scan', null, { username: 'gujrat-head-2', doc_number: 'PPSC-2024-302' }, 'scan', Buffer.from('hello world'), 'note.txt', 'text/plain');
    check('non-image scan upload is rejected',
      m2ScanBad.status === 400 && m2ScanBad.body && /image/i.test(m2ScanBad.body.error || '') && /PDF/i.test(m2ScanBad.body.error || ''), m2ScanBad);
    const m2ScanBig = await postMultipart('/api/register/scan', null, { username: 'gujrat-head-2', doc_number: 'PPSC-2024-302' }, 'scan', Buffer.alloc(5 * 1024 * 1024 + 1), 'big.png', 'image/png');
    check('oversize scan upload is rejected (413)', m2ScanBig.status === 413, m2ScanBig);
    const m2ApproveGuj2 = await j('/api/admin/head/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, username: 'gujrat-head-2', decision: 'approve' }) });
    check('master approves the Gujrat head (second try)', m2ApproveGuj2.ok === true && m2ApproveGuj2.decision === 'approved', m2ApproveGuj2);
    const m2ScanAfter = await postMultipart('/api/register/scan', null, { username: 'gujrat-head-2', doc_number: 'PPSC-2024-302' }, 'scan', png1, 'letter.png', 'image/png');
    check('scan upload after approval is rejected (pending only)', m2ScanAfter.status === 400, m2ScanAfter);
    // --- manager registration + head approval (Lahore) ---
    const m2MgrReg = await j('/api/register/manager', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'lahore-mgr-1', password: 'StrongPass1', district: 'Lahore', officer_name: 'Usman Tariq', designation: 'Market Committee Secretary', documents: DOC_MGR_LHR }) });
    check('manager registration creates a PENDING account',
      m2MgrReg.ok === true && m2MgrReg.status === 'pending' && m2MgrReg.role === 'manager' && !m2MgrReg.password_hash, m2MgrReg);
    const m2MgrLoginPending = await headToken('lahore-mgr-1', 'StrongPass1');
    check('pending manager cannot log in', m2MgrLoginPending === null, m2MgrLoginPending);
    const m2MgrRegNoDocs = await j('/api/register/manager', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'nodocs-mgr', password: 'StrongPass1', district: 'Lahore', officer_name: 'No Docs', designation: 'Market Committee Secretary' }) });
    check('manager registration without documents is rejected',
      m2MgrRegNoDocs.error && m2MgrRegNoDocs.error.includes('at least one appointment document'), m2MgrRegNoDocs);
    const m2PendingMgrs = await j('/api/district-admin/pending-managers', { headers: { Authorization: 'Bearer ' + m2LhrToken } });
    check('Lahore head sees the pending manager registration (with documents)',
      Array.isArray(m2PendingMgrs.pending) && m2PendingMgrs.pending.some((r) => r.username === 'lahore-mgr-1' && r.documents && r.documents[0].doc_number === 'PPSC-2024-201'), m2PendingMgrs);
    const m2ApproveMgr = await j('/api/district-admin/manager/approve', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m2LhrToken }, body: JSON.stringify({ username: 'lahore-mgr-1', decision: 'approve', appointment_ref: 'ORD-LHR-2026-101' }) });
    check('head approves the manager (appointment_ref recorded, appointed by the head)',
      m2ApproveMgr.ok === true && m2ApproveMgr.decision === 'approved' && m2ApproveMgr.appointed_by === 'lahore-admin' && m2ApproveMgr.appointment_ref === 'ORD-LHR-2026-101', m2ApproveMgr);
    const m2ApproveMgrNoRef = await j('/api/register/manager', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'lahore-mgr-9', password: 'StrongPass1', district: 'Lahore', officer_name: 'No Order', designation: 'Market Committee Secretary', documents: DOC_MGR_LHR }) });
    check('second manager registration is pending', m2ApproveMgrNoRef.ok === true && m2ApproveMgrNoRef.status === 'pending', m2ApproveMgrNoRef);
    const m2ApproveNoRef = await j('/api/district-admin/manager/approve', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m2LhrToken }, body: JSON.stringify({ username: 'lahore-mgr-9', decision: 'approve' }) });
    check('head cannot approve a manager without recording the appointment order',
      m2ApproveNoRef.error && m2ApproveNoRef.error.includes('appointment_ref required'), m2ApproveNoRef);
    const m2RejectMgr9 = await j('/api/district-admin/manager/approve', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m2LhrToken }, body: JSON.stringify({ username: 'lahore-mgr-9', decision: 'reject' }) });
    check('head rejects the no-order manager registration', m2RejectMgr9.ok === true && m2RejectMgr9.decision === 'rejected', m2RejectMgr9);
    const m2MgrLogin = await j('/api/district-admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'lahore-mgr-1', password: 'StrongPass1' }) });
    check('approved manager logs in (role manager, no places assigned yet)',
      m2MgrLogin.ok === true && m2MgrLogin.role === 'manager' && Array.isArray(m2MgrLogin.assigned_places) && m2MgrLogin.assigned_places.length === 0, m2MgrLogin);
    const m2MgrToken = m2MgrLogin.token;
    // Manager with no places assigned cannot propose anything.
    const m2PropNoPlace = await j('/api/review/propose', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m2MgrToken }, body: JSON.stringify({ item: 'Onion', district: 'Lahore', price: 190, unit: 'kg', kind: 'retail', source: 'Market Committee daily rate list', date: pktTodayStr(), place: 'Lahore Mandi' }) });
    check('manager with no assigned places cannot propose (403)',
      m2PropNoPlace.error && m2PropNoPlace.error.includes('not assigned to you'), m2PropNoPlace);
    const m2SetPlaces = await j('/api/district-admin/manager/places', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m2LhrToken }, body: JSON.stringify({ username: 'lahore-mgr-1', places: ['Lahore Mandi', 'Badami Bagh'] }) });
    check('head assigns the manager his places',
      m2SetPlaces.ok === true && m2SetPlaces.places && m2SetPlaces.places.length === 2, m2SetPlaces);
    const m2PropOk = await j('/api/review/propose', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m2MgrToken }, body: JSON.stringify({ item: 'Onion', district: 'Lahore', price: 190, unit: 'kg', kind: 'retail', source: 'Market Committee daily rate list', date: pktTodayStr(), place: 'Lahore Mandi' }) });
    check('manager proposes a rate for an assigned place',
      m2PropOk.ok === true && Number.isFinite(m2PropOk.id), m2PropOk);
    const m2TodayBefore = await j('/api/today?city=Lahore');
    const m2OnionBefore = m2TodayBefore.rows.find((r) => r.item === 'Onion');
    check('manager proposal is NOT live until the head approves it',
      !m2OnionBefore || m2OnionBefore.retail_bazaar !== 190, m2TodayBefore);
    const m2PropUnassigned = await j('/api/review/propose', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m2MgrToken }, body: JSON.stringify({ item: 'Onion', district: 'Lahore', price: 195, unit: 'kg', kind: 'retail', source: 'Market Committee daily rate list', date: pktTodayStr(), place: 'Akbar Mandi' }) });
    check('manager proposing for an unassigned place is 403',
      m2PropUnassigned.error && m2PropUnassigned.error.includes('not assigned to you'), m2PropUnassigned);
    const m2PropOtherDistrict = await j('/api/review/propose', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m2MgrToken }, body: JSON.stringify({ item: 'Onion', district: 'Rawalpindi', price: 195, unit: 'kg', kind: 'retail', source: 'Market Committee daily rate list', date: pktTodayStr(), place: 'Rawalpindi Mandi' }) });
    check('manager proposing for another district is 403',
      m2PropOtherDistrict.error && m2PropOtherDistrict.error.includes('own district'), m2PropOtherDistrict);
    const m2SelfApprove = await j('/api/review/decide', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m2MgrToken }, body: JSON.stringify({ id: m2PropOk.id, decision: 'approve' }) });
    check('manager cannot approve their own proposal (403)',
      m2SelfApprove.error && m2SelfApprove.error.includes('managers cannot approve'), m2SelfApprove);
    const m2DirectAdd = await j('/api/district-admin/rate', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m2MgrToken }, body: JSON.stringify({ item: 'Onion', district: 'Lahore', price: 199, unit: 'kg', kind: 'retail', source: 'Market Committee daily rate list', date: pktTodayStr(), place: 'Lahore Mandi' }) });
    check('manager cannot add rates directly (403, queue only)',
      m2DirectAdd.error && m2DirectAdd.error.includes('review queue'), m2DirectAdd);
    const m2MgrMyRates = await j('/api/district-admin/my-rates', { headers: { Authorization: 'Bearer ' + m2MgrToken } });
    check('manager cannot use the head\'s my-rates page (403)',
      m2MgrMyRates.error && /district heads/i.test(m2MgrMyRates.error), m2MgrMyRates);
    const m2MgrListMgrs = await j('/api/district-admin/managers', { headers: { Authorization: 'Bearer ' + m2MgrToken } });
    check('manager cannot list managers (403, heads only)',
      m2MgrListMgrs.error && m2MgrListMgrs.error.includes('district heads only'), m2MgrListMgrs);
    const m2HeadApproveProp = await j('/api/review/decide', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m2LhrToken }, body: JSON.stringify({ id: m2PropOk.id, decision: 'approve' }) });
    check('head approves the manager\'s proposal', m2HeadApproveProp.ok === true && m2HeadApproveProp.decision === 'approved', m2HeadApproveProp);
    const m2TodayAfter = await j('/api/today?city=Lahore');
    const m2OnionAfter = m2TodayAfter.rows.find((r) => r.item === 'Onion' && r.place === 'Lahore Mandi');
    check('approved proposal shows publicly (with place + source)',
      m2OnionAfter && m2OnionAfter.retail_bazaar === 190 && (m2OnionAfter.source || '').includes('Market Committee daily rate list'), m2TodayAfter);
    // Second manager (head-appointed) for queue isolation + places change.
    const m2Mgr2Create = await j('/api/district-admin/manager', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m2LhrToken }, body: JSON.stringify({ username: 'lahore-mgr-2', password: 'StrongPass1', name: 'Fatima Noor', designation: 'Food Inspector', appointment_ref: 'ORD-LHR-2026-102', documents: [{ doc_type: 'Service Card', doc_number: 'SC-2026-077', issuing_authority: 'Food Department, Punjab', issue_date: '2026-01-05' }] }) });
    check('head appoints a second manager directly (with documents)',
      m2Mgr2Create.ok === true && m2Mgr2Create.active === false && m2Mgr2Create.documents && m2Mgr2Create.documents[0].doc_number === 'SC-2026-077', m2Mgr2Create);
    const m2Mgr2Act = await j('/api/district-admin/manager/activate', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m2LhrToken }, body: JSON.stringify({ username: 'lahore-mgr-2' }) });
    check('head activates the second manager (documents on file)', m2Mgr2Act.ok === true && m2Mgr2Act.active === true, m2Mgr2Act);
    const m2SetPlaces2 = await j('/api/district-admin/manager/places', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m2LhrToken }, body: JSON.stringify({ username: 'lahore-mgr-2', places: ['Badami Bagh'] }) });
    check('head assigns the second manager one place', m2SetPlaces2.ok === true && m2SetPlaces2.places.length === 1, m2SetPlaces2);
    const m2Mgr2Login = await j('/api/district-admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'lahore-mgr-2', password: 'StrongPass1' }) });
    const m2Mgr2Token = m2Mgr2Login.token;
    check('second manager logs in (role manager, one assigned place)',
      m2Mgr2Login.role === 'manager' && m2Mgr2Login.assigned_places && m2Mgr2Login.assigned_places[0] === 'Badami Bagh', m2Mgr2Login);
    const m2Prop2 = await j('/api/review/propose', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m2Mgr2Token }, body: JSON.stringify({ item: 'Potato', district: 'Lahore', price: 95, unit: 'kg', kind: 'retail', source: 'Market Committee daily rate list', date: pktTodayStr(), place: 'Badami Bagh' }) });
    check('second manager proposes for his own place', m2Prop2.ok === true && Number.isFinite(m2Prop2.id), m2Prop2);
    const m2QueueMgr1 = await j('/api/review/queue?status=pending', { headers: { Authorization: 'Bearer ' + m2MgrToken } });
    check('manager 1 cannot see manager 2\'s proposals',
      Array.isArray(m2QueueMgr1.rows) && !m2QueueMgr1.rows.some((r) => r.id === m2Prop2.id), m2QueueMgr1);
    const m2QueueMgr2 = await j('/api/review/queue?status=pending', { headers: { Authorization: 'Bearer ' + m2Mgr2Token } });
    check('manager 2 sees only his own proposal',
      Array.isArray(m2QueueMgr2.rows) && m2QueueMgr2.rows.length === 1 && m2QueueMgr2.rows[0].id === m2Prop2.id, m2QueueMgr2);
    const m2QueueHead = await j('/api/review/queue?status=pending', { headers: { Authorization: 'Bearer ' + m2LhrToken } });
    check('head sees all pending proposals in his district',
      Array.isArray(m2QueueHead.rows) && m2QueueHead.rows.some((r) => r.id === m2Prop2.id), m2QueueHead);
    // Head changes manager 1's places: old place now 403, new place OK.
    const m2ChangePlaces = await j('/api/district-admin/manager/places', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m2LhrToken }, body: JSON.stringify({ username: 'lahore-mgr-1', places: ['Badami Bagh'] }) });
    check('head changes manager 1\'s places', m2ChangePlaces.ok === true && m2ChangePlaces.places.length === 1, m2ChangePlaces);
    const m2PropOldPlace = await j('/api/review/propose', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m2MgrToken }, body: JSON.stringify({ item: 'Onion', district: 'Lahore', price: 191, unit: 'kg', kind: 'retail', source: 'Market Committee daily rate list', date: pktTodayStr(), place: 'Lahore Mandi' }) });
    check('old place is 403 after the head changes places',
      m2PropOldPlace.error && m2PropOldPlace.error.includes('not assigned to you'), m2PropOldPlace);
    const m2PropNewPlace = await j('/api/review/propose', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m2MgrToken }, body: JSON.stringify({ item: 'Garlic', district: 'Lahore', price: 320, unit: 'kg', kind: 'retail', source: 'Market Committee daily rate list', date: pktTodayStr(), place: 'Badami Bagh' }) });
    check('new place works after the head changes places', m2PropNewPlace.ok === true && Number.isFinite(m2PropNewPlace.id), m2PropNewPlace);
    // Cross-district isolation at the head level.
    const m2RwpToken = await headToken('rawalpindi-admin', 'StrongPass1');
    const m2RwpMgr = await j('/api/district-admin/manager', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m2RwpToken }, body: JSON.stringify({ username: 'rwp-mgr-1', password: 'StrongPass1', name: 'Rwp Manager', designation: 'Food Inspector', appointment_ref: 'ORD-RWP-2026-001', documents: [{ doc_type: 'Service Card', doc_number: 'SC-2026-078', issuing_authority: 'Food Department, Punjab', issue_date: '2026-01-05' }] }) });
    check('Rawalpindi head appoints his own manager', m2RwpMgr.ok === true && m2RwpMgr.district === 'Rawalpindi', m2RwpMgr);
    const m2LhrMgrList = await j('/api/district-admin/managers', { headers: { Authorization: 'Bearer ' + m2LhrToken } });
    check('Lahore head cannot see Rawalpindi\'s manager',
      Array.isArray(m2LhrMgrList.managers) && !m2LhrMgrList.managers.some((r) => r.username === 'rwp-mgr-1') && m2LhrMgrList.managers.some((r) => r.username === 'lahore-mgr-1'), m2LhrMgrList);
    const m2LhrActRwp = await j('/api/district-admin/manager/activate', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m2LhrToken }, body: JSON.stringify({ username: 'rwp-mgr-1' }) });
    check('Lahore head activating another district\'s manager is 404 (not found in his district)',
      m2LhrActRwp.error && m2LhrActRwp.error.includes('unknown manager'), m2LhrActRwp);
    const m2RwpProp = await j('/api/review/propose', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m2RwpToken }, body: JSON.stringify({ item: 'Tomato', district: 'Rawalpindi', price: 150, unit: 'kg', kind: 'retail', source: 'Market Committee daily rate list', date: pktTodayStr() }) });
    check('Rawalpindi head proposes for his district', m2RwpProp.ok === true && Number.isFinite(m2RwpProp.id), m2RwpProp);
    const m2LhrQueue = await j('/api/review/queue?status=pending', { headers: { Authorization: 'Bearer ' + m2LhrToken } });
    check('Lahore head cannot see Rawalpindi\'s proposals',
      Array.isArray(m2LhrQueue.rows) && !m2LhrQueue.rows.some((r) => r.id === m2RwpProp.id), m2LhrQueue);
    // Suspension: login blocked + live session ended, then reactivation.
    const m2Susp = await j('/api/district-admin/manager/suspend', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m2LhrToken }, body: JSON.stringify({ username: 'lahore-mgr-1' }) });
    check('head suspends manager 1', m2Susp.ok === true && m2Susp.active === false, m2Susp);
    const m2SuspLogin = await headToken('lahore-mgr-1', 'StrongPass1');
    check('suspended manager login is blocked', m2SuspLogin === null, m2SuspLogin);
    const m2DeadToken = await j('/api/review/queue?status=pending', { headers: { Authorization: 'Bearer ' + m2MgrToken } });
    check('suspended manager\'s live session ends at once (401)', m2DeadToken.error && m2DeadToken.error.includes('login required'), m2DeadToken);
    const m2React = await j('/api/district-admin/manager/activate', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m2LhrToken }, body: JSON.stringify({ username: 'lahore-mgr-1' }) });
    check('head reactivates manager 1', m2React.ok === true && m2React.active === true, m2React);
    const m2MgrToken2 = await headToken('lahore-mgr-1', 'StrongPass1');
    check('reactivated manager can log in again', !!m2MgrToken2, m2MgrToken2);
    // Master bootstrap: Multan has no head — master creates + approves.
    const m2MtnMgr = await j('/api/admin/district-manager', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, username: 'multan-mgr-1', password: 'StrongPass1', district: 'Multan', name: 'Multan Manager', designation: 'Market Committee Secretary', appointment_ref: 'ORD-MTN-2026-001', documents: [{ doc_type: 'Appointment Letter', doc_number: 'PPSC-2024-401', issuing_authority: 'Punjab Public Service Commission', issue_date: '2024-06-15' }] }) });
    check('master creates a manager for a headless district (bootstrap)',
      m2MtnMgr.ok === true && m2MtnMgr.appointed_by === 'master' && m2MtnMgr.active === false, m2MtnMgr);
    const m2MtnPlaces = await j('/api/admin/manager/places', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, username: 'multan-mgr-1', places: ['Multan Mandi'] }) });
    check('master assigns the bootstrap manager his places', m2MtnPlaces.ok === true && m2MtnPlaces.places[0] === 'Multan Mandi', m2MtnPlaces);
    const m2MtnAct = await j('/api/admin/district-admin/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, username: 'multan-mgr-1' }) });
    check('master activates the bootstrap manager', m2MtnAct.ok === true, m2MtnAct);
    const m2MtnLogin = await j('/api/district-admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'multan-mgr-1', password: 'StrongPass1' }) });
    const m2MtnToken = m2MtnLogin.token;
    check('bootstrap manager logs in (role manager)', m2MtnLogin.role === 'manager', m2MtnLogin);
    const m2MtnProp = await j('/api/review/propose', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m2MtnToken }, body: JSON.stringify({ item: 'Tomato', district: 'Multan', price: 165, unit: 'kg', kind: 'retail', source: 'Market Committee daily rate list', date: pktTodayStr(), place: 'Multan Mandi' }) });
    check('bootstrap manager proposes for his place', m2MtnProp.ok === true && Number.isFinite(m2MtnProp.id), m2MtnProp);
    const m2MtnDecide = await j('/api/review/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, id: m2MtnProp.id, decision: 'approve' }) });
    check('master approves the manager proposal where no head exists',
      m2MtnDecide.ok === true && m2MtnDecide.decision === 'approved', m2MtnDecide);
    const m2MtnToday = await j('/api/today?city=Multan');
    const m2MtnTom = m2MtnToday.rows.find((r) => r.item === 'Tomato');
    check('approved bootstrap proposal shows publicly',
      m2MtnTom && m2MtnTom.retail_bazaar === 165 && m2MtnTom.place === 'Multan Mandi', m2MtnToday);
    // Licence privacy on the public surface.
    const m2PublicLeak = JSON.stringify(await j('/api/today?city=Lahore')) + JSON.stringify(await j('/api/live')) + JSON.stringify(await j('/api/meta'));
    check('document numbers + manager names never leak to the public surface',
      !m2PublicLeak.includes('PPSC-2024-201') && !m2PublicLeak.includes('PPSC-2024-301') && !m2PublicLeak.includes('Usman Tariq') && !m2PublicLeak.includes('ORD-LHR-2026-101'), m2PublicLeak.slice(0, 200));

    // ---- v3.3: daily official rates-page photos ----
    // Manager 1's places are now only ['Badami Bagh'] (head changed them).
    const phUp = await postMultipart('/api/district-manager/photo', m2MgrToken2, { place: 'Badami Bagh', date: pktTodayStr(), source_label: 'Market Committee daily rate list' }, 'photo', png1, 'rates.png', 'image/png');
    check('manager uploads a rates-page photo for an assigned place',
      phUp.status === 200 && phUp.body && phUp.body.ok === true && phUp.body.status === 'pending' && phUp.body.file_url, phUp);
    const phUp2 = await postMultipart('/api/district-manager/photo', m2MgrToken2, { place: 'Badami Bagh', date: pktTodayStr(), source_label: 'Market Committee daily rate list' }, 'photo', png1, 'rates2.png', 'image/png');
    check('a second upload for the same place+date supersedes the pending one',
      phUp2.status === 200 && phUp2.body && phUp2.body.ok === true, phUp2);
    const phHeadPending = await j('/api/district-admin/photos?status=pending', { headers: { Authorization: 'Bearer ' + m2LhrToken } });
    check('head sees one pending photo (the first was superseded)',
      Array.isArray(phHeadPending.photos) && phHeadPending.photos.filter((p) => p.place === 'Badami Bagh' && p.date === pktTodayStr()).length === 1 && phHeadPending.photos[0].id === phUp2.body.id, phHeadPending);
    const phHeadSuperseded = await j('/api/district-admin/photos?status=superseded', { headers: { Authorization: 'Bearer ' + m2LhrToken } });
    check('superseded photo is listed as superseded',
      Array.isArray(phHeadSuperseded.photos) && phHeadSuperseded.photos.some((p) => p.id === phUp.body.id), phHeadSuperseded);
    const phUnassigned = await postMultipart('/api/district-manager/photo', m2MgrToken2, { place: 'Lahore Mandi', date: pktTodayStr() }, 'photo', png1, 'rates.png', 'image/png');
    check('photo for an unassigned place is 403',
      phUnassigned.status === 403 && phUnassigned.body && /not assigned to you/i.test(phUnassigned.body.error || ''), phUnassigned);
    const phOtherDistrict = await postMultipart('/api/district-manager/photo', m2MgrToken2, { place: 'Rawalpindi Mandi', date: pktTodayStr() }, 'photo', png1, 'rates.png', 'image/png');
    check('photo for another district is 403', phOtherDistrict.status === 403, phOtherDistrict);
    const phBadType = await postMultipart('/api/district-manager/photo', m2MgrToken2, { place: 'Badami Bagh', date: pktTodayStr() }, 'photo', Buffer.from('hello world'), 'note.txt', 'text/plain');
    check('non-image photo upload is rejected',
      phBadType.status === 400 && phBadType.body && /JPG, PNG or WebP/i.test(phBadType.body.error || ''), phBadType);
    const phBig = await postMultipart('/api/district-manager/photo', m2MgrToken2, { place: 'Badami Bagh', date: pktTodayStr() }, 'photo', Buffer.alloc(5 * 1024 * 1024 + 1), 'big.png', 'image/png');
    check('oversize photo upload is rejected (413)', phBig.status === 413, phBig);
    const phPublicBefore = await j('/api/district/photos?district=Lahore');
    check('pending photo is NOT visible publicly before approval',
      phPublicBefore.latest_by_place && Object.keys(phPublicBefore.latest_by_place).length === 0 && phPublicBefore.history.length === 0, phPublicBefore);
    const phFileNoAuth = await fetch(BASE + phUp2.body.file_url);
    check('pending photo file is not public (no auth → 403)', phFileNoAuth.status === 403, phFileNoAuth.status);
    const phFileMgr = await fetch(BASE + phUp2.body.file_url, { headers: { Authorization: 'Bearer ' + m2MgrToken2 } });
    check('the uploading manager can view his own pending photo',
      phFileMgr.status === 200 && (phFileMgr.headers.get('content-type') || '').includes('image/png'), phFileMgr.status);
    const phApprove = await j('/api/photo/decide', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m2LhrToken }, body: JSON.stringify({ id: phUp2.body.id, decision: 'approve' }) });
    check('head approves the rates-page photo', phApprove.ok === true && phApprove.decision === 'approved', phApprove);
    const phPublicAfter = await j('/api/district/photos?district=Lahore');
    const phLatest = phPublicAfter.latest_by_place && phPublicAfter.latest_by_place['Badami Bagh'];
    check('approved photo shows on the public district page (place + date + source label)',
      phLatest && phLatest.date === pktTodayStr() && phLatest.source_label === 'Market Committee daily rate list' && phLatest.file_url, phPublicAfter);
    const phFilePublic = await fetch(BASE + phLatest.file_url);
    check('approved photo file is public (200, image)',
      phFilePublic.status === 200 && (phFilePublic.headers.get('content-type') || '').includes('image/png'), phFilePublic.status);
    // Reject path + cross-district decide block (yesterday's date).
    const m2Yest = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const phYest = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(m2Yest);
    const phUpYest = await postMultipart('/api/district-manager/photo', m2MgrToken2, { place: 'Badami Bagh', date: phYest, source_label: 'Market Committee daily rate list' }, 'photo', png1, 'rates-yest.png', 'image/png');
    check('manager uploads yesterday\'s rates-page photo', phUpYest.status === 200 && phUpYest.body && phUpYest.body.ok === true, phUpYest);
    const phOtherHeadDecide = await j('/api/photo/decide', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m2RwpToken }, body: JSON.stringify({ id: phUpYest.body.id, decision: 'approve' }) });
    check('another district\'s head cannot approve the photo (403)',
      phOtherHeadDecide.error && phOtherHeadDecide.error.includes('own district'), phOtherHeadDecide);
    const phOtherHeadFile = await fetch(BASE + phUpYest.body.file_url, { headers: { Authorization: 'Bearer ' + m2RwpToken } });
    check('another district\'s head cannot view the pending photo file (403)', phOtherHeadFile.status === 403, phOtherHeadFile.status);
    const phReject = await j('/api/photo/decide', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + m2LhrToken }, body: JSON.stringify({ id: phUpYest.body.id, decision: 'reject' }) });
    check('head rejects yesterday\'s photo', phReject.ok === true && phReject.decision === 'rejected', phReject);
    const phPublicReject = await j('/api/district/photos?district=Lahore');
    check('rejected photo stays invisible publicly (only the approved one shows)',
      phPublicReject.history.length === 1 && phPublicReject.history[0].date === pktTodayStr(), phPublicReject);
    const phScanAsPhoto = await fetch(BASE + '/api/photos/file/scan-' + '0'.repeat(32) + '.png');
    check('licence scans are never served through the photo endpoint (404)',
      phScanAsPhoto.status === 404, phScanAsPhoto.status);
    // ---- v3.0: ViewPrices parser (unit) ----
    const { parseViewPricesHtml, marketToDistrict, normalizeMarket, guessCategory, isOutlier } = require('./lib/viewprices');
    const VP_FIXTURE = '<html><body>'
      + '<select name="ctl00$cphPage$ddlCommodity"><option value="0">Select Commodity</option><option value="21">Potato Fresh</option><option value="5">Tomato</option><option value="9">Wheat</option></select>'
      + '<select name="ctl00$cphPage$ddlMarket"><option value="101">Lahore</option><option value="102">Vehari</option><option value="103">Sialkot</option></select>'
      + '<div>Commodity: Potato Fresh [ All Prices are in Rs/100Kg specified otherwise ]</div><div>Dated:05-11-2026</div>'
      + '<table id="ctl00_cphPage_GridView1">'
      + '<tr><th>S.No</th><th>Market</th><th>Graph</th><th>Min</th><th>Max</th><th>FQP</th><th>Quantity</th></tr>'
      + '<tr><td>1</td><td>Lahore</td><td><a>Graph</a></td><td>-</td><td>-</td><td>-</td><td>-</td></tr>'
      + '<tr><td>2</td><td>Vehari</td><td><a>Graph</a></td><td>9600</td><td>13000</td><td>11300</td><td>-</td></tr>'
      + '<tr><td>3</td><td>KotAdu</td><td><a>Graph</a></td><td>3200</td><td>3500</td><td>3350</td><td>-</td></tr>'
      + '<tr><td>4</td><td>TTSingh</td><td><a>Graph</a></td><td>10800</td><td>12000</td><td>11400</td><td>-</td></tr>'
      + '</table></body></html>';
    const vpParsed = parseViewPricesHtml(VP_FIXTURE, { itemNames: metaV3.items.map((i) => i.en) });
    check('ViewPrices parser reads commodity + date + markets, drops dash rows',
      vpParsed.commodity === 'Potato Fresh' && vpParsed.date === '2026-11-05' && vpParsed.markets.length === 3
      && vpParsed.markets.some((m) => m.market === 'Vehari' && m.min === 9600 && m.max === 13000 && m.fqp === 11300)
      && vpParsed.markets.some((m) => m.market === 'KotAdu' && m.fqp === 3350), vpParsed.markets);
    check('ViewPrices enumeration lists commodities only (market select excluded)',
      vpParsed.commodities.length === 3 && vpParsed.commodities.some((c) => c.id === 21 && c.name === 'Potato Fresh')
      && vpParsed.commodities.some((c) => c.id === 5 && c.name === 'Tomato')
      && vpParsed.commodities.some((c) => c.id === 9 && c.name === 'Wheat')
      && !vpParsed.commodities.some((c) => ['Lahore', 'Vehari', 'Sialkot'].includes(c.name)), vpParsed.commodities);
    check('ViewPrices parser detects the unavailable page', parseViewPricesHtml('Service is not available today').unavailable === true, null);
    check('market mapping: TTSingh→Toba Tek Singh, KotAdu→Muzaffargarh, Sialkot→Sialkot',
      marketToDistrict('TTSingh', cityNames) === 'Toba Tek Singh'
      && marketToDistrict('KotAdu', cityNames) === 'Muzaffargarh'
      && marketToDistrict('Sialkot', cityNames) === 'Sialkot'
      && marketToDistrict('Lahore(Singhpura)', cityNames) === 'Lahore', null);
    check('market mapping refuses guesses: Noshehrawirkan is NOT Nowshera, ChakJhumra unmapped',
      marketToDistrict('Noshehrawirkan', cityNames) === null && marketToDistrict('ChakJhumra', cityNames) === null, null);
    check('normalizeMarket strips the parenthetical suffix', normalizeMarket('Lahore(Singhpura)') === 'Lahore', normalizeMarket('Lahore(Singhpura)'));
    check('outlier rule: 3350 quarantined, 11500 kept, too few values means no quarantine',
      isOutlier(3350, [11300, 13400, 11400, 11500, 11500]) === true
      && isOutlier(11500, [11300, 13400, 11400, 11500, 11500]) === false
      && isOutlier(3350, [3350, 5100]) === false, null);
    check('category guess: Apple fruits, Chicken other, Tomato vegetables',
      guessCategory('Apple') === 'fruits' && guessCategory('Chicken') === 'other' && guessCategory('Tomato') === 'vegetables', null);

    // ---- v3.0: ViewPrices refresh (integration, fixture server) ----
    const VP_INT_FIXTURE = '<html><body>'
      + '<select name="ctl00$cphPage$ddlCommodity"><option value="21">Potato Fresh</option></select>'
      + '<div>Commodity: Potato Fresh [ All Prices are in Rs/100Kg specified otherwise ]</div><div>Dated:05-11-2026</div>'
      + '<table id="ctl00_cphPage_GridView1">'
      + '<tr><th>S.No</th><th>Market</th><th>Graph</th><th>Min</th><th>Max</th><th>FQP</th><th>Quantity</th></tr>'
      + '<tr><td>1</td><td>Lahore</td><td><a>Graph</a></td><td>-</td><td>-</td><td>-</td><td>-</td></tr>'
      + '<tr><td>2</td><td>Sialkot</td><td><a>Graph</a></td><td>10500</td><td>12500</td><td>11500</td><td>-</td></tr>'
      + '<tr><td>3</td><td>Sheikhupura</td><td><a>Graph</a></td><td>11000</td><td>13000</td><td>12000</td><td>-</td></tr>'
      + '<tr><td>4</td><td>Narowal</td><td><a>Graph</a></td><td>10000</td><td>12000</td><td>11000</td><td>-</td></tr>'
      + '<tr><td>5</td><td>BahawalPur</td><td><a>Graph</a></td><td>10800</td><td>12800</td><td>11800</td><td>-</td></tr>'
      + '<tr><td>6</td><td>Attock</td><td><a>Graph</a></td><td>11200</td><td>13200</td><td>12200</td><td>-</td></tr>'
      + '<tr><td>7</td><td>KotAdu</td><td><a>Graph</a></td><td>3200</td><td>3500</td><td>3350</td><td>-</td></tr>'
      + '<tr><td>8</td><td>ChakJhumra</td><td><a>Graph</a></td><td>11000</td><td>12000</td><td>11500</td><td>-</td></tr>'
      + '</table></body></html>';
    const DB4 = '/tmp/mandi-test-vp.sqlite';
    cleanDb(DB4);
    const vpFix = await fixtureServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(VP_INT_FIXTURE); });
    const child4 = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      env: { ...process.env, PORT: '3043', DB_FILE: DB4, ADMIN_CODE: CODE, MANDI_AUTO_REFRESH: '0', AMIS_VIEWPRICES_URL: `http://127.0.0.1:${vpFix.port}/ViewPrices.aspx?searchType=0&commodityId=21` }, stdio: 'pipe',
    });
    let log4 = '';
    child4.stdout.on('data', (d) => { log4 += d; });
    child4.stderr.on('data', (d) => { log4 += d; });
    try {
      check('viewprices server starts', await waitReady(3043), log4.slice(-500));
      const j4 = jFor(3043);
      const vp1 = await j4('/api/admin/refresh-viewprices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, force: true }) });
      check('ViewPrices refresh seeds 5 new districts, quarantines 1 outlier, skips the unmapped market',
        vp1.ok === true && vp1.date === '2026-11-05' && vp1.inserted === 5 && vp1.quarantined === 1
        && vp1.unmatched_markets.length === 1 && vp1.unmatched_markets[0] === 'ChakJhumra', vp1);
      const sial4 = await j4('/api/today?city=Sialkot');
      check('Sialkot gains a ViewPrices potato row (115/kg, Min–Max source)',
        sial4.date === '2026-11-05' && sial4.rows.length === 1 && sial4.rows[0].item === 'Potato' && sial4.rows[0].wholesale_per_unit === 115 && sial4.rows[0].source === 'AMIS ViewPrices (Min 10500–Max 12500 Rs/100kg)', sial4);
      const vpQueue = await j4('/api/review/queue', { headers: { 'X-Master-Code': CODE } });
      const vpQ = vpQueue.rows.find((r) => r.item === 'Potato' && r.district === 'Muzaffargarh');
      check('KotAdu outlier waits in the review queue (wholesale 3350, proposed by amis-viewprices)',
        !!vpQ && vpQ.status === 'pending' && vpQ.price === 3350 && vpQ.kind === 'wholesale' && vpQ.proposed_by === 'amis-viewprices', vpQueue.rows);
      const mzHist = await j4('/api/history?item=Potato&city=Muzaffargarh');
      check('quarantined outlier never reaches the public (Muzaffargarh potato history empty)', mzHist.points.length === 0, mzHist.points);
      const vpApprove = await j4('/api/review/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, id: vpQ.id, decision: 'approve' }) });
      check('approving the quarantined outlier publishes it with its source', vpApprove.ok === true && vpApprove.decision === 'approved', vpApprove);
      const mzHist2 = await j4('/api/history?item=Potato&city=Muzaffargarh');
      check('approved outlier now shows in history (33.50/kg)', mzHist2.points.length === 1 && mzHist2.points[0].wholesale_per_unit === 33.5, mzHist2.points);
      const vp2 = await j4('/api/admin/refresh-viewprices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, force: true }) });
      check('second ViewPrices refresh updates instead of duplicating (0 inserted, 5 updated)',
        vp2.ok === true && vp2.inserted === 0 && vp2.updated === 5, vp2);
      const vpBad = await j4('/api/admin/refresh-viewprices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: 'wrong', force: true }) });
      check('ViewPrices refresh rejects wrong code', vpBad.error === 'bad admin code', vpBad);
      // Homepage now serves the category select + chat box.
      const homeV3 = await fetch(BASE + '/');
      const homeV3Html = await homeV3.text();
      check('homepage has category select + chat box',
        homeV3Html.includes('id="catSelect"') && homeV3Html.includes('id="chatQ"') && homeV3Html.includes('id="chatBtn"') && homeV3Html.includes('کلو'), homeV3Html.length);
      const daPage = await fetch(BASE + '/district-admin.html');
      check('district-admin page serves 200 with login + add-rate form',
        daPage.status === 200 && (await daPage.text()).includes('id="daLoginBtn"'), daPage.status);
      const apiV3 = await fetch(BASE + '/api.html');
      const apiV3Html = await apiV3.text();
      check('api docs list /api/chat + district-admin + review endpoints',
        apiV3Html.includes('/api/chat') && apiV3Html.includes('/api/district-admin/rate') && apiV3Html.includes('/api/review/queue'), apiV3Html.length);
    } finally {
      child4.kill();
      vpFix.srv.close();
    }

    // ---- v2.1 automatic daily refresh ----
    // A local fixture server stands in for amis.pk so the real fetch ->
    // parse -> upsert path runs with no external network.
    const FIXTURE = '<table id="ctl00_cphPage_GridView1">'
      + '<tr><td>CityName</td><td>CropName</td><td>Today\'s FQP/Average Price</td><td>Yesterday\'s FQP/Average Price</td><td>Change</td><td>Dir</td></tr>'
      + '<tr><td>Lahore</td><td>Onion</td><td>18000</td><td>18500</td><td>-500</td><td></td></tr>'
      + '<tr><td>Lahore</td><td>Tomato</td><td>13250</td><td>14250</td><td>-1000</td><td></td></tr></table>';
    function fixtureServer(handler) {
      return new Promise((resolve) => {
        const srv = http.createServer(handler);
        srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
      });
    }
    function cleanDb(dbFile) {
      for (const f of [dbFile, dbFile + '-shm', dbFile + '-wal']) { try { fs.unlinkSync(f); } catch {} }
    }
    async function waitForLive(port, pred) {
      const get = jFor(port);
      for (let i = 0; i < 50; i++) {
        try { const live = await get('/api/live'); if (pred(live)) return live; } catch {}
        await sleep(200);
      }
      // The final read used to be uncaught: if the server was briefly
      // unreachable here, fetch threw and the WHOLE suite crashed with
      // no FAIL line (seen once in 5 runs, port 3041). A failed read is
      // a failed check, not a crash — return {} and let the checks fail.
      try { return await get('/api/live'); } catch { return {}; }
    }

    // Server 2: the fixture answers, so the startup refresh must succeed.
    const DB2 = '/tmp/mandi-test-auto.sqlite';
    cleanDb(DB2);
    let fixHits = 0;
    const fix = await fixtureServer((req, res) => { fixHits++; res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(FIXTURE); });
    const child2 = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      env: { ...process.env, PORT: '3041', DB_FILE: DB2, ADMIN_CODE: CODE, AMIS_URL: `http://127.0.0.1:${fix.port}/daily` }, stdio: 'pipe',
    });
    let log2 = '';
    child2.stdout.on('data', (d) => { log2 += d; });
    child2.stderr.on('data', (d) => { log2 += d; });
    try {
      check('auto server starts', await waitReady(3041), log2.slice(-500));
      const j2 = jFor(3041);
      const live2 = await waitForLive(3041, (l) => !!l.last_refresh_at);
      check('stale data triggers a refresh attempt', !!live2.last_refresh_attempt_at, live2);
      check('auto refresh succeeded', !!live2.last_refresh_at, live2);
      check('rates_date is today after auto refresh', live2.rates_date === pktTodayStr(), live2.rates_date);
      check('/api/live returns source AMIS Pakistan (amis.pk)', live2.source === 'AMIS Pakistan (amis.pk)', live2.source);
      const t2 = await j2('/api/today?city=Lahore');
      const tom2 = t2.rows.find((r) => r.item === 'Tomato');
      check('auto-refreshed Lahore tomato is 132.50/kg', t2.date === pktTodayStr() && tom2 && tom2.wholesale_per_unit === 132.5, t2);
      check('startup refresh fetched the fixture exactly once', fixHits === 1, fixHits);
      await j2('/api/today?city=Lahore');
      await j2('/api/live');
      await j2('/api/today?city=Karachi');
      check('fresh data does NOT trigger another fetch', fixHits === 1, fixHits);
      const live2b = await j2('/api/live');
      check('last_refresh_attempt unchanged while fresh', live2b.last_refresh_attempt_at === live2.last_refresh_attempt_at, live2b);
      const adm = await j2('/api/admin/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: CODE, force: true }) });
      check('admin refresh still works via the shared function', adm.ok === true && adm.date === pktTodayStr(), adm);
      check('admin refresh re-fetched the fixture', fixHits === 2, fixHits);
    } finally {
      child2.kill();
      fix.srv.close();
    }

    // Server 3: the source answers 500, so the refresh must fail cleanly
    // and every old row must survive untouched.
    const DB3 = '/tmp/mandi-test-auto-fail.sqlite';
    cleanDb(DB3);
    const badFix = await fixtureServer((req, res) => { res.writeHead(500); res.end('boom'); });
    const child3 = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
      env: { ...process.env, PORT: '3042', DB_FILE: DB3, ADMIN_CODE: CODE, AMIS_URL: `http://127.0.0.1:${badFix.port}/daily` }, stdio: 'pipe',
    });
    let log3 = '';
    child3.stdout.on('data', (d) => { log3 += d; });
    child3.stderr.on('data', (d) => { log3 += d; });
    try {
      check('fail server starts', await waitReady(3042), log3.slice(-500));
      const j3 = jFor(3042);
      const live3 = await waitForLive(3042, (l) => !!l.last_refresh_attempt_at);
      check('failed refresh records an attempt', !!live3.last_refresh_attempt_at, live3);
      check('failed refresh leaves last_refresh_at null', live3.last_refresh_at === null, live3);
      check('failed refresh leaves rates_date at seed date 2026-11-06', live3.rates_date === '2026-11-06', live3.rates_date);
      const t3 = await j3('/api/today?city=Lahore');
      const tom3 = t3.rows.find((r) => r.item === 'Tomato');
      check('failed refresh keeps old Lahore tomato 175.00/kg', tom3 && tom3.wholesale_per_unit === 175, t3);
      check('failed refresh keeps all 7 Lahore rows', t3.rows.length === 7, t3.rows.length);
    } finally {
      child3.kill();
      badFix.srv.close();
    }

    // ---- rate limiting on register + admin mutations (last: both buckets
    // trip here, so no register/admin POST may run after this) ----
    // Hammer-until-429: the suite already made ~40 admin and ~14 register
    // POSTs, so the trip point depends on the earlier count — assert only
    // that a 429 appears within the window and that every response before
    // it was the endpoint's normal answer (403 / 400), never an early 429.
    async function hammerUntil429(pathSuffix, body, normalStatus) {
      const seen = [];
      let trippedAt = -1;
      for (let i = 0; i < 120; i++) {
        const r = await fetch(BASE + pathSuffix, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        seen.push(r.status);
        await r.text();
        if (r.status === 429) { trippedAt = i; break; }
      }
      // Every response before the trip must be the endpoint's normal
      // answer (403 bad code / 400 bad body) — never an early 429.
      const earlyOk = seen.slice(0, trippedAt).every((s) => s === normalStatus);
      return { trippedAt, earlyOk, seenCount: seen.length };
    }
    const adminHammer = await hammerUntil429('/api/admin/refresh', { code: 'wrong' }, 403);
    check('admin mutations rate-limit: 429 appears after sustained POSTs, earlier answers stay 403',
      adminHammer.trippedAt >= 0 && adminHammer.earlyOk, adminHammer);
    const regHammer = await hammerUntil429('/api/register/head', {}, 400);
    check('register rate-limit: 429 appears after sustained POSTs, earlier answers stay 400',
      regHammer.trippedAt >= 0 && regHammer.earlyOk, regHammer);
    // The buckets are per-path-prefix: tripping admin must not block a
    // public read, and tripping register must not block the other bucket's
    // normal (non-limited) traffic either — GETs stay open.
    const afterLimitMeta = await j('/api/meta');
    check('public reads still work after the rate limit trips', Array.isArray(afterLimitMeta.cities) && afterLimitMeta.cities.length > 0, afterLimitMeta.cities && afterLimitMeta.cities.length);
  } finally {
    child.kill();
  }
  console.log(failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
})();
