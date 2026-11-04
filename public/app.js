'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => n === null || n === undefined ? '—' : 'Rs ' + Number(n).toLocaleString('en-PK', { maximumFractionDigits: 2 });
const pct = (n) => n === null || n === undefined ? '—' : (n > 0 ? '▲ +' : n < 0 ? '▼ ' : '') + n.toFixed(2) + '%';

let meta = null;
async function loadMeta() {
  meta = await (await fetch('/api/meta')).json();
  for (const sel of [$('citySelect'), $('checkCity'), $('trendCity')]) {
    sel.innerHTML = meta.cities.map((c) => `<option>${esc(c)}</option>`).join('');
  }
  $('citySelect').value = meta.cities.includes('Lahore') ? 'Lahore' : meta.cities[0];
  $('checkCity').value = meta.cities.includes('Karachi') ? 'Karachi' : meta.cities[0];
  $('trendCity').value = $('citySelect').value;
  for (const sel of [$('cheapItem'), $('checkItem'), $('trendItem')]) {
    sel.innerHTML = meta.items.map((i) => `<option value="${esc(i.en)}">${esc(i.en)} (${esc(i.ur)})</option>`).join('');
  }
  $('sources').innerHTML = meta.sources.map((s) => `${esc(s.name)} — ${esc(s.note)}`).join(' · ');
}
async function loadToday() {
  const city = $('citySelect').value;
  const data = await (await fetch('/api/today?city=' + encodeURIComponent(city))).json();
  $('todayCity').textContent = city;
  $('dateBadge').textContent = 'Rates as of ' + (data.date || '—');
  $('ratesBody').innerHTML = data.rows.map((r) => `<tr><td><strong>${esc(r.item)}</strong> ${esc(r.ur)}${r.variant ? ' (' + esc(r.variant) + ')' : ''}</td><td>${r.wholesale_per_unit === null ? '—' : fmt(r.wholesale_per_unit) + ' / ' + esc(r.unit)}</td><td>${r.retail_bazaar === null ? '—' : fmt(r.retail_bazaar) + ' / kg'}</td><td class="${r.change_pct > 0 ? 'up' : r.change_pct < 0 ? 'down' : ''}">${pct(r.change_pct)}</td><td>${r.flag ? '<span class="flag">⚠️ verify — unusual jump</span>' : ''}</td></tr>`).join('');
  const mv = await (await fetch('/api/movers?city=' + encodeURIComponent(city) + '&limit=5')).json();
  $('risers').innerHTML = mv.rises.map((r) => `<li>${esc(r.item)}: <span class="up">${pct(r.change_pct)}</span> (${fmt(r.wholesale_per_unit)} / ${esc(r.unit)})</li>`).join('') || '<li>—</li>';
  $('fallers').innerHTML = mv.falls.map((r) => `<li>${esc(r.item)}: <span class="down">${pct(r.change_pct)}</span> (${fmt(r.wholesale_per_unit)} / ${esc(r.unit)})</li>`).join('') || '<li>—</li>';
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
$('citySelect').addEventListener('change', loadToday);
$('cheapBtn').addEventListener('click', loadCheapest);
$('checkBtn').addEventListener('click', runCheck);
$('trendBtn').addEventListener('click', loadTrend);
(async () => { await loadMeta(); await loadToday(); await loadCheapest(); await loadTrend(); })();
