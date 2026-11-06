'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => n === null || n === undefined ? '—' : 'Rs ' + Number(n).toLocaleString('en-PK', { maximumFractionDigits: 2 });
let daToken = sessionStorage.getItem('daToken') || '';
let daDistrict = sessionStorage.getItem('daDistrict') || '';
let daUser = sessionStorage.getItem('daUser') || '';
let daRole = sessionStorage.getItem('daRole') || '';
$('rDate').value = new Date().toISOString().slice(0, 10);

function showPanel() {
  $('loginBox').style.display = 'none';
  $('panel').style.display = 'block';
  $('daDistrict').textContent = daDistrict;
  loadItems();
  loadMyRates();
  loadQueue();
  loadManagers();
  loadPendingManagers();
  loadPhotos();
}
function showLogin() {
  $('loginBox').style.display = 'block';
  $('panel').style.display = 'none';
}
async function loadItems() {
  try {
    const meta = await (await fetch('/api/meta')).json();
    $('rItem').innerHTML = meta.items.map((i) => `<option value="${esc(i.en)}">${esc(i.en)} (${esc(i.ur)}) — ${esc(i.unit)}</option>`).join('');
  } catch { /* item list stays empty until meta loads */ }
}
const unitUrdu = (u) => u === 'dozen' ? 'درجن' : 'کلو';
async function loadMyRates() {
  const data = await (await fetch('/api/district-admin/my-rates', { headers: { Authorization: 'Bearer ' + daToken } })).json();
  if (data.error) { $('myRatesBody').innerHTML = `<tr><td colspan="5">${esc(data.error)}</td></tr>`; return; }
  $('myRatesBody').innerHTML = data.rows.length
    ? data.rows.map((r) => {
        // Wholesale is stored Rs/100kg for kg and as-is per dozen — show
        // the per-unit price with the row's own unit, never a hard-coded kg.
        const price = r.rb !== null ? fmt(r.rb) + ' / ' + unitUrdu(r.unit) + ' (retail)'
          : fmt(r.unit === 'dozen' ? r.w : r.w / 100) + ' / ' + unitUrdu(r.unit) + ' (wholesale)';
        return `<tr><td>${esc(r.date)}</td><td>${esc(r.item)}</td><td>${price}</td><td>${esc(r.source)}</td><td><button data-del="${esc(r.date)}|${esc(r.item)}">Delete</button></td></tr>`;
      }).join('')
    : '<tr><td colspan="5">No entries yet.</td></tr>';
  document.querySelectorAll('#myRatesBody button[data-del]').forEach((b) => b.addEventListener('click', async () => {
    const [date, item] = b.dataset.del.split('|');
    const data2 = await (await fetch('/api/district-admin/rate/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: daToken, district: daDistrict, item, date }) })).json();
    const m = $('rMsg'); m.style.display = 'block';
    m.textContent = data2.ok ? `Deleted ${item} (${date}).` : ('Error: ' + (data2.error || 'unknown'));
    loadMyRates();
  }));
}
async function loadQueue() {
  const data = await (await fetch('/api/review/queue', { headers: { Authorization: 'Bearer ' + daToken } })).json();
  if (data.error) { $('queueBody').innerHTML = `<tr><td colspan="6">${esc(data.error)}</td></tr>`; return; }
  $('queueBody').innerHTML = data.rows.length
    ? data.rows.map((r) => `<tr><td>${esc(r.item)}</td><td>${fmt(r.price)} / ${esc(r.unit)} (${esc(r.kind)})</td><td>${esc(r.source)}</td><td>${esc(r.date)}</td><td>${esc(r.proposed_by)}</td><td><button data-decide="approve|${r.id}">Approve</button> <button data-decide="reject|${r.id}">Reject</button></td></tr>`).join('')
    : '<tr><td colspan="6">Nothing pending for your district.</td></tr>';
  document.querySelectorAll('#queueBody button[data-decide]').forEach((b) => b.addEventListener('click', async () => {
    const [decision, id] = b.dataset.decide.split('|');
    const data2 = await (await fetch('/api/review/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: daToken, id: Number(id), decision }) })).json();
    const m = $('rMsg'); m.style.display = 'block';
    m.textContent = data2.ok ? `Entry ${id} ${decision}d.` : ('Error: ' + (data2.error || 'unknown'));
    loadQueue();
    loadMyRates();
  }));
}
// ---- v3.2/v3.3: managers + photos (head only) ----
function docText(docs) {
  return (docs || []).map((d) => `${esc(d.doc_type)} #${esc(d.doc_number)}`).join('; ') || '—';
}
async function viewScan(docId) {
  const r = await fetch('/api/documents/scan/' + encodeURIComponent(docId), { headers: { Authorization: 'Bearer ' + daToken } });
  if (!r.ok) { alert('Could not open the scan: ' + r.status); return; }
  const blob = await r.blob();
  window.open(URL.createObjectURL(blob), '_blank');
}
async function loadManagers() {
  const data = await (await fetch('/api/district-admin/managers', { headers: { Authorization: 'Bearer ' + daToken } })).json();
  if (data.error) { $('mgrBody').innerHTML = `<tr><td colspan="6">${esc(data.error)}</td></tr>`; return; }
  $('mgrBody').innerHTML = data.managers.length
    ? data.managers.map((m) => `<tr><td>${esc(m.username)}</td><td>${esc(m.officer_name)}</td><td>${esc(m.designation)}</td><td>${esc((m.assigned_places || []).join(', ') || '—')}</td><td>${esc(m.status)}${m.active ? '' : ' (login off)'}</td><td>
        <input data-places="${esc(m.username)}" placeholder="places, comma separated" value="${esc((m.assigned_places || []).join(', '))}" style="min-width:180px">
        <button data-setplaces="${esc(m.username)}">Set places</button>
        ${m.active ? `<button data-suspend="${esc(m.username)}">Suspend</button>` : `<button data-activate="${esc(m.username)}">Activate</button>`}
        ${(m.documents || []).map((d) => d.scan_path ? `<button data-scan="${d.id}">View scan: ${esc(d.doc_number)}</button>` : '').join('')}
      </td></tr>`).join('')
    : '<tr><td colspan="6">No managers yet.</td></tr>';
  document.querySelectorAll('#mgrBody button[data-setplaces]').forEach((b) => b.addEventListener('click', async () => {
    const u = b.dataset.setplaces;
    const input = document.querySelector(`#mgrBody input[data-places="${u}"]`);
    const places = input.value.split(',').map((s) => s.trim()).filter(Boolean);
    const d2 = await (await fetch('/api/district-admin/manager/places', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + daToken }, body: JSON.stringify({ username: u, places }) })).json();
    const m = $('mgrMsg'); m.style.display = 'block';
    m.textContent = d2.ok ? `Places for ${u} set to: ${places.join(', ') || '(none)'}.` : ('Error: ' + (d2.error || 'unknown'));
    if (d2.ok) loadManagers();
  }));
  document.querySelectorAll('#mgrBody button[data-activate]').forEach((b) => b.addEventListener('click', async () => {
    const d2 = await (await fetch('/api/district-admin/manager/activate', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + daToken }, body: JSON.stringify({ username: b.dataset.activate }) })).json();
    const m = $('mgrMsg'); m.style.display = 'block';
    m.textContent = d2.ok ? `Manager ${b.dataset.activate} activated — they can log in now.` : ('Error: ' + (d2.error || 'unknown'));
    if (d2.ok) loadManagers();
  }));
  document.querySelectorAll('#mgrBody button[data-suspend]').forEach((b) => b.addEventListener('click', async () => {
    const d2 = await (await fetch('/api/district-admin/manager/suspend', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + daToken }, body: JSON.stringify({ username: b.dataset.suspend }) })).json();
    const m = $('mgrMsg'); m.style.display = 'block';
    m.textContent = d2.ok ? `Manager ${b.dataset.suspend} suspended — their login is blocked and their sessions ended.` : ('Error: ' + (d2.error || 'unknown'));
    if (d2.ok) loadManagers();
  }));
  document.querySelectorAll('#mgrBody button[data-scan]').forEach((b) => b.addEventListener('click', () => viewScan(b.dataset.scan)));
}
async function loadPendingManagers() {
  const data = await (await fetch('/api/district-admin/pending-managers', { headers: { Authorization: 'Bearer ' + daToken } })).json();
  if (data.error) { $('pendingMgrBody').innerHTML = `<tr><td colspan="5">${esc(data.error)}</td></tr>`; return; }
  $('pendingMgrBody').innerHTML = data.pending.length
    ? data.pending.map((r) => `<tr><td>${esc(r.username)}</td><td>${esc(r.officer_name)}</td><td>${esc(r.designation)}</td><td>${docText(r.documents)} ${(r.documents || []).map((d) => d.scan_path ? `<button data-scan="${d.id}">View scan</button>` : '').join('')}</td><td>
        <input data-appt="${esc(r.username)}" placeholder="appointment order ref" style="min-width:170px">
        <button data-approve="${esc(r.username)}">Approve</button> <button data-reject="${esc(r.username)}">Reject</button>
      </td></tr>`).join('')
    : '<tr><td colspan="5">No pending manager registrations.</td></tr>';
  document.querySelectorAll('#pendingMgrBody button[data-approve]').forEach((b) => b.addEventListener('click', async () => {
    const u = b.dataset.approve;
    const input = document.querySelector(`#pendingMgrBody input[data-appt="${u}"]`);
    const d2 = await (await fetch('/api/district-admin/manager/approve', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + daToken }, body: JSON.stringify({ username: u, decision: 'approve', appointment_ref: input.value.trim() }) })).json();
    const m = $('mgrMsg'); m.style.display = 'block';
    m.textContent = d2.ok ? `Manager ${u} approved — they can log in now.` : ('Error: ' + (d2.error || 'unknown'));
    if (d2.ok) { loadPendingManagers(); loadManagers(); }
  }));
  document.querySelectorAll('#pendingMgrBody button[data-reject]').forEach((b) => b.addEventListener('click', async () => {
    const d2 = await (await fetch('/api/district-admin/manager/approve', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + daToken }, body: JSON.stringify({ username: b.dataset.reject, decision: 'reject' }) })).json();
    const m = $('mgrMsg'); m.style.display = 'block';
    m.textContent = d2.ok ? `Manager ${b.dataset.reject} rejected — they cannot log in.` : ('Error: ' + (d2.error || 'unknown'));
    if (d2.ok) loadPendingManagers();
  }));
  document.querySelectorAll('#pendingMgrBody button[data-scan]').forEach((b) => b.addEventListener('click', () => viewScan(b.dataset.scan)));
}
async function loadPhotos() {
  const data = await (await fetch('/api/district-admin/photos', { headers: { Authorization: 'Bearer ' + daToken } })).json();
  if (data.error) { $('photoBody').innerHTML = `<tr><td colspan="5">${esc(data.error)}</td></tr>`; return; }
  $('photoBody').innerHTML = data.photos.length
    ? await Promise.all(data.photos.map(async (p) => {
        // Pending photos are not public, so the thumbnail is fetched with
        // the head's token and shown from a blob URL.
        let img = '';
        try {
          const r = await fetch(p.file_url, { headers: { Authorization: 'Bearer ' + daToken } });
          if (r.ok) img = `<img src="${URL.createObjectURL(await r.blob())}" alt="rates page photo" style="max-width:160px;max-height:120px;border:1px solid #e5e7eb;border-radius:8px">`;
        } catch { img = '(photo could not be loaded)'; }
        return `<tr><td>${esc(p.date)}</td><td>${esc(p.place)}</td><td>${esc(p.source_label)}</td><td>${img}</td><td><button data-photo="approve|${p.id}">Approve</button> <button data-photo="reject|${p.id}">Reject</button></td></tr>`;
      })).then((rows) => rows.join(''))
    : '<tr><td colspan="5">No pending rates-page photos.</td></tr>';
  document.querySelectorAll('#photoBody button[data-photo]').forEach((b) => b.addEventListener('click', async () => {
    const [decision, id] = b.dataset.photo.split('|');
    const d2 = await (await fetch('/api/photo/decide', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + daToken }, body: JSON.stringify({ id: Number(id), decision }) })).json();
    const m = $('rMsg'); m.style.display = 'block';
    m.textContent = d2.ok ? `Photo ${id} ${decision}d${decision === 'approve' ? ' — it now shows to the public on the district page.' : '.'}` : ('Error: ' + (d2.error || 'unknown'));
    if (d2.ok) loadPhotos();
  }));
}
$('mgrCreateBtn').addEventListener('click', async () => {
  const docs = [{
    doc_type: $('mgrDocType').value,
    doc_number: $('mgrDocNum').value.trim(),
    issuing_authority: $('mgrDocAuth').value.trim(),
    issue_date: $('mgrDocDate').value,
  }];
  const body = { username: $('mgrUser').value.trim(), password: $('mgrPass').value, name: $('mgrName').value.trim(), designation: $('mgrDesig').value.trim(), appointment_ref: $('mgrAppt').value.trim(), documents: docs };
  const data = await (await fetch('/api/district-admin/manager', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + daToken }, body: JSON.stringify(body) })).json();
  const m = $('mgrMsg'); m.style.display = 'block';
  m.textContent = data.ok ? `Manager ${data.username} appointed for ${data.district} (inactive). Add their places, then activate them.` : ('Error: ' + (data.error || 'unknown'));
  if (data.ok) loadManagers();
});
$('daLoginBtn').addEventListener('click', async () => {
  const data = await (await fetch('/api/district-admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: $('daUser').value.trim(), password: $('daPass').value }) })).json();
  const m = $('daLoginMsg'); m.style.display = 'block';
  if (!data.ok) { m.textContent = 'Login failed: ' + (data.error || 'unknown'); return; }
  if (data.role === 'manager') {
    m.innerHTML = 'This page is for district heads. Managers use the <a href="manager.html">Manager page</a>.';
    return;
  }
  daToken = data.token; daDistrict = data.district; daUser = data.username; daRole = data.role;
  sessionStorage.setItem('daToken', daToken);
  sessionStorage.setItem('daDistrict', daDistrict);
  sessionStorage.setItem('daUser', daUser);
  sessionStorage.setItem('daRole', daRole);
  showPanel();
});
$('daLogoutBtn').addEventListener('click', async () => {
  // Server-side logout: the token is deleted, so logging out really ends
  // the session instead of just clearing this browser's storage.
  try { await fetch('/api/district-admin/logout', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + daToken }, body: JSON.stringify({}) }); } catch { /* logged out locally anyway */ }
  daToken = ''; daDistrict = ''; daUser = ''; daRole = '';
  sessionStorage.removeItem('daToken');
  sessionStorage.removeItem('daDistrict');
  sessionStorage.removeItem('daUser');
  sessionStorage.removeItem('daRole');
  showLogin();
});
$('daPassBtn').addEventListener('click', async () => {
  const data = await (await fetch('/api/district-admin/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + daToken }, body: JSON.stringify({ old_password: $('daOldPass').value, new_password: $('daNewPass').value }) })).json();
  const m = $('rMsg'); m.style.display = 'block';
  m.textContent = data.ok ? 'Password changed. Your other sessions were ended.' : ('Error: ' + (data.error || 'unknown'));
  if (data.ok) { $('daOldPass').value = ''; $('daNewPass').value = ''; }
});
$('rSaveBtn').addEventListener('click', async () => {
  const body = { token: daToken, district: daDistrict, item: $('rItem').value, price: Number($('rPrice').value), unit: $('rUnit').value, kind: $('rKind').value, source: $('rSource').value.trim(), date: $('rDate').value };
  const data = await (await fetch('/api/district-admin/rate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  const m = $('rMsg'); m.style.display = 'block';
  m.textContent = data.ok ? `Saved ${data.item} for ${data.district} (${data.date}).` : ('Error: ' + (data.error || 'unknown'));
  if (data.ok) loadMyRates();
});
if (daToken && daDistrict) showPanel();
