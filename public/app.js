'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => n === null || n === undefined ? '—' : 'Rs ' + Number(n).toLocaleString('en-PK', { maximumFractionDigits: 2 });
const pct = (n) => n === null || n === undefined ? '—' : (n > 0 ? '▲ +' : n < 0 ? '▼ ' : '') + n.toFixed(2) + '%';

let meta = null;
// Province-first selection: a province select drives a district select that
// shows ONLY that province's districts. Returns the two elements.
function fillProvinces(sel) {
  sel.innerHTML = meta.provinces.map((g) => `<option>${esc(g.name)}</option>`).join('');
}
function fillDistricts(provSel, distSel) {
  const g = meta.provinces.find((x) => x.name === provSel.value);
  distSel.innerHTML = (g ? g.districts : []).map((d) => `<option>${esc(d.name)}</option>`).join('');
}
function bindPair(provId, distId, onChange) {
  const p = $(provId), d = $(distId);
  fillProvinces(p);
  if ([...p.options].some((o) => o.value === 'Punjab')) p.value = 'Punjab';
  fillDistricts(p, d);
  p.addEventListener('change', () => { fillDistricts(p, d); if (onChange) onChange(); });
  d.addEventListener('change', () => { if (onChange) onChange(); });
  return { p, d };
}
function setPair(provId, distId, province, district) {
  const p = $(provId), d = $(distId);
  if ([...p.options].some((o) => o.value === province)) p.value = province;
  fillDistricts(p, d);
  if ([...d.options].some((o) => o.value === district)) d.value = district;
}
async function loadMeta() {
  meta = await (await fetch('/api/meta')).json();
  bindPair('provSelect', 'citySelect', loadToday);
  bindPair('provCheck', 'checkCity', null);
  bindPair('provTrend', 'trendCity', null);
  setPair('provCheck', 'checkCity', 'Sindh', 'Karachi');
  setPair('provTrend', 'trendCity', 'Punjab', 'Lahore');
  for (const sel of [$('cheapItem'), $('checkItem'), $('trendItem')]) {
    sel.innerHTML = meta.items.map((i) => `<option value="${esc(i.en)}">${esc(i.en)} (${esc(i.ur)})</option>`).join('');
  }
  $('sources').innerHTML = meta.sources.map((s) => `${esc(s.name)} — ${esc(s.note)}`).join(' · ');
  $('districts').innerHTML = meta.provinces.map((g) => {
    const withRates = g.districts.filter((d) => d.has_rates).length;
    return `<h3>${esc(g.name)} — ${g.districts.length} districts (${withRates} with rates so far)</h3><p class="district-list">${g.districts.map((d) => `<a href="#" data-city="${esc(d.name)}" data-prov="${esc(g.name)}" class="${d.has_rates ? 'has-rates' : 'no-rates'}">${esc(d.name)}${d.has_rates ? '' : ' · soon'}</a>`).join(' ')}</p>`;
  }).join('');
  document.querySelectorAll('#districts a[data-city]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    setPair('provSelect', 'citySelect', a.dataset.prov, a.dataset.city);
    loadToday();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }));
  $('provinceChips').innerHTML = meta.provinces.map((g) => `<button class="prov-chip" data-prov="${esc(g.name)}">${esc(g.name)} (${g.districts.length})</button>`).join('');
  document.querySelectorAll('#provinceChips button[data-prov]').forEach((b) => b.addEventListener('click', () => {
    const g = meta.provinces.find((x) => x.name === b.dataset.prov);
    const pick = g.districts.find((d) => d.has_rates) || g.districts[0];
    if (pick) { setPair('provSelect', 'citySelect', g.name, pick.name); loadToday(); document.getElementById('today').scrollIntoView({ behavior: 'smooth' }); }
  }));
}
async function loadToday() {
  const city = $('citySelect').value;
  const cat = $('catSelect') ? $('catSelect').value : '';
  const data = await (await fetch('/api/today?city=' + encodeURIComponent(city) + (cat ? '&category=' + encodeURIComponent(cat) : ''))).json();
  $('todayCity').textContent = city;
  $('dateBadge').textContent = data.date ? 'Rates as of ' + data.date : 'No rates recorded yet for this district';
  // Official district (v3.1): when a district has an active licensed head,
  // say so — designation + district only. The officer's name and licence
  // number are never shown to the public.
  const ol = $('officialLine');
  if (ol) {
    ol.textContent = data.official
      ? `Officially managed by ${data.official.designation}, ${data.official.district}`
      : '';
  }
  // Nearest-rates fallback (v2.2): one clear line, only when the rates shown
  // are the province hub's — never presented as the district's own.
  const nn = $('nearestNote');
  if (nn) {
    nn.textContent = data.nearest_rates_from
      ? `${city} has no published rates yet — nearest rates: ${data.nearest_rates_from}, ${data.nearest_rates_date}`
      : '';
  }
  $('ratesBody').innerHTML = data.rows.length
    ? data.rows.map((r) => `<tr><td><strong>${esc(r.item)}</strong> ${esc(r.ur)}${r.variant ? ' (' + esc(r.variant) + ')' : ''}</td><td>${r.wholesale_per_unit === null ? '—' : fmt(r.wholesale_per_unit) + ' / ' + esc(r.unit_ur || r.unit)}</td><td>${r.retail_bazaar === null ? '—' : fmt(r.retail_bazaar) + ' / ' + esc(r.unit_ur || r.unit)}</td><td class="${r.change_pct > 0 ? 'up' : r.change_pct < 0 ? 'down' : ''}">${pct(r.change_pct)}</td><td>${r.flag ? '<span class="flag">⚠️ verify — unusual jump</span>' : ''}</td></tr>`).join('')
    : `<tr><td colspan="5">No rates recorded yet for ${esc(city)}${cat ? ' in this category' : ''}. Districts appear here with their daily snapshot as soon as it is added — nothing is estimated or filled in meanwhile.</td></tr>`;
  const mv = await (await fetch('/api/movers?city=' + encodeURIComponent(city) + '&limit=5')).json();
  $('risers').innerHTML = mv.rises.map((r) => `<li>${esc(r.item)}: <span class="up">${pct(r.change_pct)}</span> (${fmt(r.wholesale_per_unit)} / ${esc(r.unit)})</li>`).join('') || '<li>—</li>';
  $('fallers').innerHTML = mv.falls.map((r) => `<li>${esc(r.item)}: <span class="down">${pct(r.change_pct)}</span> (${fmt(r.wholesale_per_unit)} / ${esc(r.unit)})</li>`).join('') || '<li>—</li>';
  await loadPhotos(city);
  await loadFreshness();
}
// Official rates-page photos (v3.3): the latest approved photo per place,
// plus a small history. Only approved photos are ever shown here.
async function loadPhotos(city) {
  const box = $('photosBox');
  if (!box) return;
  const pc = $('photosCity');
  if (pc) pc.textContent = city;
  try {
    const data = await (await fetch('/api/district/photos?district=' + encodeURIComponent(city))).json();
    const latest = Object.values(data.latest_by_place || {});
    const history = (data.history || []).slice(1);
    if (!latest.length && !history.length) {
      box.innerHTML = '<p class="note">No official rates-page photo published for this district yet.</p>';
      return;
    }
    box.innerHTML = latest.map((p) => `<figure class="card" style="display:inline-block;vertical-align:top;margin:0 12px 12px 0;max-width:320px">
      <img src="${esc(p.file_url)}" alt="Official rates page — ${esc(p.place)}, ${esc(p.date)}" style="max-width:100%;border-radius:8px">
      <figcaption><strong>Official rates page</strong> — ${esc(p.place)} · ${esc(p.date)} · ${esc(p.source_label)}</figcaption>
    </figure>`).join('')
    + (history.length ? `<h3>Recent days</h3><ul>${history.map((p) => `<li><a href="${esc(p.file_url)}" target="_blank" rel="noopener">${esc(p.place)} — ${esc(p.date)} (${esc(p.source_label)})</a></li>`).join('')}</ul>` : '');
  } catch { box.innerHTML = '<p class="note">Photos could not be loaded right now.</p>'; }
}
// Freshness line: how new are the rates on file? Never claims fresh data
// when the stored date is old — it says plainly that today's update is pending.
function pktDate(offsetDays) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
async function loadFreshness() {
  const el = $('freshnessLine');
  if (!el) return;
  let live;
  try {
    live = await (await fetch('/api/live')).json();
  } catch {
    el.textContent = 'Rates update status unavailable right now.';
    return;
  }
  const rd = live.rates_date;
  if (!rd) {
    el.textContent = 'No rates recorded yet — today\u2019s update pending.';
    return;
  }
  if (rd >= pktDate(-1)) el.textContent = `Rates updated: ${rd} \u2022 Source: AMIS Pakistan`;
  else el.textContent = `Rates from ${rd} \u2014 today\u2019s update pending`;
}
async function loadCheapest() {
  const item = $('cheapItem').value;
  const data = await (await fetch('/api/cheapest?item=' + encodeURIComponent(item))).json();
  $('cheapList').innerHTML = data.rows.length
    ? data.rows.map((r, i) => `<li>${i === 0 ? '<strong>Cheapest: </strong>' : ''}${esc(r.city)} — ${fmt(r.per_unit)} / ${esc(r.unit)}</li>`).join('')
    : '<li>No wholesale rate on file for this item.</li>';
}
async function runCheck() {
  const body = { city: $('checkCity').value, item: $('checkItem').value, price_paid: Number($('checkPrice').value) };
  const data = await (await fetch('/api/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  const box = $('checkResult');
  if (data.error) { box.textContent = data.error; box.className = 'result'; return; }
  if (data.verdict === 'no-official-rate') {
    box.innerHTML = `<strong>No official retail rate on file</strong> for ${esc(data.item)} yet — so no verdict. ${esc(data.note)} ${data.cheapest_wholesale ? 'Cheapest wholesale today: ' + esc(data.cheapest_wholesale.city) + ' at ' + fmt(data.cheapest_wholesale.per_unit) + ' / ' + esc(data.cheapest_wholesale.unit) + '.' : ''}`;
    box.className = 'result';
    return;
  }
  const words = data.verdict === 'fair' ? 'Fair — you paid at or below the official rate.' : data.verdict === 'slightly-above' ? 'Slightly above the official rate.' : 'Overcharged — you paid more than the official rate.';
  box.innerHTML = `<strong>${words}</strong><br>Official bazaar rate (${esc(data.city)}, ${esc(data.date)}): ${fmt(data.official_bazaar_rate)} / kg · You paid: ${fmt(data.price_paid)} / kg · Difference: ${fmt(data.difference)} (${data.difference_pct}%).`;
  box.className = 'result ' + data.verdict;
}
function drawChart(points) {
  const cv = $('trendChart');
  const ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  const vals = points.map((p) => p.wholesale_per_unit).filter((v) => v !== null);
  if (points.length === 0 || vals.length === 0) { ctx.font = '18px sans-serif'; ctx.fillText('No data for this selection yet.', 20, 40); return; }
  const min = Math.min(...vals), max = Math.max(...vals);
  const padL = 70, padR = 20, padT = 20, padB = 40;
  const W = cv.width - padL - padR, H = cv.height - padT - padB;
  const X = (i) => padL + (points.length === 1 ? W / 2 : (i / (points.length - 1)) * W);
  const Y = (v) => padT + H - ((v - min) / (max === min ? 1 : max - min)) * H;
  ctx.strokeStyle = '#e5e7eb';
  for (let g = 0; g <= 4; g++) { const y = padT + (H / 4) * g; ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + W, y); ctx.stroke(); }
  ctx.strokeStyle = '#15803d'; ctx.lineWidth = 3; ctx.beginPath();
  points.forEach((p, i) => { if (p.wholesale_per_unit === null) return; const x = X(i), y = Y(p.wholesale_per_unit); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
  ctx.stroke(); ctx.lineWidth = 1;
  ctx.fillStyle = '#14532d'; ctx.font = '13px sans-serif';
  points.forEach((p, i) => {
    if (p.wholesale_per_unit === null) return;
    const x = X(i), y = Y(p.wholesale_per_unit);
    ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillText('Rs ' + p.wholesale_per_unit, x - 20, y - 12);
    ctx.fillText(p.date, x - 24, cv.height - 12);
  });
  ctx.fillText('Rs ' + max, 8, padT + 12);
  ctx.fillText('Rs ' + min, 8, padT + H);
}
async function loadTrend() {
  const data = await (await fetch('/api/history?item=' + encodeURIComponent($('trendItem').value) + '&city=' + encodeURIComponent($('trendCity').value))).json();
  drawChart(data.points);
}
async function askChat() {
  const q = $('chatQ').value.trim();
  const box = $('chatAnswer');
  if (!q) { box.textContent = 'Please type a question first.'; return; }
  box.textContent = 'Searching the rates on file…';
  try {
    const data = await (await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ q }) })).json();
    if (data.error) { box.textContent = data.error; return; }
    box.innerHTML = esc(data.answer) + (data.fallback ? '<br><span class="note">Nearest-rates fallback — this is the hub’s rate, not the district’s own.</span>' : '');
  } catch {
    box.textContent = 'The chat is unavailable right now — please try again.';
  }
}
$('chatBtn').addEventListener('click', askChat);
$('chatQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') askChat(); });
if ($('catSelect')) $('catSelect').addEventListener('change', loadToday);
$('cheapBtn').addEventListener('click', loadCheapest);
$('checkBtn').addEventListener('click', runCheck);
$('trendBtn').addEventListener('click', loadTrend);
(async () => { await loadMeta(); await loadToday(); await loadCheapest(); await loadTrend(); })();
