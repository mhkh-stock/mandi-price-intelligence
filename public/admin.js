'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
$('fDate').value = new Date().toISOString().slice(0, 10);
let adminMeta = null;
function fillAdminDistricts() {
  const g = adminMeta.provinces.find((x) => x.name === $('fProv').value);
  $('fCity').innerHTML = (g ? g.districts : []).map((d) => `<option>${esc(d.name)}</option>`).join('');
}
async function loadCities() {
  try {
    adminMeta = await (await fetch('/api/meta')).json();
    $('fProv').innerHTML = adminMeta.provinces.map((g) => `<option>${esc(g.name)}</option>`).join('');
    if ([...$('fProv').options].some((o) => o.value === 'Punjab')) $('fProv').value = 'Punjab';
    fillAdminDistricts();
    $('daNewDistrict').innerHTML = adminMeta.provinces.flatMap((g) => g.districts.map((d) => `<option value="${esc(d.name)}">${esc(g.name)} — ${esc(d.name)}</option>`)).join('');
  } catch { /* selects stay empty until meta loads */ }
}
$('fProv').addEventListener('change', fillAdminDistricts);
loadCities();
async function loadRecent() {
  const code = $('code').value;
  const data = await (await fetch('/api/admin/recent', { headers: { 'X-Master-Code': code } })).json();
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
  const body = { code: $('code').value, name_en: $('iEn').value.trim(), name_ur: $('iUr').value.trim(), unit: $('iUnit').value, category: $('iCat').value };
  const data = await (await fetch('/api/admin/item', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  const m = $('saveMsg'); m.style.display = 'block';
  m.textContent = data.ok ? 'Item added.' : ('Error: ' + (data.error || 'unknown'));
});
$('districtBtn').addEventListener('click', async () => {
  const body = { code: $('code').value, name: $('dName').value.trim(), province: $('dProv').value };
  const data = await (await fetch('/api/admin/city', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  const m = $('saveMsg'); m.style.display = 'block';
  m.textContent = data.ok ? 'District added.' : ('Error: ' + (data.error || 'unknown'));
  if (data.ok) loadCities();
});
$('refreshBtn').addEventListener('click', async () => {
  const m = $('refreshMsg'); m.style.display = 'block';
  m.textContent = 'Refreshing from AMIS — please wait…';
  const data = await (await fetch('/api/admin/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: $('code').value }) })).json();
  if (data.ok) {
    m.textContent = `Refreshed for ${data.date}: ${data.inserted} new rows, ${data.updated} updated, ${data.skipped} skipped (unknown markets).` + (data.unmatched_crops.length ? ` New items added: ${data.unmatched_crops.join(', ')}.` : '');
  } else {
    m.textContent = 'Refresh did not run: ' + (data.reason || data.error || 'unknown') + (data.retry_after_seconds ? ` — try again in ${Math.ceil(data.retry_after_seconds / 60)} min.` : '');
  }
});
$('refreshVpBtn').addEventListener('click', async () => {
  const m = $('refreshMsg'); m.style.display = 'block';
  m.textContent = 'Refreshing from the AMIS price database (all commodities, ~140 markets) — please wait…';
  const data = await (await fetch('/api/admin/refresh-viewprices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: $('code').value }) })).json();
  if (data.ok) {
    m.textContent = `ViewPrices refreshed for ${data.date}: ${data.inserted} new rows, ${data.updated} updated, ${data.quarantined} outliers sent to the review queue, ${data.skipped} skipped.` + (data.unmatched_markets.length ? ` Unmapped markets: ${data.unmatched_markets.join(', ')}.` : '');
  } else {
    m.textContent = 'ViewPrices refresh did not run: ' + (data.reason || data.error || 'unknown') + (data.retry_after_seconds ? ` — try again in ${Math.ceil(data.retry_after_seconds / 60)} min.` : '');
  }
});
$('daCreateBtn').addEventListener('click', async () => {
  const body = { code: $('code').value, username: $('daNewUser').value.trim(), password: $('daNewPass').value, district: $('daNewDistrict').value,
    officer_name: $('daOfficer').value.trim(), designation: $('daDesignation').value.trim(),
    documents: [{ doc_type: $('daDocType').value, doc_number: $('daDocNum').value.trim(), issuing_authority: $('daDocAuth').value.trim(), issue_date: $('daDocDate').value }] };
  const data = await (await fetch('/api/admin/district-admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  const m = $('daMsg'); m.style.display = 'block';
  m.textContent = data.ok ? `District admin created: ${data.username} for ${data.district} — INACTIVE. Activate it below to make the district officially managed.` : ('Error: ' + (data.error || 'unknown'));
  if (data.ok) loadAdmins();
});
function docText(docs) {
  return (docs || []).map((d) => `${esc(d.doc_type)} #${esc(d.doc_number)}`).join('; ') || '—';
}
async function viewScan(docId) {
  const r = await fetch('/api/documents/scan/' + encodeURIComponent(docId), { headers: { 'X-Master-Code': $('code').value } });
  if (!r.ok) { alert('Could not open the scan: ' + r.status); return; }
  window.open(URL.createObjectURL(await r.blob()), '_blank');
}
async function loadPendingRegistrations() {
  const code = $('code').value;
  const m = $('pendingMsg'); m.style.display = 'block';
  const [heads, mgrs] = await Promise.all([
    (await fetch('/api/admin/pending-heads', { headers: { 'X-Master-Code': code } })).json(),
    (await fetch('/api/admin/pending-managers', { headers: { 'X-Master-Code': code } })).json(),
  ]);
  if (heads.error || mgrs.error) { m.textContent = 'Error: ' + (heads.error || mgrs.error); return; }
  m.textContent = `${heads.pending.length} pending head(s), ${mgrs.pending.length} pending manager(s).`;
  const render = (rows, bodyId, approveUrl, needAppt) => {
    $(bodyId).innerHTML = rows.length
      ? rows.map((r) => `<tr><td>${esc(r.username)}</td><td>${esc(r.district)}</td><td>${esc(r.officer_name)}</td><td>${esc(r.designation)}</td><td>${docText(r.documents)} ${(r.documents || []).map((d) => d.scan_path ? `<button data-scan="${d.id}">View scan</button>` : '').join('')}</td><td>
          ${needAppt ? `<input data-appt="${esc(r.username)}" placeholder="appointment order ref" style="min-width:170px">` : ''}
          <button data-approve="${esc(r.username)}" data-url="${approveUrl}">Approve</button> <button data-reject="${esc(r.username)}" data-url="${approveUrl}">Reject</button>
        </td></tr>`).join('')
      : `<tr><td colspan="6">None pending.</td></tr>`;
  };
  render(heads.pending, 'pendingHeadBody', '/api/admin/head/approve', false);
  render(mgrs.pending, 'pendingMgrBody', '/api/admin/manager/approve', true);
  document.querySelectorAll('#pendingHeadBody button[data-scan], #pendingMgrBody button[data-scan]').forEach((b) => b.addEventListener('click', () => viewScan(b.dataset.scan)));
  document.querySelectorAll('#pendingHeadBody button[data-approve], #pendingMgrBody button[data-approve]').forEach((b) => b.addEventListener('click', async () => {
    const u = b.dataset.approve;
    const input = document.querySelector(`input[data-appt="${u}"]`);
    const body = { code, username: u, decision: 'approve' };
    if (input) body.appointment_ref = input.value.trim();
    const d = await (await fetch(b.dataset.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    m.textContent = d.ok ? `${u} approved.` : ('Error: ' + (d.error || 'unknown'));
    if (d.ok) loadPendingRegistrations();
  }));
  document.querySelectorAll('#pendingHeadBody button[data-reject], #pendingMgrBody button[data-reject]').forEach((b) => b.addEventListener('click', async () => {
    const d = await (await fetch(b.dataset.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code, username: b.dataset.reject, decision: 'reject' }) })).json();
    m.textContent = d.ok ? `${b.dataset.reject} rejected.` : ('Error: ' + (d.error || 'unknown'));
    if (d.ok) loadPendingRegistrations();
  }));
}
$('pendingLoadBtn').addEventListener('click', loadPendingRegistrations);
async function loadAdmins() {
  const data = await (await fetch('/api/admin/district-admins', { headers: { 'X-Master-Code': $('code').value } })).json();
  const m = $('daMsg'); m.style.display = 'block';
  if (data.error) { m.textContent = 'Error: ' + data.error; $('daBody').innerHTML = ''; return; }
  m.textContent = data.admins.length ? `${data.admins.length} district admin(s).` : 'No district admins yet.';
  $('daBody').innerHTML = data.admins.map((a) => `<tr><td>${esc(a.username)}</td><td>${esc(a.district)}</td><td>${esc(a.officer_name || '—')}</td><td>${esc(a.designation || '—')}</td><td>${docText(a.documents)}</td><td>${a.active ? '✅ Active — official' : '⏸️ Inactive'}</td><td>${a.active
    ? `<button data-suspend="${esc(a.username)}">Suspend</button>`
    : `<button data-activate="${esc(a.username)}">Activate</button>`} <button data-remove-da="${esc(a.username)}">Remove</button></td></tr>`).join('');
  document.querySelectorAll('#daBody button[data-activate]').forEach((b) => b.addEventListener('click', async () => {
    const d = await (await fetch('/api/admin/district-admin/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: $('code').value, username: b.dataset.activate }) })).json();
    m.textContent = d.ok ? `${b.dataset.activate} activated — the district is now officially managed.` : ('Error: ' + (d.error || 'unknown'));
    loadAdmins();
  }));
  document.querySelectorAll('#daBody button[data-suspend]').forEach((b) => b.addEventListener('click', async () => {
    const d = await (await fetch('/api/admin/district-admin/suspend', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: $('code').value, username: b.dataset.suspend }) })).json();
    m.textContent = d.ok ? `${b.dataset.suspend} suspended — login blocked, sessions ended.` : ('Error: ' + (d.error || 'unknown'));
    loadAdmins();
  }));
  document.querySelectorAll('#daBody button[data-remove-da]').forEach((b) => b.addEventListener('click', async () => {
    const d = await (await fetch('/api/admin/district-admin/remove', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: $('code').value, username: b.dataset.removeDa }) })).json();
    m.textContent = d.ok ? `${b.dataset.removeDa} removed.` : ('Error: ' + (d.error || 'unknown'));
    loadAdmins();
  }));
}
$('daListBtn').addEventListener('click', loadAdmins);
$('auditLoadBtn').addEventListener('click', async () => {
  const data = await (await fetch('/api/admin/district-admin/audit', { headers: { 'X-Master-Code': $('code').value } })).json();
  if (data.error) { $('auditBody').innerHTML = `<tr><td colspan="7">${esc(data.error)}</td></tr>`; return; }
  $('auditBody').innerHTML = data.rows.length
    ? data.rows.map((r) => `<tr><td>${esc(r.created_at)}</td><td>${esc(r.username)}</td><td>${esc(r.district)}</td><td>${esc(r.designation || '—')}</td><td>${esc(r.licence_ref || '—')}</td><td>${esc(r.action)}</td><td>${esc(r.detail)}</td></tr>`).join('')
    : '<tr><td colspan="7">No audit entries yet.</td></tr>';
});
async function loadQueue() {
  const data = await (await fetch('/api/review/queue', { headers: { 'X-Master-Code': $('code').value } })).json();
  if (data.error) { $('queueBody').innerHTML = `<tr><td colspan="7">${esc(data.error)}</td></tr>`; return; }
  $('queueBody').innerHTML = data.rows.length
    ? data.rows.map((r) => `<tr><td>${esc(r.item)}</td><td>${esc(r.district)}</td><td>Rs ${esc(r.price)} / ${esc(r.unit)} (${esc(r.kind)})</td><td>${esc(r.source)}</td><td>${esc(r.date)}</td><td>${esc(r.proposed_by)}</td><td><button data-decide="approve|${r.id}">Approve</button> <button data-decide="reject|${r.id}">Reject</button></td></tr>`).join('')
    : '<tr><td colspan="7">Nothing pending.</td></tr>';
  document.querySelectorAll('#queueBody button[data-decide]').forEach((b) => b.addEventListener('click', async () => {
    const [decision, id] = b.dataset.decide.split('|');
    const data2 = await (await fetch('/api/review/decide', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: $('code').value, id: Number(id), decision }) })).json();
    const m = $('daMsg'); m.style.display = 'block';
    m.textContent = data2.ok ? `Entry ${id} ${decision}d.` : ('Error: ' + (data2.error || 'unknown'));
    loadQueue();
  }));
}
$('queueLoadBtn').addEventListener('click', loadQueue);
