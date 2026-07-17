'use strict';

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
let state = { employees: [], leaves: [], corrections: [], notifications: [], cards: [] };
let messageTimer = null;

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) { location.replace('/'); throw new Error('Please sign in again.'); }
  if (response.status === 403) { location.replace('/dashboard'); throw new Error('HR access is required.'); }
  if (!response.ok) throw new Error(data.message || `Request failed (${response.status}).`);
  return data;
}

function message(text, type = 'info') {
  clearTimeout(messageTimer); const box = $('message'); box.textContent = text; box.dataset.type = type; box.classList.add('show');
  messageTimer = setTimeout(() => box.classList.remove('show'), 4500);
}

function setBusy(button, busy, label) {
  if (!button.dataset.label) button.dataset.label = button.textContent.trim();
  button.disabled = busy; button.textContent = busy ? label : button.dataset.label;
}

function empty(text) { return `<div class="empty-state">${esc(text)}</div>`; }
function renderRequests(target, rows, type) {
  $(target).innerHTML = rows.map((row) => `<article class="request"><div class="request-head"><strong>${esc(row.employeeName)}</strong><span class="status ${esc(String(row.status).toLowerCase())}">${esc(row.status)}</span></div><p>${type === 'leave' ? `${esc(row.leaveType)} · ${esc(row.fromDate)} to ${esc(row.toDate)}` : `${esc(row.dateKey)} · ${esc(row.requestedTimeIn || '—')} to ${esc(row.requestedTimeOut || '—')}`}<br>${esc(row.reason || 'No reason provided')}</p>${row.reviewRemarks ? `<p><strong>Review note:</strong> ${esc(row.reviewRemarks)}</p>` : ''}<div class="actions"><button data-review="${type}" data-id="${esc(row.id)}" data-status="APPROVED" ${row.status !== 'PENDING' ? 'disabled' : ''}>Approve</button><button class="reject" data-review="${type}" data-id="${esc(row.id)}" data-status="REJECTED" ${row.status !== 'PENDING' ? 'disabled' : ''}>Reject</button></div></article>`).join('') || empty(`No ${type === 'leave' ? 'leave' : 'correction'} requests.`);
}

function render() {
  const present = state.cards.filter((row) => /PRESENT|LATE/.test(row.status || '')).length;
  const pending = [...state.leaves, ...state.corrections].filter((row) => row.status === 'PENDING').length;
  $('summary').innerHTML = [['Active employees', state.employees.filter((row) => row.active !== false).length], ['Present today', present], ['Pending requests', pending], ['Notifications', state.notifications.length]].map(([label, value]) => `<article><span>${label}</span><strong>${value}</strong></article>`).join('');
  $('attendanceRows').innerHTML = state.cards.map((row) => `<tr><td><strong>${esc(row.fullName)}</strong></td><td>${esc(row.schedule || '—')}</td><td>${esc(row.timeIn || '—')}</td><td>${esc(row.timeOut || '—')}</td><td><span class="status ${esc(String(row.status || '').toLowerCase())}">${esc(row.status || 'No record')}</span></td></tr>`).join('') || '<tr><td colspan="5" class="empty-cell">No attendance records today.</td></tr>';
  $('employeeGrid').innerHTML = state.employees.map((row) => `<article class="employee"><strong>${esc(row.fullName)}</strong><span>${esc(row.employeeCode || row.id)} · ${row.active === false ? 'Inactive' : 'Active'}</span><span>Fingerprint: ${esc(row.fingerprintId ?? 'Not linked')}</span><span>Shift: ${esc(row.shiftStart || '—')} – ${esc(row.shiftEnd || '—')}</span></article>`).join('') || empty('No employees yet.');
  renderRequests('leaveRows', state.leaves, 'leave'); renderRequests('correctionRows', state.corrections, 'correction');
  $('notificationRows').innerHTML = state.notifications.map((row) => `<article class="notification"><strong>${esc(row.title)}</strong><p>${esc(row.message)} · ${new Date(row.createdAt).toLocaleString()}</p></article>`).join('') || empty('No notifications.');
}

