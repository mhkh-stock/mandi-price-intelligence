'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
$('fDate').value = new Date().toISOString().slice(0, 10);
async function loadRecent() {
  const code = $('code').value;
  const data = await (await fetch('/api/admin/recent?code=' + encodeURIComponent(code))).json();
  if (data.error) { $('recentBody').innerHTML = `<tr><td colspan="6">${esc(data.error)}</td></tr>`; return; }
  $('recentBody').innerHTML = data.rows.map((r) => `<tr><td>${esc(r.date)}</td><td>${esc(r.city)}</td><td>${esc(r.item)}${r.variant ? ' (' + esc(r.variant) + ')' : ''}</td><td>${r.w === null ? '—' : r.w}</td><td>${r.rb === null ? '—' : r.rb}</td><td>${esc(r.source)}</td></tr>`).join('');
}
$('loadBtn').addEventListener('click', loadRecent);
$('saveBtn').addEventListener('click', async () => {
  const body = { code: $('code').value, date: $('fDate').value, city: $('fCity').value.trim(), item: $('fItem').value.trim(), variant: $('fVariant').value.trim(), source: $('fSource').value.trim() || 'admin-entry' };
  for (const [k, el] of [['wholesale', 'fWholesale'], ['retail_bazaar', 'fRb'], ['retail_mandi', 'fRm'], ['retail_auction', 'fRa']]) {
    if ($(el).value !== '') body[k] = Number($(el).value);
  }
  const data = await (await fetch('/api/admin/snapshot', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  const m = $('saveMsg'); m.style.display = 'block';
  m.textContent = data.ok ? 'Saved.' : ('Error: ' + (data.error || 'unknown'));
  if (data.ok) loadRecent();
});
$('itemBtn').addEventListener('click', async () => {
  const body = { code: $('code').value, name_en: $('iEn').value.trim(), name_ur: $('iUr').value.trim(), unit: $('iUnit').value };
  const data = await (await fetch('/api/admin/item', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  const m = $('saveMsg'); m.style.display = 'block';
  m.textContent = data.ok ? 'Item added.' : ('Error: ' + (data.error || 'unknown'));
});
