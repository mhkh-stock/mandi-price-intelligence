'use strict';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DOC_TYPES = ['Appointment Letter', 'Posting-Transfer Order', 'Service Card', 'Market Committee Authorisation', 'CNIC', 'Other'];
let registeredUser = '';
let registeredDocs = [];
// Registration portal: the two role cards open the form with that role
// preselected (manager is the default, as before). The form stays hidden
// until a role is picked — or a ?role=head|manager link opens it directly.
let selectedRole = 'manager';
function showForm(role) {
  selectedRole = role;
  document.querySelectorAll('.role-card').forEach((c) => {
    const on = c.dataset.role === role;
    c.classList.toggle('selected', on);
    c.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  $('regRoleLabel').textContent = role === 'head' ? 'District Head' : 'Food Manager';
  $('rolePicker').hidden = true;
  $('regForm').hidden = false;
  $('regForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function showPicker() { $('rolePicker').hidden = false; $('regForm').hidden = true; }
document.querySelectorAll('.role-card').forEach((card) => {
  card.addEventListener('click', () => showForm(card.dataset.role));
});
$('changeRoleBtn').addEventListener('click', showPicker);
const qRole = new URLSearchParams(window.location.search).get('role');
if (qRole === 'head' || qRole === 'manager') showForm(qRole);

function docRow(n) {
  const div = document.createElement('div');
  div.className = 'row';
  div.dataset.doc = '1';
  div.innerHTML = `
    <label>Document type <select class="docType">${DOC_TYPES.map((t) => `<option>${esc(t)}</option>`).join('')}</select></label>
    <label>Document number <input class="docNumber" placeholder="e.g. PPSC-2024-118"></label>
    <label>Issuing authority <input class="docAuthority" placeholder="e.g. Punjab Food Department"></label>
    <label>Issue date <input class="docIssue" type="date"></label>
    <label>Expiry date (if any) <input class="docExpiry" type="date"></label>
    ${n > 1 ? '<button type="button" class="docRemove">Remove</button>' : ''}`;
  const rm = div.querySelector('.docRemove');
  if (rm) rm.addEventListener('click', () => div.remove());
  return div;
}
function addDocRow() {
  const count = document.querySelectorAll('#docsBox [data-doc]').length;
  if (count >= 5) { showMsg('regMsg', 'You can add at most 5 documents.'); return; }
  $('docsBox').appendChild(docRow(count + 1));
}
function readDocs() {
  return [...document.querySelectorAll('#docsBox [data-doc]')].map((div) => ({
    doc_type: div.querySelector('.docType').value,
    doc_number: div.querySelector('.docNumber').value.trim(),
    issuing_authority: div.querySelector('.docAuthority').value.trim(),
    issue_date: div.querySelector('.docIssue').value,
    expiry_date: div.querySelector('.docExpiry').value || undefined,
  }));
}
function showMsg(id, text, ok) {
  const m = $(id); m.style.display = 'block';
  m.textContent = text;
  m.style.borderColor = ok ? '#15803d' : '#dc2626';
}
async function loadDistricts() {
  try {
    const meta = await (await fetch('/api/meta')).json();
    $('regDistrict').innerHTML = meta.provinces.flatMap((g) => g.districts.map((d) => `<option value="${esc(d.name)}">${esc(d.name)} (${esc(g.name)})</option>`)).join('');
  } catch { $('regDistrict').innerHTML = '<option value="">Could not load districts — try again</option>'; }
}
$('addDocBtn').addEventListener('click', addDocRow);
$('regBtn').addEventListener('click', async () => {
  const body = {
    username: $('regUser').value.trim(),
    password: $('regPass').value,
    district: $('regDistrict').value,
    officer_name: $('regName').value.trim(),
    designation: $('regDesig').value.trim(),
    documents: readDocs(),
  };
  const role = selectedRole;
  const data = await (await fetch('/api/register/' + role, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  if (!data.ok) { showMsg('regMsg', 'Registration failed: ' + (data.error || 'unknown error')); return; }
  registeredUser = data.username;
  registeredDocs = data.documents || [];
  showMsg('regMsg', `Registered as ${role} for ${data.district}. Your account is PENDING — ${role === 'head' ? 'the master' : 'your district head'} will review your documents and approve or reject it. You cannot log in until then.`, true);
  $('scanDoc').innerHTML = registeredDocs.map((d) => `<option value="${esc(d.doc_number)}">${esc(d.doc_type)} — ${esc(d.doc_number)}</option>`).join('');
  $('scanBox').style.display = 'block';
});
$('scanBtn').addEventListener('click', async () => {
  const file = $('scanFile').files[0];
  if (!file) { showMsg('scanMsg', 'Choose a scan file first (JPG, PNG, WebP or PDF, max 5MB).'); return; }
  const fd = new FormData();
  fd.append('username', registeredUser);
  fd.append('doc_number', $('scanDoc').value);
  fd.append('scan', file);
  const r = await fetch('/api/register/scan', { method: 'POST', body: fd });
  const data = await r.json().catch(() => ({}));
  if (!data.ok) { showMsg('scanMsg', 'Upload failed: ' + (data.error || 'unknown error')); return; }
  showMsg('scanMsg', 'Scan uploaded. Your approver can view it when reviewing your registration.', true);
});
addDocRow();
loadDistricts();
