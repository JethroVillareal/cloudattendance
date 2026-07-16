'use strict';

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
let portal = {};
let previewUrl = '';
let messageTimer = null;

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) { location.replace('/'); throw new Error('Please sign in again.'); }
  if (!response.ok) throw new Error(data.message || `Request failed (${response.status}).`);
  return data;
}

function message(text, type = 'info') {
  clearTimeout(messageTimer);
  const box = $('portalMessage');
  box.textContent = text;
  box.dataset.type = type;
  box.classList.toggle('show', Boolean(text));
  if (text) messageTimer = setTimeout(() => { box.textContent = ''; box.classList.remove('show'); }, 4500);
}

function setBusy(button, busy, label) {
  if (!button) return;
  if (!button.dataset.label) button.dataset.label = button.textContent.trim();
  button.disabled = busy;
  button.textContent = busy ? label : button.dataset.label;
}

function mins(value) { const total = Number(value || 0); return total >= 60 ? `${Math.floor(total / 60)}h ${total % 60}m` : `${total}m`; }
function empty(text) { return `<div class="empty-state">${esc(text)}</div>`; }
function renderAvatar(element, employee) {
  if (!element) return;
  element.innerHTML = employee.photoUrl ? `<img src="${esc(employee.photoUrl)}" alt="${esc(employee.fullName)}">` : esc(employee.fullName?.charAt(0) || 'E');
}

function render() {
  const employee = portal.employee;
  const summary = portal.summary || {};
  $('welcomeTitle').textContent = `Welcome, ${employee.fullName.split(' ')[0]}`;
  $('branchName').textContent = portal.settings?.branchName || 'Main Branch';
  renderAvatar($('avatar'), employee);
  renderAvatar($('profilePhotoPreview'), employee);
  $('accountPhoneInput').value = portal.accountPhone || '';
  $('phoneLinkStatus').textContent = portal.accountPhone || 'Not bound';
  $('bindPhoneBtn').textContent = portal.accountPhone ? 'Update' : 'Bind';
  ['google', 'facebook'].forEach((provider) => {
    const connected = Boolean(portal.socialConnections?.[provider]);
    const status = $(`${provider}LinkStatus`); const button = document.querySelector(`[data-link-provider="${provider}"]`);
    if (status) status.textContent = connected ? 'Connected' : 'Not connected';
    if (button) { button.textContent = connected ? 'Reconnect' : 'Connect'; button.classList.toggle('connected', connected); }
  });
  $('summaryCards').innerHTML = [['Present days', summary.present || 0], ['Late time', mins(summary.lateMinutes)], ['Undertime', mins(summary.undertimeMinutes)], ['Overtime', mins(summary.overtimeMinutes)]].map(([label, value]) => `<article class="summary-card"><span>${label}</span><strong>${value}</strong></article>`).join('');
  $('profileDetails').innerHTML = [['Employee ID', employee.employeeCode], ['Full name', employee.fullName], ['Shift', `${employee.shiftStart} – ${employee.shiftEnd}`], ['Status', employee.active ? 'Active' : 'Inactive']].map(([label, value]) => `<div class="detail"><span>${label}</span><strong>${esc(value)}</strong></div>`).join('');
  $('recentAttendance').innerHTML = portal.timeCards.slice(0, 6).map((row) => `<div class="activity"><span>${esc(row.dateLabel || row.dateKey)}</span><strong>${esc(row.status)} · ${esc(row.timeIn || '—')}</strong></div>`).join('') || empty('No attendance records yet.');
  $('timeCardRows').innerHTML = portal.timeCards.map((row) => `<tr><td>${esc(row.dateLabel || row.dateKey)}</td><td>${esc(row.schedule || '—')}</td><td>${esc(row.timeIn || '—')}</td><td>${esc(row.timeOut || '—')}</td><td><span class="status ${esc(String(row.status || '').toLowerCase())}">${esc(row.status || 'No record')}</span></td><td>${esc(row.paidHours ?? 0)}</td></tr>`).join('') || '<tr><td colspan="6" class="empty-cell">No time-card records in this date range.</td></tr>';
  $('scheduleGrid').innerHTML = Object.entries(employee.weeklySchedule || {}).map(([day, value]) => `<article class="schedule-day ${value.dayOff ? 'day-off' : ''}"><strong>${esc(day[0].toUpperCase() + day.slice(1))}</strong><span>${value.dayOff ? 'Day off' : `${esc(value.timeIn)} – ${esc(value.timeOut)}`}</span></article>`).join('');
  const requests = [...portal.leaveRequests.map((row) => ({ ...row, label: `Leave · ${row.fromDate} to ${row.toDate}` })), ...portal.correctionRequests.map((row) => ({ ...row, label: `Correction · ${row.dateKey}` }))].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  $('requestHistory').innerHTML = requests.map((row) => `<div class="request"><span>${esc(row.label)}</span><strong class="status ${esc(String(row.status).toLowerCase())}">${esc(row.status)}</strong></div>`).join('') || empty('No submitted requests yet.');
  $('notificationRows').innerHTML = portal.notifications.map((item) => `<div class="notification"><span><strong>${esc(item.title)}</strong><br>${esc(item.message)}</span><small>${new Date(item.createdAt).toLocaleString()}</small></div>`).join('') || empty('No notifications yet.');
}