async function load() {
  const today = new Date().toLocaleDateString('en-CA');
  const [me, settings, employees, timecard, leaves, corrections, notifications] = await Promise.all([api('/api/auth/me'), api('/api/settings'), api('/api/employees'), api(`/api/time-card?from=${today}&to=${today}`), api('/api/leave-requests'), api('/api/correction-requests'), api('/api/notifications')]);
  if (me.role !== 'hr') { location.replace(me.role === 'employee' ? '/employee' : '/dashboard'); return; }
  $('branchLabel').textContent = `${settings.settings.branchName || 'Main Branch'} · Signed in as ${me.username}`;
  $('accountPhoneInput').value = me.phone || '';
  $('phoneLinkStatus').textContent = me.phone || 'Not bound';
  $('bindPhoneBtn').textContent = me.phone ? 'Update' : 'Bind';
  ['google', 'facebook'].forEach((provider) => { const connected = Boolean(me.socialConnections?.[provider]); const status = $(`${provider}LinkStatus`); const button = document.querySelector(`[data-link-provider="${provider}"]`); if (status) status.textContent = connected ? 'Connected' : 'Not connected'; if (button) button.textContent = connected ? 'Reconnect' : 'Connect'; });
  if ($('managedAccountNote')) $('managedAccountNote').textContent = me.managedAccount ? 'This HR account can bind social sign-in.' : 'Create a managed HR account with this same username in Admin → User Accounts before binding social sign-in.';
  state = { employees: employees.employees || [], cards: timecard.timeCards || [], leaves: leaves.leaveRequests || [], corrections: corrections.correctionRequests || [], notifications: notifications.notifications || [] };
  render();
}

document.querySelectorAll('nav [data-section]').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('nav [data-section],.page').forEach((item) => item.classList.remove('active'));
  button.classList.add('active'); $(button.dataset.section).classList.add('active'); history.replaceState({}, '', `#${button.dataset.section}`);
}));

document.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-review]'); if (!button) return;
  const remarks = button.dataset.status === 'REJECTED' ? window.prompt('Reason for rejection (required):', '') : window.prompt('Approval note (optional):', '');
  if (remarks === null) return;
  if (button.dataset.status === 'REJECTED' && !remarks.trim()) return message('Enter a reason before rejecting a request.', 'error');
  setBusy(button, true, button.dataset.status === 'APPROVED' ? 'Approving...' : 'Rejecting...');
  try { await api(`/api/${button.dataset.review === 'leave' ? 'leave-requests' : 'correction-requests'}/${encodeURIComponent(button.dataset.id)}/review`, { method: 'PATCH', body: JSON.stringify({ status: button.dataset.status, remarks: remarks.trim() }) }); await load(); message(`Request ${button.dataset.status.toLowerCase()}.`, 'success'); }
  catch (error) { message(error.message, 'error'); setBusy(button, false); }
});

$('refreshBtn').addEventListener('click', async () => { setBusy($('refreshBtn'), true, 'Refreshing...'); try { await load(); message('HR workspace refreshed.', 'success'); } catch (error) { message(error.message, 'error'); } finally { setBusy($('refreshBtn'), false); } });
$('phoneBindForm').addEventListener('submit', async (event) => { event.preventDefault(); const button = $('bindPhoneBtn'); setBusy(button, true, 'Saving...'); try { const result = await api('/api/auth/phone', { method: 'PATCH', body: JSON.stringify({ phone: $('accountPhoneInput').value.trim() }) }); $('accountPhoneInput').value = result.phone; $('phoneLinkStatus').textContent = result.phone; button.dataset.label = 'Update'; message('Phone number bound to your HR account.', 'success'); } catch (error) { message(error.message, 'error'); } finally { setBusy(button, false); } });
$('logoutBtn').addEventListener('click', async () => { setBusy($('logoutBtn'), true, 'Signing out...'); try { await api('/api/auth/logout', { method: 'POST' }); } finally { location.replace('/'); } });

const initialSection = location.hash.slice(1);
if (initialSection && document.querySelector(`[data-section="${CSS.escape(initialSection)}"]`)) document.querySelector(`[data-section="${CSS.escape(initialSection)}"]`).click();
load().catch((error) => message(error.message, 'error'));
