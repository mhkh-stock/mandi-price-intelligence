'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => n === null || n === undefined ? '—' : 'Rs ' + Number(n).toLocaleString('en-PK', { maximumFractionDigits: 2 });
const unitUrdu = (u) => u === 'dozen' ? 'درجن' : 'کلو';
let mToken = sessionStorage.getItem('mToken') || '';
let mDistrict = sessionStorage.getItem('mDistrict') || '';
let mPlaces = [];
try { mPlaces = JSON.parse(sessionStorage.getItem('mPlaces') || '[]'); } catch { mPlaces = []; }
const todayStr = () => new Date().toISOString().slice(0, 10);
$('pDate').value = todayStr();
$('phDate').value = todayStr();

function showMsg(id, text, ok) {
  const m = $(id); m.style.display = 'block';
  m.textContent = text;
  m.style.borderColor = ok ? '#15803d' : '#dc2626';
}
function fillPlaces() {
  const opts = mPlaces.map((p) => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
  $('pPlace').innerHTML = opts || '<option value="">No places assigned yet — ask your district head</option>';
  $('phPlace').innerHTML = opts || '<option value="">No places assigned yet — ask your district head</option>';
  $('mPlaces').textContent = mPlaces.length ? mPlaces.join(', ') : '(none assigned yet — ask your district head)';
}
function showPanel() {
  $('loginBox').style.display = 'none';
  $('panel').style.display = 'block';
  $('mDistrict').textContent = mDistrict;
  fillPlaces();
  loadItems();
  loadQueue();
}
function showLogin() {
  $('loginBox').style.display = 'block';
  $('panel').style.display = 'none';
}
async function loadItems() {
  try {
    const meta = await (await fetch('/api/meta')).json();
    $('pItem').innerHTML = meta.items.map((i) => `<option value="${esc(i.en)}">${esc(i.en)} (${esc(i.ur)}) — ${esc(i.unit)}</option>`).join('');
  } catch { /* item list stays empty until meta loads */ }
}
async function loadQueue() {
  const status = $('qStatus').value;
  const data = await (await fetch('/api/review/queue?status=' + encodeURIComponent(status), { headers: { Authorization: 'Bearer ' + mToken } })).json();
  if (data.error) { $('qBody').innerHTML = `<tr><td colspan="6">${esc(data.error)}</td></tr>`; return; }
  $('qBody').innerHTML = data.rows.length
    ? data.rows.map((r) => `<tr><td>${esc(r.date)}</td><td>${esc(r.place || '—')}</td><td>${esc(r.item)}</td><td>${fmt(r.price)} / ${unitUrdu(r.unit)} (${esc(r.kind)})</td><td>${esc(r.source)}</td><td>${esc(r.status)}</td></tr>`).join('')
    : `<tr><td colspan="6">No ${esc(status)} proposals.</td></tr>`;
}
$('mLoginBtn').addEventListener('click', async () => {
  const data = await (await fetch('/api/district-admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: $('mUser').value.trim(), password: $('mPass').value }) })).json();
  const m = $('mLoginMsg'); m.style.display = 'block';
  if (!data.ok) { m.textContent = 'Login failed: ' + (data.error || 'unknown'); return; }
  if (data.role !== 'manager') {
    m.textContent = 'This page is for managers. District heads use the District Admin page.';
    return;
  }
  mToken = data.token; mDistrict = data.district; mPlaces = data.assigned_places || [];
  sessionStorage.setItem('mToken', mToken);
  sessionStorage.setItem('mDistrict', mDistrict);
  sessionStorage.setItem('mPlaces', JSON.stringify(mPlaces));
  showPanel();
});
$('mLogoutBtn').addEventListener('click', async () => {
  try { await fetch('/api/district-admin/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + mToken }, body: JSON.stringify({}) }); } catch { /* logged out locally anyway */ }
  mToken = ''; mDistrict = ''; mPlaces = [];
  sessionStorage.removeItem('mToken');
  sessionStorage.removeItem('mDistrict');
  sessionStorage.removeItem('mPlaces');
  showLogin();
});
$('mPassBtn').addEventListener('click', async () => {
  const data = await (await fetch('/api/district-admin/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + mToken }, body: JSON.stringify({ old_password: $('mOldPass').value, new_password: $('mNewPass').value }) })).json();
  showMsg('pMsg', data.ok ? 'Password changed. Your other sessions were ended.' : ('Error: ' + (data.error || 'unknown')), !!data.ok);
  if (data.ok) { $('mOldPass').value = ''; $('mNewPass').value = ''; }
});
$('pSaveBtn').addEventListener('click', async () => {
  if (!mPlaces.length) { showMsg('pMsg', 'No places assigned to you yet — ask your district head to assign your places first.'); return; }
  const body = { district: mDistrict, item: $('pItem').value, price: Number($('pPrice').value), unit: $('pUnit').value, kind: $('pKind').value, source: $('pSource').value.trim(), date: $('pDate').value, place: $('pPlace').value };
  const data = await (await fetch('/api/review/propose', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + mToken }, body: JSON.stringify(body) })).json();
  showMsg('pMsg', data.ok ? `Proposed ${body.item} ${body.price}/${body.unit} for ${body.place} (${body.date}). Your district head will review it — it shows to the public only after approval.` : ('Error: ' + (data.error || 'unknown')), !!data.ok);
  if (data.ok) loadQueue();
});
$('qReloadBtn').addEventListener('click', loadQueue);
$('qStatus').addEventListener('change', loadQueue);
$('phBtn').addEventListener('click', async () => {
  const file = $('phFile').files[0];
  if (!file) { showMsg('phMsg', 'Choose a photo first (JPG, PNG or WebP, max 5MB).'); return; }
  if (!mPlaces.length) { showMsg('phMsg', 'No places assigned to you yet — ask your district head to assign your places first.'); return; }
  const fd = new FormData();
  fd.append('place', $('phPlace').value);
  fd.append('date', $('phDate').value);
  fd.append('source_label', $('phSource').value.trim());
  fd.append('photo', file);
  const r = await fetch('/api/district-manager/photo', { method: 'POST', headers: { Authorization: 'Bearer ' + mToken }, body: fd });
  const data = await r.json().catch(() => ({}));
  showMsg('phMsg', data.ok ? `Photo uploaded for ${data.place} (${data.date}). It shows to the public only after your district head approves it.` : ('Error: ' + (data.error || 'unknown')), !!data.ok);
});
if (mToken && mDistrict) showPanel();