async function load() {
  const query = new URLSearchParams();
  if ($('fromDate').value) query.set('from', $('fromDate').value);
  if ($('toDate').value) query.set('to', $('toDate').value);
  if ($('fromDate').value && $('toDate').value && $('fromDate').value > $('toDate').value) throw new Error('The start date cannot be after the end date.');
  portal = await api(`/api/employee/home?${query}`);
  render();
}

function resizeProfilePhoto(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return reject(new Error('Select a JPG, PNG, or WebP photo.'));
    if (file.size > 10 * 1024 * 1024) return reject(new Error('Select an image smaller than 10 MB.'));
    const image = new Image(); const objectUrl = URL.createObjectURL(file);
    image.onload = () => { const size = 512; const canvas = document.createElement('canvas'); const context = canvas.getContext('2d'); const sourceSize = Math.min(image.naturalWidth, image.naturalHeight); canvas.width = size; canvas.height = size; context.drawImage(image, (image.naturalWidth - sourceSize) / 2, (image.naturalHeight - sourceSize) / 2, sourceSize, sourceSize, 0, 0, size, size); URL.revokeObjectURL(objectUrl); resolve(canvas.toDataURL('image/jpeg', .82)); };
    image.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('Could not read the selected photo.')); };
    image.src = objectUrl;
  });
}

document.querySelectorAll('nav [data-target]').forEach((button) => button.addEventListener('click', () => {
  document.querySelectorAll('nav [data-target],.portal-page').forEach((item) => item.classList.remove('active'));
  button.classList.add('active'); $(button.dataset.target).classList.add('active');
  history.replaceState({}, '', `#${button.dataset.target}`);
}));

$('profilePhotoInput').addEventListener('change', (event) => {
  const file = event.target.files[0];
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  $('profilePhotoFileName').textContent = file ? file.name : 'No photo selected';
  $('uploadProfilePhotoBtn').disabled = !file;
  if (file) { previewUrl = URL.createObjectURL(file); $('profilePhotoPreview').innerHTML = `<img src="${previewUrl}" alt="Selected profile picture">`; }
});

$('phoneBindForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = $('bindPhoneBtn'); setBusy(button, true, 'Saving...');
  try {
    const result = await api('/api/auth/phone', { method: 'PATCH', body: JSON.stringify({ phone: $('accountPhoneInput').value.trim() }) });
    portal.accountPhone = result.phone; portal.socialConnections.phone = true; render();
    message('Phone number bound to your account.', 'success');
  } catch (error) { message(error.message, 'error'); } finally { setBusy(button, false); }
});

$('uploadProfilePhotoBtn').addEventListener('click', async () => {
  const file = $('profilePhotoInput').files[0]; const button = $('uploadProfilePhotoBtn'); if (!file) return;
  setBusy(button, true, 'Uploading...');
  try { const dataUrl = await resizeProfilePhoto(file); await api('/api/employee/profile-photo', { method: 'POST', body: JSON.stringify({ dataUrl }) }); $('profilePhotoInput').value = ''; $('profilePhotoFileName').textContent = 'No photo selected'; await load(); message('Profile picture updated.', 'success'); }
  catch (error) { message(error.message, 'error'); }
  finally { setBusy(button, false); }
});

$('filterBtn').addEventListener('click', async () => { const button = $('filterBtn'); setBusy(button, true, 'Loading...'); try { await load(); message('Time card updated.', 'success'); } catch (error) { message(error.message, 'error'); } finally { setBusy(button, false); } });

$('leaveForm').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = event.submitter; setBusy(button, true, 'Submitting...');
  try { if ($('leaveFrom').value > $('leaveTo').value) throw new Error('Leave start date cannot be after the end date.'); await api('/api/employee/leave-requests', { method: 'POST', body: JSON.stringify({ leaveType: $('leaveType').value, fromDate: $('leaveFrom').value, toDate: $('leaveTo').value, reason: $('leaveReason').value.trim() }) }); event.target.reset(); await load(); message('Leave request submitted.', 'success'); }
  catch (error) { message(error.message, 'error'); } finally { setBusy(button, false); }
});

$('correctionForm').addEventListener('submit', async (event) => {
  event.preventDefault(); const button = event.submitter; setBusy(button, true, 'Submitting...');
  try { if (!$('correctionIn').value && !$('correctionOut').value) throw new Error('Enter a requested time in, time out, or both.'); await api('/api/employee/correction-requests', { method: 'POST', body: JSON.stringify({ dateKey: $('correctionDate').value, requestedTimeIn: $('correctionIn').value, requestedTimeOut: $('correctionOut').value, reason: $('correctionReason').value.trim() }) }); event.target.reset(); await load(); message('Correction request submitted.', 'success'); }
  catch (error) { message(error.message, 'error'); } finally { setBusy(button, false); }
});

$('logoutBtn').addEventListener('click', async () => { setBusy($('logoutBtn'), true, 'Signing out...'); try { await api('/api/auth/logout', { method: 'POST' }); } finally { location.replace('/'); } });

const initialTarget = location.hash.slice(1);
if (initialTarget && document.querySelector(`[data-target="${CSS.escape(initialTarget)}"]`)) document.querySelector(`[data-target="${CSS.escape(initialTarget)}"]`).click();
load().catch((error) => message(error.message, 'error'));
