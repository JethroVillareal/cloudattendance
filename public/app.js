const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const defaultSettings = {
  branchName: 'Main Branch',
  defaultShiftStart: '09:00',
  defaultShiftEnd: '18:00',
  graceMinutes: 10,
  duplicateScanDelayMinutes: 3,
  requiredPaidHours: 8,
  lunchBreakStart: '12:00',
  lunchBreakEnd: '13:00',
  afternoonBreakStart: '15:00',
  afternoonBreakEnd: '15:15',
  earlyOutProtectionEnabled: true,
  emergencyTimeOutEnabled: true,
  pcBreakAlarmEnabled: true,
  esp32DisplayDurationMs: 3000,
  apiKey: ''
};

const ALARM_AUDIO_URL = '/alarm.mp3';

const state = {
  settings: { ...defaultSettings },
  summary: {},
  readers: [],
  pending: [],
  employees: [],
  attendance: [],
  timeCards: [],
  modalFingerprintId: null,
  editingEmployeeId: null,
  activeView: 'dashboardView',
  activeTimeCardTab: 'recordsTab',
  selectedTimeCardIndex: 0,
  reportEmployeeId: '',
  timeCardModalEmployeeId: '',
  timeCardModalRows: [],
  audioReady: false,
  alarmKeys: new Set(),
  activeAlarmAudio: null,
  alarmStopTimer: null
};

const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseDateKey(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function dateKeyFromDate(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatLongDate(dateKey) {
  const date = parseDateKey(dateKey);
  if (!date) return dateKey || '-';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(date);
}

function formatGeneratedAt() {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date());
}

function slugifyFileName(value) {
  return String(value || 'time-card')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'time-card';
}

function defaultCutoffForDate(dateKey = todayKey()) {
  const date = parseDateKey(dateKey) || new Date();
  return date.getDate() > 15 ? 'second' : 'first';
}

function applyCutoffToDates() {
  const cutoff = $('timeCardCutoff') ? $('timeCardCutoff').value : 'custom';
  if (cutoff === 'custom') return;
  const baseDate = parseDateKey($('timeCardFrom').value) || parseDateKey(todayKey()) || new Date();
  const year = baseDate.getFullYear();
  const month = baseDate.getMonth();
  const lastDay = new Date(year, month + 1, 0).getDate();
  const fromDay = cutoff === 'second' ? 16 : 1;
  const toDay = cutoff === 'second' ? lastDay : 15;
  $('timeCardFrom').value = dateKeyFromDate(new Date(year, month, fromDay));
  $('timeCardTo').value = dateKeyFromDate(new Date(year, month, toDay));
}

function formatDateTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString();
}

function defaultWeeklySchedule() {
  const schedule = {};
  DAY_KEYS.forEach((day) => {
    schedule[day] = {
      dayOff: day === 'sunday',
      timeIn: state.settings.defaultShiftStart || '09:00',
      timeOut: state.settings.defaultShiftEnd || '18:00'
    };
  });
  return schedule;
}

let authenticationPromise = null;
let loginMode = 'account';

function setLoginMode(mode) {
  loginMode = mode === 'key' ? 'key' : 'account';
  document.querySelectorAll('[data-login-mode]').forEach((button) => {
    const active = button.dataset.loginMode === loginMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  $('accountLoginFields').classList.toggle('hidden', loginMode !== 'account');
  $('keyLoginFields').classList.toggle('hidden', loginMode !== 'key');
  $('loginMessage').textContent = '';
  setTimeout(() => $(loginMode === 'key' ? 'loginApiKey' : 'loginUsername').focus(), 0);
}

function setSecretVisibility(inputId, buttonId) {
  const input = $(inputId);
  const button = $(buttonId);
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  button.textContent = show ? 'Hide' : 'Show';
  button.setAttribute('aria-label', `${show ? 'Hide' : 'Show'} ${inputId === 'loginApiKey' ? 'server key' : 'password'}`);
}

function openLoginScreen() {
  $('loginScreen').classList.remove('hidden');
  document.body.classList.add('login-open');
  $('loginMessage').textContent = '';
  setTimeout(() => $(loginMode === 'key' ? 'loginApiKey' : 'loginUsername').focus(), 50);
}

function closeLoginScreen() {
  $('loginScreen').classList.add('hidden');
  document.body.classList.remove('login-open');
  $('loginPassword').value = '';
  $('loginApiKey').value = '';
}

async function authenticateBrowser() {
  if (!authenticationPromise) {
    authenticationPromise = new Promise((resolve) => {
      openLoginScreen();
      $('loginForm').onsubmit = async (event) => {
        event.preventDefault();
        const username = $('loginUsername').value.trim();
        const password = $('loginPassword').value;
        const apiKey = $('loginApiKey').value.trim();
        if ((loginMode === 'account' && (!username || !password)) || (loginMode === 'key' && !apiKey)) {
          $('loginMessage').textContent = loginMode === 'key' ? 'Enter your server access key.' : 'Enter both your username and password.';
          return;
        }
        const submit = $('loginSubmit');
        submit.disabled = true;
        submit.classList.add('loading');
        $('loginMessage').textContent = '';
        try {
          const login = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(loginMode === 'key' ? { apiKey } : { username, password })
          });
          const result = await login.json().catch(() => ({}));
          if (!login.ok) throw new Error(result.message || 'Invalid login credentials.');
          closeLoginScreen();
          resolve(result);
        } catch (error) {
          $('loginMessage').textContent = error.message || 'Unable to sign in. Please try again.';
        } finally {
          submit.disabled = false;
          submit.classList.remove('loading');
        }
      };
    }).finally(() => { authenticationPromise = null; });
  }
  return authenticationPromise;
}

async function api(path, options = {}) {
  let response = await fetch(path, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  });
  if (response.status === 401 && path !== '/api/auth/login') {
    await authenticateBrowser();
    response = await fetch(path, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options
    });
  }
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data.message || data.code || `Request failed: ${response.status}`);
  }
  return data;
}

function setServerStatus(ok, text) {
  $('serverStatusDot').className = ok ? 'dot ok' : 'dot bad';
  $('serverStatusText').textContent = text;
}

async function checkServer() {
  try {
    const data = await api('/health');
    setServerStatus(true, `Online - ${data.timezone}`);
  } catch {
    setServerStatus(false, 'Server offline');
  }
}

function statCard(label, value, tone = '') {
  return `
    <div class="stat-card ${tone}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

const viewMeta = {
  dashboardView: ['Dashboard', 'Attendance verification overview'],
  timeCardView: ['Time Card', 'View and verify employee daily attendance records'],
  enrollmentView: ['Enrollment', 'Register new employee fingerprints or manage existing registrations'],
  employeesView: ['Employees', 'Manage employee profiles, schedules, and fingerprints'],
  devicesView: ['Devices', 'Manage attendance devices and their connectivity'],
  settingsView: ['Settings', 'Configure attendance rules and system preferences'],
  logsView: ['Logs', 'View system activities and attendance events']
};

function setActiveView(viewId) {
  state.activeView = viewId;
  document.querySelectorAll('.view').forEach((view) => {
    view.classList.toggle('active', view.id === viewId);
  });
  document.querySelectorAll('.nav-item').forEach((button) => {
    button.classList.toggle('active', button.dataset.view === viewId);
  });
  const [title, subtitle] = viewMeta[viewId] || viewMeta.dashboardView;
  $('viewTitle').textContent = title;
  $('viewSubtitle').textContent = subtitle;
}

function setTimeCardTab(tabId) {
  state.activeTimeCardTab = tabId;
  document.querySelectorAll('.timecard-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.id === tabId);
  });
  document.querySelectorAll('.subnav-item').forEach((button) => {
    button.classList.toggle('active', button.dataset.timecardTab === tabId);
  });
}

function renderSummary() {
  const s = state.summary || {};
  $('branchLabel').textContent = state.settings.branchName || 'Main Branch';
  $('summaryCards').innerHTML = [
    statCard('Present Today', s.presentToday ?? 0, 'good'),
    statCard('Late Today', s.lateToday ?? 0, 'warn'),
    statCard('Absent Today', s.absentToday ?? 0, 'bad'),
    statCard('Excused Today', s.excusedToday ?? 0, 'good'),
    statCard('Pending Offline Sync', s.pendingOfflineSync ?? 0, 'warn'),
    statCard('Devices Online', s.devicesOnline ?? 0, 'good'),
    statCard('Devices Offline', s.devicesOffline ?? 0, 'bad'),
    statCard('Pending Registrations', s.pendingFingerprintRegistrations ?? 0, 'warn'),
    statCard('Emergency Logs', s.emergencyLogs ?? 0, 'warn')
  ].join('');
}

function denseRow(label, value, tone = '') {
  return `
    <div class="dense-row">
      <span>${escapeHtml(label)}</span>
      <strong class="${tone}">${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderDashboardLists() {
  const s = state.summary || {};
  $('todaySummaryList').innerHTML = [
    denseRow('Present', s.presentToday ?? 0, 'status-good'),
    denseRow('Late', s.lateToday ?? 0, 'status-warn'),
    denseRow('Absent', s.absentToday ?? 0, 'status-bad'),
    denseRow('Excused', s.excusedToday ?? 0, 'status-good'),
    denseRow('Pending Offline Sync', s.pendingOfflineSync ?? 0, 'status-warn')
  ].join('');

  const pendingPreview = state.pending.slice(0, 4);
  $('dashboardPendingList').innerHTML = pendingPreview.length
    ? pendingPreview.map((item) => denseRow(`Fingerprint ID ${item.fingerprintId}`, item.deviceId || item.lastDeviceId || 'Unknown')).join('')
    : '<div class="empty small">No pending registration.</div>';

  const rows = $('dashboardActivityRows');
  const recent = state.attendance.slice(0, 8);
  rows.innerHTML = recent.length ? recent.map((record) => `
    <tr>
      <td>${escapeHtml(record.displayTime || formatDateTime(record.scannedAt))}</td>
      <td>${escapeHtml(record.fullName || 'Not registered')}</td>
      <td>${escapeHtml(record.attendanceType || '-')}</td>
      <td class="${attendanceStatusClass(record)}">${escapeHtml(record.statusText || record.punctuality || record.code || '-')}</td>
      <td>${escapeHtml(record.message || '')}</td>
    </tr>
  `).join('') : '<tr><td colspan="5" class="muted">No recent activity.</td></tr>';
}

function buildScheduleForm() {
  $('scheduleRows').innerHTML = DAY_KEYS.map((day, index) => `
    <div class="schedule-row" data-day="${day}">
      <strong>${DAY_LABELS[index]}</strong>
      <label class="check-label"><input type="checkbox" class="day-off-input"> Day Off</label>
      <input type="time" class="time-in-input" value="${escapeHtml(state.settings.defaultShiftStart)}">
      <input type="time" class="time-out-input" value="${escapeHtml(state.settings.defaultShiftEnd)}">
    </div>
  `).join('');

  document.querySelectorAll('.day-off-input').forEach((input) => {
    input.addEventListener('change', () => updateScheduleRowState(input.closest('.schedule-row')));
  });
}

function updateScheduleRowState(row) {
  const off = row.querySelector('.day-off-input').checked;
  row.classList.toggle('is-off', off);
  row.querySelector('.time-in-input').disabled = off;
  row.querySelector('.time-out-input').disabled = off;
}

function setScheduleForm(schedule = defaultWeeklySchedule()) {
  DAY_KEYS.forEach((day) => {
    const row = document.querySelector(`.schedule-row[data-day="${day}"]`);
    if (!row) return;
    const data = schedule[day] || defaultWeeklySchedule()[day];
    row.querySelector('.day-off-input').checked = Boolean(data.dayOff);
    row.querySelector('.time-in-input').value = data.timeIn || state.settings.defaultShiftStart || '09:00';
    row.querySelector('.time-out-input').value = data.timeOut || state.settings.defaultShiftEnd || '18:00';
    updateScheduleRowState(row);
  });
}

function getScheduleFromForm() {
  const schedule = {};
  DAY_KEYS.forEach((day) => {
    const row = document.querySelector(`.schedule-row[data-day="${day}"]`);
    schedule[day] = {
      dayOff: row.querySelector('.day-off-input').checked,
      timeIn: row.querySelector('.time-in-input').value || state.settings.defaultShiftStart || '09:00',
      timeOut: row.querySelector('.time-out-input').value || state.settings.defaultShiftEnd || '18:00'
    };
  });
  return schedule;
}

function setSettingsForm() {
  const s = state.settings;
  $('branchNameInput').value = s.branchName || '';
  $('defaultShiftStartInput').value = s.defaultShiftStart || '09:00';
  $('defaultShiftEndInput').value = s.defaultShiftEnd || '18:00';
  $('settingsGraceInput').value = s.graceMinutes ?? 10;
  $('duplicateDelayInput').value = s.duplicateScanDelayMinutes ?? 3;
  $('requiredPaidHoursInput').value = s.requiredPaidHours ?? 8;
  $('lunchStartInput').value = s.lunchBreakStart || '12:00';
  $('lunchEndInput').value = s.lunchBreakEnd || '13:00';
  $('breakStartInput').value = s.afternoonBreakStart || '15:00';
  $('breakEndInput').value = s.afternoonBreakEnd || '15:15';
  $('displayDurationInput').value = s.esp32DisplayDurationMs ?? 3000;
  $('apiKeyInput').value = s.apiKey || '';
  $('earlyOutProtectionInput').checked = s.earlyOutProtectionEnabled !== false;
  $('emergencyTimeOutInput').checked = s.emergencyTimeOutEnabled !== false;
  $('pcBreakAlarmInput').checked = s.pcBreakAlarmEnabled !== false;
}

function getSettingsFromForm() {
  return {
    branchName: $('branchNameInput').value.trim(),
    defaultShiftStart: $('defaultShiftStartInput').value,
    defaultShiftEnd: $('defaultShiftEndInput').value,
    graceMinutes: Number($('settingsGraceInput').value || 0),
    duplicateScanDelayMinutes: Number($('duplicateDelayInput').value || 3),
    requiredPaidHours: Number($('requiredPaidHoursInput').value || 8),
    lunchBreakStart: $('lunchStartInput').value,
    lunchBreakEnd: $('lunchEndInput').value,
    afternoonBreakStart: $('breakStartInput').value,
    afternoonBreakEnd: $('breakEndInput').value,
    earlyOutProtectionEnabled: $('earlyOutProtectionInput').checked,
    emergencyTimeOutEnabled: $('emergencyTimeOutInput').checked,
    pcBreakAlarmEnabled: $('pcBreakAlarmInput').checked,
    esp32DisplayDurationMs: Number($('displayDurationInput').value || 3000),
    apiKey: $('apiKeyInput').value.trim()
  };
}

function renderReaders() {
  const select = $('enrollDeviceSelect');
  select.innerHTML = '<option value="ALL">All devices</option>' + state.readers.map((reader) => `
    <option value="${escapeHtml(reader.deviceId)}">${escapeHtml(reader.deviceId)}</option>
  `).join('');

  const box = $('readerList');
  if (!state.readers.length) {
    box.innerHTML = '<div class="empty">No device heartbeat yet.</div>';
    return;
  }

  box.innerHTML = state.readers.map((reader) => `
    <div class="device-card">
      <div class="device-head">
        <strong>${escapeHtml(reader.deviceId)}</strong>
        <span class="badge ${reader.online ? 'good' : 'bad'}">${escapeHtml(reader.status)}</span>
      </div>
      <div class="metric-row"><span>Last Seen</span><b>${escapeHtml(formatDateTime(reader.lastSeenAt))}</b></div>
      <div class="metric-row"><span>WiFi RSSI</span><b>${escapeHtml(reader.wifiRssi ?? '-')}</b></div>
      <div class="metric-row"><span>Device IP</span><b>${escapeHtml(reader.deviceIp || '-')}</b></div>
      <div class="metric-row"><span>Firmware</span><b>${escapeHtml(reader.firmwareVersion || '-')}</b></div>
      <div class="metric-row"><span>Pending Logs</span><b>${escapeHtml(reader.pendingOfflineLogs || 0)}</b></div>
    </div>
  `).join('');
}

function openRegisterModal(fingerprintId) {
  state.modalFingerprintId = fingerprintId;
  state.editingEmployeeId = null;
  $('modalTitle').textContent = 'Register Employee';
  $('employeeIdInput').value = '';
  $('fingerprintIdInput').value = fingerprintId;
  $('fingerprintDisplayInput').value = `ID ${fingerprintId}`;
  $('fingerprintLabelInput').value = 'Primary Finger';
  $('modalSubtitle').textContent = `Fingerprint ID ${fingerprintId}`;
  $('fullNameInput').value = '';
  $('graceMinutesInput').value = String(state.settings.graceMinutes ?? 10);
  setScheduleForm(defaultWeeklySchedule());
  $('formMessage').textContent = '';
  $('saveEmployeeBtn').textContent = 'Save Employee';
  $('modalBackdrop').classList.remove('hidden');
  setTimeout(() => $('fullNameInput').focus(), 50);
}

function openCreateEmployeeModal() {
  state.modalFingerprintId = null;
  state.editingEmployeeId = null;
  $('modalTitle').textContent = 'Create Employee';
  $('employeeIdInput').value = '';
  $('fingerprintIdInput').value = '';
  $('fingerprintDisplayInput').value = 'No fingerprint linked';
  $('fingerprintLabelInput').value = 'Primary Finger';
  $('modalSubtitle').textContent = 'Employee profile';
  $('fullNameInput').value = '';
  $('graceMinutesInput').value = String(state.settings.graceMinutes ?? 10);
  setScheduleForm(defaultWeeklySchedule());
  $('formMessage').textContent = '';
  $('saveEmployeeBtn').textContent = 'Create Employee';
  $('modalBackdrop').classList.remove('hidden');
  setTimeout(() => $('fullNameInput').focus(), 50);
}

function openEditModal(employeeId) {
  const employee = state.employees.find((item) => item.id === employeeId);
  if (!employee) return;
  const primaryFingerprint = employee.fingerprintId || (employee.fingerprints && employee.fingerprints[0] && employee.fingerprints[0].fingerprintId) || '';
  state.editingEmployeeId = employee.id;
  state.modalFingerprintId = primaryFingerprint;
  $('modalTitle').textContent = 'Edit Employee';
  $('employeeIdInput').value = employee.id;
  $('fingerprintIdInput').value = primaryFingerprint;
  $('fingerprintDisplayInput').value = primaryFingerprint ? `ID ${primaryFingerprint}` : 'No fingerprint linked';
  $('fingerprintLabelInput').value = 'Primary Finger';
  $('modalSubtitle').textContent = employee.fullName;
  $('fullNameInput').value = employee.fullName;
  $('graceMinutesInput').value = String(employee.graceMinutes ?? state.settings.graceMinutes ?? 10);
  setScheduleForm(employee.weeklySchedule || defaultWeeklySchedule());
  $('formMessage').textContent = '';
  $('saveEmployeeBtn').textContent = 'Update Employee';
  $('modalBackdrop').classList.remove('hidden');
}

function closeModal() {
  state.modalFingerprintId = null;
  state.editingEmployeeId = null;
  $('modalBackdrop').classList.add('hidden');
}

function renderPending() {
  const box = $('pendingList');
  if (!state.pending.length) {
    box.className = 'empty';
    box.innerHTML = 'No pending fingerprint registration.';
    return;
  }

  const employeeOptions = state.employees.map((employee) => `
    <option value="${escapeHtml(employee.id)}">${escapeHtml(employee.fullName)}</option>
  `).join('');

  box.className = 'list';
  box.innerHTML = state.pending.map((item) => `
    <div class="card pending-card">
      <div>
        <strong>Fingerprint ID ${escapeHtml(item.fingerprintId)}</strong>
        <div class="card-row"><span>Device</span><span>${escapeHtml(item.deviceId || item.lastDeviceId || 'Unknown')}</span></div>
        <div class="card-row"><span>Created</span><span>${escapeHtml(formatDateTime(item.createdAt))}</span></div>
      </div>
      <div class="pending-actions">
        <button onclick="openRegisterModal(${Number(item.fingerprintId)})">New Employee</button>
        <select id="linkSelect_${escapeHtml(item.id)}">
          <option value="">Link to employee</option>
          ${employeeOptions}
        </select>
        <button class="secondary" onclick="linkPendingFingerprint('${escapeHtml(item.id)}', ${Number(item.fingerprintId)})">Link</button>
        <button class="danger" onclick="deletePendingFingerprint('${escapeHtml(item.id)}', ${Number(item.fingerprintId)})">Delete from Device</button>
      </div>
    </div>
  `).join('');
}

async function linkPendingFingerprint(requestId, fingerprintId) {
  const select = $(`linkSelect_${requestId}`);
  const employeeId = select ? select.value : '';
  if (!employeeId) return;
  $('enrollmentMessage').textContent = 'Linking fingerprint...';
  try {
    await api(`/api/employees/${encodeURIComponent(employeeId)}/fingerprints`, {
      method: 'POST',
      body: JSON.stringify({ fingerprintId, label: 'Additional Finger' })
    });
    await loadAll();
    $('enrollmentMessage').textContent = `Fingerprint ID ${fingerprintId} linked to employee.`;
  } catch (error) {
    $('enrollmentMessage').textContent = error.message;
  }
}

async function deletePendingFingerprint(requestId, fingerprintId) {
  if (!confirm(`Delete pending fingerprint ID ${fingerprintId} from server and R503 device?`)) return;
  $('enrollmentMessage').textContent = 'Queueing device delete command...';
  try {
    const data = await api(`/api/fingerprints/pending/${encodeURIComponent(requestId)}`, {
      method: 'DELETE'
    });
    await loadAll();
    $('enrollmentMessage').textContent = data.message || `Fingerprint ID ${fingerprintId} delete command queued.`;
  } catch (error) {
    $('enrollmentMessage').textContent = error.message;
  }
}

function summarizeSchedule(employee) {
  const schedule = employee.weeklySchedule || defaultWeeklySchedule();
  const working = DAY_KEYS.filter((day) => !schedule[day]?.dayOff);
  if (!working.length) return 'No working days';
  const monday = schedule.monday || schedule[working[0]];
  return `${working.length} days, ${monday.timeIn} - ${monday.timeOut}`;
}

function renderEmployees() {
  const box = $('employeeList');
  const timeCardSelect = $('timeCardEmployee');
  const manualSelect = $('manualEmployee');
  const emergencySelect = $('emergencyEmployee');
  const previousTimeCardEmployee = timeCardSelect.value;
  const previousManualEmployee = manualSelect.value;
  const previousEmergencyEmployee = emergencySelect.value;
  const options = state.employees.map((employee) => `
    <option value="${escapeHtml(employee.id)}">${escapeHtml(employee.fullName)}</option>
  `).join('');

  timeCardSelect.innerHTML = '<option value="">All employees</option>' + options;
  manualSelect.innerHTML = options || '<option value="">No employees</option>';
  emergencySelect.innerHTML = options || '<option value="">No employees</option>';
  if (state.employees.some((employee) => employee.id === previousTimeCardEmployee)) timeCardSelect.value = previousTimeCardEmployee;
  if (state.employees.some((employee) => employee.id === previousManualEmployee)) manualSelect.value = previousManualEmployee;
  if (state.employees.some((employee) => employee.id === previousEmergencyEmployee)) emergencySelect.value = previousEmergencyEmployee;
  if (state.reportEmployeeId && !state.employees.some((employee) => employee.id === state.reportEmployeeId)) {
    state.reportEmployeeId = '';
  }

  if (!state.employees.length) {
    box.innerHTML = '<div class="empty">No employees yet.</div>';
    return;
  }

  box.innerHTML = state.employees.map((employee) => {
    const fingerprints = employee.fingerprints || (employee.fingerprintId ? [{ fingerprintId: employee.fingerprintId, label: 'Primary Finger' }] : []);
    return `
      <div class="card employee-card">
        <div>
          <strong>${escapeHtml(employee.fullName)}</strong>
          <div class="card-row"><span>Grace</span><span>${escapeHtml(employee.graceMinutes)} min</span></div>
          <div class="card-row"><span>Schedule</span><span>${escapeHtml(summarizeSchedule(employee))}</span></div>
          <div class="fingerprint-list">
            ${fingerprints.length ? fingerprints.map((fp) => `
              <span class="fingerprint-chip">
                ID ${escapeHtml(fp.fingerprintId)} ${escapeHtml(fp.label || '')}
                <button class="chip-btn" onclick="deleteFingerprint('${escapeHtml(employee.id)}', ${Number(fp.fingerprintId)})">Delete</button>
              </span>
            `).join('') : '<span class="fingerprint-chip muted-chip">No fingerprint linked</span>'}
          </div>
        </div>
        <button class="secondary" onclick="openEditModal('${escapeHtml(employee.id)}')">Edit</button>
      </div>
    `;
  }).join('');
}

async function deleteFingerprint(employeeId, fingerprintId) {
  const confirmed = confirm(`Delete fingerprint ID ${fingerprintId} from server and queue delete on R503 device?`);
  if (!confirmed) return;
  $('employeeMessage').textContent = 'Queueing fingerprint delete command...';
  try {
    const data = await api(`/api/employees/${encodeURIComponent(employeeId)}/fingerprints/${encodeURIComponent(fingerprintId)}`, {
      method: 'DELETE'
    });
    await loadAll();
    $('employeeMessage').textContent = data.message || `Fingerprint ID ${fingerprintId} deleted.`;
  } catch (error) {
    $('employeeMessage').textContent = error.message;
  }
}

function attendanceStatusClass(record) {
  if (record.code === 'FINGERPRINT_NOT_REGISTERED' || record.accepted === false) return 'status-bad';
  if (['LATE', 'EARLY_OUT', 'DAY_OFF', 'EMERGENCY'].includes(record.punctuality)) return 'status-warn';
  if (['ON_TIME', 'COMPLETED'].includes(record.punctuality)) return 'status-good';
  return '';
}

function renderAttendance() {
  const rows = $('attendanceRows');
  if (!state.attendance.length) {
    rows.innerHTML = '<tr><td colspan="6" class="muted">No attendance logs yet.</td></tr>';
    return;
  }

  rows.innerHTML = state.attendance.map((record) => {
    const name = record.fullName || 'Not registered';
    const time = record.displayDateTime || formatDateTime(record.scannedAt);
    const status = record.statusText || record.punctuality || record.code || '';
    const type = record.attendanceType || '-';
    return `
      <tr>
        <td>${escapeHtml(time)}</td>
        <td>${escapeHtml(name)}</td>
        <td>${escapeHtml(type)}</td>
        <td class="${attendanceStatusClass(record)}">${escapeHtml(status)}</td>
        <td>ID ${escapeHtml(record.fingerprintId)}<br><span class="muted">Conf: ${escapeHtml(record.fingerprintConfidence ?? '-')}</span></td>
        <td>${escapeHtml(record.message || '')}</td>
      </tr>
    `;
  }).join('');
}

function timeCardClass(record) {
  if (record.statusClass === 'good') return 'status-good';
  if (record.statusClass === 'warn') return 'status-warn';
  if (record.statusClass === 'bad') return 'status-bad';
  return 'muted';
}

function metricCard(label, value, tone = '') {
  return `
    <div class="metric-card ${tone}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function renderTimeCardMetrics() {
  const rows = state.timeCards || [];
  const paid = rows.reduce((sum, record) => sum + Number(record.paidHours || 0), 0);
  const late = rows.filter((record) => Number(record.lateMinutes || 0) > 0 || String(record.status || '').includes('LATE')).length;
  const absent = rows.filter((record) => record.status === 'ABSENT').length;
  const incomplete = rows.filter((record) => String(record.status || '').includes('INCOMPLETE')).length;
  $('timeCardMetrics').innerHTML = [
    metricCard('Records', rows.length),
    metricCard('Paid Hours', paid.toFixed(2), 'good'),
    metricCard('Late Records', late, 'warn'),
    metricCard('Absent', absent, 'bad'),
    metricCard('Incomplete', incomplete, incomplete ? 'warn' : '')
  ].join('');
}

function minutesText(totalMinutes) {
  const minutes = Math.max(0, Math.round(Number(totalMinutes || 0)));
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours && mins) return `${hours}h ${mins}m`;
  if (hours) return `${hours}h`;
  return `${mins}m`;
}

function decimalHoursText(hours) {
  return minutesText(Number(hours || 0) * 60);
}

function employeeAccountId(employee) {
  const explicit = employee.accountId || employee.username || employee.employeeCode;
  if (explicit) return explicit;
  const firstName = String(employee.fullName || '').trim().split(/\s+/)[0] || 'employee';
  return firstName.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function reportStatusLabel(record) {
  const status = String(record.status || '').toUpperCase();
  if (status === 'PRESENT') return 'ON TIME';
  if (status === 'NO SCHEDULE') return 'DAY OFF';
  return status || '-';
}

function reportStatusTone(record) {
  if (record.statusClass === 'good') return 'good';
  if (record.statusClass === 'warn') return 'warn';
  if (record.statusClass === 'bad') return 'bad';
  return 'neutral';
}

function reportRowNote(record, dailyTargetMinutes) {
  const status = String(record.status || '').toUpperCase();
  const paidMinutes = Math.round(Number(record.paidHours || 0) * 60);
  if (status === 'DAY OFF' || status === 'NO SCHEDULE') return 'Not scheduled';
  if (status === 'ABSENT') return record.reason || 'No scan recorded';
  if (status.includes('INCOMPLETE')) return 'Missing time out';
  if (Number(record.lateMinutes || 0) > 0) return `${record.lateMinutes} min late`;
  if (Number(record.earlyOutMinutes || 0) > 0) return `${record.earlyOutMinutes} min early out`;
  if (dailyTargetMinutes && paidMinutes >= dailyTargetMinutes) return `Met ${state.settings.requiredPaidHours || 8}h target`;
  if (dailyTargetMinutes && paidMinutes > 0) return `Short ${minutesText(dailyTargetMinutes - paidMinutes)}`;
  return record.reason || '-';
}

function summarizeEmployeeRows(rows) {
  const dailyTargetMinutes = Math.round(Number(state.settings.requiredPaidHours || 8) * 60);
  const scheduledRows = rows.filter((record) => record.scheduledTimeIn || record.scheduledTimeOut);
  const paidMinutes = rows.reduce((sum, record) => sum + Math.round(Number(record.paidHours || 0) * 60), 0);
  const grossMinutes = rows.reduce((sum, record) => sum + Math.round(Number(record.grossHours || 0) * 60), 0);
  const lateMinutes = rows.reduce((sum, record) => sum + Number(record.lateMinutes || 0), 0);
  const earlyOutMinutes = rows.reduce((sum, record) => sum + Number(record.earlyOutMinutes || 0), 0);
  const overtimeMinutes = rows.reduce((sum, record) => sum + Number(record.overtimeMinutes || 0), 0);
  const targetMinutes = scheduledRows.length * dailyTargetMinutes;
  const statusText = (record) => String(record.status || '').toUpperCase();

  return {
    recordCount: rows.length,
    scheduledDays: scheduledRows.length,
    present: rows.filter((record) => Number(record.paidHours || 0) > 0 && !statusText(record).includes('INCOMPLETE')).length,
    lateRecords: rows.filter((record) => Number(record.lateMinutes || 0) > 0 || statusText(record).includes('LATE')).length,
    absent: rows.filter((record) => statusText(record) === 'ABSENT').length,
    incomplete: rows.filter((record) => statusText(record).includes('INCOMPLETE')).length,
    dayOff: rows.filter((record) => ['DAY OFF', 'NO SCHEDULE'].includes(statusText(record))).length,
    emergency: rows.filter((record) => statusText(record).includes('EMERGENCY')).length,
    paidMinutes,
    grossMinutes,
    lateMinutes,
    earlyOutMinutes,
    overtimeMinutes,
    targetMinutes,
    targetGapMinutes: Math.max(0, targetMinutes - paidMinutes)
  };
}

function currentCutoffRangeText() {
  const from = $('timeCardFrom').value || todayKey();
  const to = $('timeCardTo').value || from;
  return `${formatLongDate(from)} - ${formatLongDate(to)}`;
}

function reportInfoBox(label, value, note = '') {
  return `
    <div class="report-info-box">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
      ${note ? `<small>${escapeHtml(note)}</small>` : ''}
    </div>
  `;
}

function reportSummaryBox(label, value, tone = '') {
  return `
    <div class="report-summary-box ${tone}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function employeeRowsForReport(employeeId) {
  return (state.timeCards || [])
    .filter((record) => record.employeeId === employeeId)
    .slice()
    .sort((a, b) => String(b.dateKey || '').localeCompare(String(a.dateKey || '')));
}

function renderEmployeeReportPicker(host) {
  if (!state.employees.length) {
    host.innerHTML = '<section class="panel timecard-picker"><div class="empty">No employees yet.</div></section>';
    return;
  }

  const cards = state.employees.map((employee) => {
    const rows = employeeRowsForReport(employee.id);
    const summary = summarizeEmployeeRows(rows);
    return `
      <button type="button" class="employee-report-card" onclick="openEmployeeTimeCard('${escapeHtml(employee.id)}')">
        <span class="employee-report-name">${escapeHtml(employee.fullName)}</span>
        <span class="muted">ID ${escapeHtml(employee.fingerprintId || '-')} - ${escapeHtml(currentCutoffRangeText())}</span>
        <span class="employee-report-stats">
          <b>${escapeHtml(minutesText(summary.paidMinutes))}</b>
          <small>Paid</small>
          <b>${escapeHtml(summary.lateRecords)}</b>
          <small>Late</small>
          <b>${escapeHtml(summary.absent)}</b>
          <small>Absent</small>
        </span>
      </button>
    `;
  }).join('');

  host.innerHTML = `
    <section class="panel timecard-picker">
      <div class="section-head">
        <h2>Employee Time Cards</h2>
        <span class="muted">${escapeHtml(currentCutoffRangeText())}</span>
      </div>
      <div class="employee-report-grid">${cards}</div>
    </section>
  `;
}

function employeeTimeCardReportHtml(selectedEmployeeId, rowsOverride = null) {
  const employee = state.employees.find((item) => item.id === selectedEmployeeId);
  if (!employee) {
    return '<section class="timecard-report-card"><div class="empty">Employee not found.</div></section>';
  }

  const rows = (rowsOverride || employeeRowsForReport(selectedEmployeeId))
    .slice()
    .sort((a, b) => String(b.dateKey || '').localeCompare(String(a.dateKey || '')));
  const summary = summarizeEmployeeRows(rows);
  const dailyTarget = Number(state.settings.requiredPaidHours || 8);
  const dailyTargetMinutes = Math.round(dailyTarget * 60);
  const rowHtml = rows.length ? rows.map((record) => `
    <tr>
      <td>${escapeHtml(formatLongDate(record.dateKey))}</td>
      <td>${escapeHtml(record.dayLabel || '-')}</td>
      <td>${escapeHtml(record.actualTimeIn || '-')}</td>
      <td>${escapeHtml(record.actualTimeOut || '-')}</td>
      <td>
        <strong>${escapeHtml(decimalHoursText(record.paidHours))}</strong>
        <span>${escapeHtml(reportRowNote(record, dailyTargetMinutes))}</span>
      </td>
      <td><span class="timecard-status-badge ${reportStatusTone(record)}">${escapeHtml(reportStatusLabel(record))}</span></td>
    </tr>
  `).join('') : '<tr><td colspan="6" class="muted">No records for this filter.</td></tr>';

  return `
    <section class="timecard-report-card">
      <div class="report-accent"></div>
      <div class="report-header">
        <div>
          <span class="report-company">GMS/GWD (${escapeHtml(state.settings.branchName || 'GMS')})</span>
          <h2>Employee Time Card Report</h2>
          <p>Semi-monthly cutoff attendance time card.</p>
        </div>
        <span class="report-mode">Time Card View</span>
      </div>

      <div class="report-info-grid">
        ${reportInfoBox('Employee', employee.fullName)}
        ${reportInfoBox('Account ID', employeeAccountId(employee))}
        ${reportInfoBox('Account Status', employee.active === false ? 'Inactive' : 'Active')}
        ${reportInfoBox('Cutoff Range', currentCutoffRangeText())}
        ${reportInfoBox('Generated', formatGeneratedAt())}
        ${reportInfoBox('Daily Target', `${dailyTarget}h / day`, `Scheduled days: ${summary.scheduledDays}`)}
      </div>

      <div class="report-summary-grid">
        ${reportSummaryBox('Paid Hours', minutesText(summary.paidMinutes), 'good')}
        ${reportSummaryBox('Gross Hours', minutesText(summary.grossMinutes))}
        ${reportSummaryBox('Late', `${summary.lateRecords} day${summary.lateRecords === 1 ? '' : 's'} / ${summary.lateMinutes} min`, summary.lateRecords ? 'warn' : '')}
        ${reportSummaryBox('Absent', summary.absent, summary.absent ? 'bad' : '')}
        ${reportSummaryBox('Incomplete', summary.incomplete, summary.incomplete ? 'warn' : '')}
        ${reportSummaryBox('Overtime', minutesText(summary.overtimeMinutes), summary.overtimeMinutes ? 'good' : '')}
        ${reportSummaryBox('Early Out', `${summary.earlyOutMinutes} min`, summary.earlyOutMinutes ? 'warn' : '')}
        ${reportSummaryBox('Target Gap', minutesText(summary.targetGapMinutes), summary.targetGapMinutes ? 'warn' : 'good')}
      </div>

      <div class="report-table-wrap">
        <table class="report-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Day</th>
              <th>Time In</th>
              <th>Time Out</th>
              <th>Work Hours</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>${rowHtml}</tbody>
        </table>
      </div>
    </section>
  `;
}

function renderSelectedEmployeeReportPreview(host, selectedEmployeeId) {
  const employee = state.employees.find((item) => item.id === selectedEmployeeId);
  if (!employee) {
    host.innerHTML = '<section class="panel timecard-picker"><div class="empty">Employee not found.</div></section>';
    return;
  }

  const rows = employeeRowsForReport(selectedEmployeeId);
  const summary = summarizeEmployeeRows(rows);
  host.innerHTML = `
    <section class="panel timecard-picker selected-report-preview">
      <div>
        <h2>${escapeHtml(employee.fullName)}</h2>
        <p class="muted">${escapeHtml(currentCutoffRangeText())} - ${escapeHtml(rows.length)} daily record${rows.length === 1 ? '' : 's'}</p>
      </div>
      <div class="preview-summary">
        <span><b>${escapeHtml(minutesText(summary.paidMinutes))}</b> Paid</span>
        <span><b>${escapeHtml(summary.lateRecords)}</b> Late</span>
        <span><b>${escapeHtml(summary.absent)}</b> Absent</span>
        <span><b>${escapeHtml(summary.incomplete)}</b> Incomplete</span>
      </div>
      <button type="button" onclick="openEmployeeTimeCard('${escapeHtml(employee.id)}')">Open Time Card</button>
    </section>
  `;
}

function renderEmployeeTimeCardReport() {
  const host = $('employeeTimeCardReport');
  if (!host) return;

  const selectedEmployeeId = $('timeCardEmployee').value || state.reportEmployeeId;
  if (!selectedEmployeeId) {
    renderEmployeeReportPicker(host);
    return;
  }

  renderSelectedEmployeeReportPreview(host, selectedEmployeeId);
}

function detailLine(label, value, tone = '') {
  return `
    <div class="detail-line">
      <span>${escapeHtml(label)}</span>
      <strong class="${tone}">${escapeHtml(value || '-')}</strong>
    </div>
  `;
}

function renderTimeCardDetail() {
  const record = state.timeCards[state.selectedTimeCardIndex];
  const detail = $('timeCardDetail');
  if (!record) {
    detail.innerHTML = '<div class="empty small">Select a time card record.</div>';
    return;
  }

  detail.innerHTML = `
    <div class="detail-title">
      <strong>${escapeHtml(record.fullName)}</strong>
      <span class="badge ${record.statusClass === 'bad' ? 'bad' : record.statusClass === 'warn' ? 'warn' : 'good'}">${escapeHtml(record.status)}</span>
    </div>
    ${detailLine('Date', `${record.dateKey} ${record.dayLabel || ''}`)}
    ${detailLine('Branch', record.branch || record.location || state.settings.branchName)}
    ${detailLine('Scheduled Time In', record.scheduledTimeIn || '-')}
    ${detailLine('Scheduled Time Out', record.scheduledTimeOut || '-')}
    ${detailLine('Actual Time In', record.actualTimeIn || '-')}
    ${detailLine('Actual Time Out', record.actualTimeOut || '-')}
    ${detailLine('Late Minutes', record.lateMinutes ? `${record.lateMinutes} min` : '0 min', record.lateMinutes ? 'status-warn' : '')}
    ${detailLine('Early Out Minutes', record.earlyOutMinutes ? `${record.earlyOutMinutes} min` : '0 min', record.earlyOutMinutes ? 'status-warn' : '')}
    ${detailLine('Gross Hours', record.grossHours ?? 0)}
    ${detailLine('Lunch Deduction', record.lunchDeduction ?? 0)}
    ${detailLine('Paid Hours', record.paidHours ?? 0, 'status-good')}
    ${detailLine('Overtime Minutes', record.overtimeMinutes ? `${record.overtimeMinutes} min` : '0 min')}
    ${detailLine('Reason', record.reason || '-')}
    ${detailLine('Fingerprint ID', record.fingerprintId || '-')}
  `;
}

function selectTimeCardRecord(index) {
  state.selectedTimeCardIndex = index;
  const record = state.timeCards[index];
  if (record && record.employeeId) state.reportEmployeeId = record.employeeId;
  renderTimeCard();
}

function renderTimeCard() {
  const rows = $('timeCardRows');
  renderTimeCardMetrics();
  renderEmployeeTimeCardReport();
  $('timeCardCount').textContent = `${state.timeCards.length} record${state.timeCards.length === 1 ? '' : 's'}`;

  if (!state.timeCards.length) {
    rows.innerHTML = '<tr><td colspan="8" class="muted">No time card data.</td></tr>';
    renderTimeCardDetail();
    return;
  }

  if (state.selectedTimeCardIndex >= state.timeCards.length) state.selectedTimeCardIndex = 0;

  rows.innerHTML = state.timeCards.map((record, index) => `
    <tr class="${index === state.selectedTimeCardIndex ? 'selected-row' : ''}" onclick="selectTimeCardRecord(${index})">
      <td>${escapeHtml(record.dateKey)}<br><span class="muted">${escapeHtml(record.dayLabel)}</span></td>
      <td>${escapeHtml(record.fullName)}<br><span class="muted">ID ${escapeHtml(record.fingerprintId)}</span></td>
      <td>${escapeHtml(record.scheduledTimeIn || '-')}<br><span class="muted">${escapeHtml(record.scheduledTimeOut || '-')}</span></td>
      <td>${escapeHtml(record.actualTimeIn || '-')}<br><span class="muted">${escapeHtml(record.actualTimeOut || '-')}</span></td>
      <td>${record.lateMinutes ? `${escapeHtml(record.lateMinutes)} min` : '-'}</td>
      <td>${record.earlyOutMinutes ? `${escapeHtml(record.earlyOutMinutes)} min` : '-'}</td>
      <td>${escapeHtml(record.paidHours ?? 0)}</td>
      <td class="${timeCardClass(record)}">${escapeHtml(record.status)}</td>
    </tr>
  `).join('');
  renderTimeCardDetail();
}

function timeCardParams() {
  const params = new URLSearchParams({
    from: $('timeCardFrom').value || todayKey(),
    to: $('timeCardTo').value || $('timeCardFrom').value || todayKey()
  });
  if ($('timeCardEmployee').value) params.set('employeeId', $('timeCardEmployee').value);
  if ($('timeCardBranch').value.trim()) params.set('branch', $('timeCardBranch').value.trim());
  if ($('timeCardStatus').value) params.set('status', $('timeCardStatus').value);
  return params;
}

async function loadTimeCard() {
  const selectedEmployee = $('timeCardEmployee').value;
  if (selectedEmployee) state.reportEmployeeId = selectedEmployee;
  const data = await api(`/api/timecard?${timeCardParams().toString()}`);
  state.timeCards = data.timeCards || [];
  state.selectedTimeCardIndex = 0;
  renderTimeCard();
}

function employeeReportParams(employeeId) {
  const params = new URLSearchParams({
    from: $('timeCardFrom').value || todayKey(),
    to: $('timeCardTo').value || $('timeCardFrom').value || todayKey(),
    employeeId
  });
  if ($('timeCardBranch').value.trim()) params.set('branch', $('timeCardBranch').value.trim());
  return params;
}

async function loadEmployeeReportRows(employeeId) {
  const data = await api(`/api/timecard?${employeeReportParams(employeeId).toString()}`);
  return data.timeCards || [];
}

async function openTimeCardModal(employeeId) {
  const employee = state.employees.find((item) => item.id === employeeId);
  if (!employee) return;

  state.timeCardModalEmployeeId = employeeId;
  $('timeCardModalTitle').textContent = `${employee.fullName} Time Card`;
  $('timeCardModalSubtitle').textContent = currentCutoffRangeText();
  $('timeCardModalMessage').textContent = 'Loading time card...';
  $('timeCardModalReport').innerHTML = '';
  $('timeCardModalBackdrop').classList.remove('hidden');

  try {
    state.timeCardModalRows = await loadEmployeeReportRows(employeeId);
    $('timeCardModalMessage').textContent = '';
    $('timeCardModalReport').innerHTML = employeeTimeCardReportHtml(employeeId, state.timeCardModalRows);
  } catch (error) {
    $('timeCardModalMessage').textContent = error.message;
  }
}

function closeTimeCardModal() {
  $('timeCardModalBackdrop').classList.add('hidden');
  state.timeCardModalEmployeeId = '';
  state.timeCardModalRows = [];
}

async function openEmployeeTimeCard(employeeId) {
  $('timeCardEmployee').value = employeeId;
  state.reportEmployeeId = employeeId;
  await loadTimeCard();
  await openTimeCardModal(employeeId);
}

function exportCsv() {
  window.location.href = `/api/timecard/export/csv?${timeCardParams().toString()}`;
}

function printTimeCard() {
  window.open(`/api/timecard/export/pdf?${timeCardParams().toString()}`, '_blank');
}

function reportDocumentCss() {
  return `
    * { box-sizing: border-box; }
    body { margin: 0; background: #ffffff; color: #111827; font-family: Inter, Arial, Helvetica, sans-serif; }
    .timecard-report-card { font-family: Inter, Arial, Helvetica, sans-serif; }
    .timecard-report-card { width: 100%; overflow: hidden; background: linear-gradient(180deg, #ffffff 0%, #f8fbff 100%); border: 1px solid #d7e4f2; border-radius: 8px; }
    .report-accent { height: 6px; background: linear-gradient(90deg, #2563eb 0%, #22c1dc 55%, #0f766e 100%); }
    .report-header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; padding: 24px 26px 14px; }
    .report-company { display: block; margin-bottom: 12px; color: #1d4ed8; font-size: 13px; font-weight: 950; letter-spacing: 0.08em; text-transform: uppercase; }
    .report-header h2 { margin: 0; color: #111827; font-size: 34px; line-height: 1.05; letter-spacing: 0; }
    .report-header p { margin: 10px 0 0; color: #667085; font-size: 15px; }
    .report-mode { display: inline-flex; align-items: center; min-height: 48px; padding: 0 22px; border: 1px solid #bfdbfe; border-radius: 999px; color: #1d4ed8; background: #eff6ff; font-size: 13px; font-weight: 950; letter-spacing: 0.08em; text-transform: uppercase; white-space: nowrap; }
    .report-info-grid, .report-summary-grid { display: grid; gap: 12px; padding: 12px 26px; }
    .report-info-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .report-summary-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .report-info-box, .report-summary-box { min-width: 0; border: 1px solid #dbe6f2; border-radius: 8px; background: rgba(255, 255, 255, 0.86); padding: 14px; }
    .report-info-box span, .report-summary-box span { display: block; color: #667085; font-size: 11px; font-weight: 950; letter-spacing: 0.08em; text-transform: uppercase; }
    .report-info-box strong, .report-summary-box strong { display: block; margin-top: 10px; color: #111827; font-size: 21px; line-height: 1.15; }
    .report-info-box small { display: block; margin-top: 6px; color: #667085; font-size: 12px; }
    .report-summary-box.good { border-color: #bbf7d0; background: #f0fdf4; }
    .report-summary-box.warn { border-color: #fed7aa; background: #fff7ed; }
    .report-summary-box.bad { border-color: #fecaca; background: #fff5f5; }
    .report-table-wrap { margin: 16px 26px 26px; overflow: hidden; border: 1px solid #dbe6f2; border-radius: 8px; }
    table { width: 100%; min-width: 850px; border-collapse: collapse; }
    th, td { padding: 16px 18px; border-bottom: 1px solid #edf1f5; text-align: center; vertical-align: middle; font-size: 15px; }
    th { background: #eaf4ff; color: #344054; font-size: 12px; font-weight: 900; text-transform: uppercase; letter-spacing: 0.04em; }
    tbody tr:nth-child(odd) { background: rgba(241, 245, 249, 0.72); }
    td strong, td span { display: block; }
    td strong { color: #111827; font-size: 17px; }
    td span:not(.timecard-status-badge) { margin-top: 6px; color: #667085; font-size: 13px; }
    .timecard-status-badge { display: inline-flex !important; align-items: center; justify-content: center; min-width: 118px; min-height: 34px; padding: 6px 14px; border-radius: 999px; font-size: 12px; font-weight: 950; letter-spacing: 0.04em; }
    .timecard-status-badge.good { color: #15803d; background: #dcfce7; border: 1px solid #86efac; }
    .timecard-status-badge.warn { color: #b45309; background: #fffbeb; border: 1px solid #fcd34d; }
    .timecard-status-badge.bad { color: #b42318; background: #fff1f2; border: 1px solid #fecdd3; }
    .timecard-status-badge.neutral { color: #344054; background: #f8fafc; border: 1px solid #cbd5e1; }
    .muted { color: #667085; }
    .empty { color: #667085; background: #f8fafc; border: 1px dashed #d7dde7; border-radius: 8px; padding: 12px; font-size: 13px; }
    @media print { body { padding: 0; } .timecard-report-card { border-color: #d7e4f2; } @page { margin: 12mm; size: portrait; } }
  `;
}

function modalReportFileName(extension) {
  const employee = state.employees.find((item) => item.id === state.timeCardModalEmployeeId);
  const from = $('timeCardFrom').value || todayKey();
  const to = $('timeCardTo').value || from;
  return `timecard-${slugifyFileName(employee ? employee.fullName : 'employee')}-${from}-to-${to}.${extension}`;
}

function printModalTimeCardPdf() {
  const employeeId = state.timeCardModalEmployeeId || $('timeCardEmployee').value || state.reportEmployeeId;
  if (!employeeId) return;
  const rows = state.timeCardModalRows.length ? state.timeCardModalRows : employeeRowsForReport(employeeId);
  const employee = state.employees.find((item) => item.id === employeeId);
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    $('timeCardModalMessage').textContent = 'Allow popups to save PDF.';
    return;
  }

  printWindow.document.open();
  printWindow.document.write(`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>${escapeHtml(employee ? `${employee.fullName} Time Card` : 'Employee Time Card')}</title>
        <style>${reportDocumentCss()}</style>
      </head>
      <body>
        ${employeeTimeCardReportHtml(employeeId, rows)}
        <script>
          window.addEventListener('load', function () {
            setTimeout(function () {
              window.focus();
              window.print();
            }, 200);
          });
        <\/script>
      </body>
    </html>
  `);
  printWindow.document.close();
}

function saveModalTimeCardPhoto() {
  const report = $('timeCardModalReport').querySelector('.timecard-report-card');
  if (!report) {
    $('timeCardModalMessage').textContent = 'Open an employee time card first.';
    return;
  }

  $('timeCardModalMessage').textContent = 'Preparing photo...';
  const width = Math.ceil(Math.max(1050, report.scrollWidth, report.getBoundingClientRect().width));
  const height = Math.ceil(Math.max(600, report.scrollHeight, report.getBoundingClientRect().height));
  const clone = report.cloneNode(true);
  clone.style.width = `${width}px`;
  clone.style.margin = '0';
  clone.style.boxShadow = 'none';

  const xhtml = new XMLSerializer().serializeToString(clone);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <foreignObject width="100%" height="100%">
        <div xmlns="http://www.w3.org/1999/xhtml">
          <style>${reportDocumentCss()}</style>
          ${xhtml}
        </div>
      </foreignObject>
    </svg>
  `;

  const svgBlob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const svgUrl = URL.createObjectURL(svgBlob);
  const image = new Image();

  image.onload = () => {
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    URL.revokeObjectURL(svgUrl);

    canvas.toBlob((blob) => {
      if (!blob) {
        $('timeCardModalMessage').textContent = 'Could not save photo.';
        return;
      }
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = modalReportFileName('png');
      link.click();
      URL.revokeObjectURL(link.href);
      $('timeCardModalMessage').textContent = 'Photo saved.';
    }, 'image/png');
  };

  image.onerror = () => {
    URL.revokeObjectURL(svgUrl);
    $('timeCardModalMessage').textContent = 'Could not render the photo.';
  };

  image.src = svgUrl;
}

function saveTimeCardPng() {
  const rows = state.timeCards.slice(0, 40);
  const width = 1500;
  const rowHeight = 34;
  const height = 100 + Math.max(1, rows.length) * rowHeight;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#172033';
  ctx.font = 'bold 24px Arial';
  ctx.fillText(`${state.settings.branchName || 'GMS'} Time Card`, 24, 36);
  ctx.font = '13px Arial';
  ctx.fillStyle = '#526173';
  ctx.fillText(`${$('timeCardFrom').value} to ${$('timeCardTo').value}`, 24, 60);

  const columns = [
    ['Date', 24],
    ['Employee', 160],
    ['Sched In', 420],
    ['Sched Out', 520],
    ['Actual In', 640],
    ['Actual Out', 760],
    ['Paid', 890],
    ['Status', 970],
    ['Reason', 1120]
  ];
  ctx.font = 'bold 13px Arial';
  ctx.fillStyle = '#172033';
  columns.forEach(([label, x]) => ctx.fillText(label, x, 90));
  ctx.font = '12px Arial';
  rows.forEach((record, index) => {
    const y = 120 + index * rowHeight;
    ctx.fillStyle = index % 2 ? '#f6f8fb' : '#ffffff';
    ctx.fillRect(16, y - 22, width - 32, rowHeight);
    ctx.fillStyle = '#172033';
    [
      record.dateKey,
      record.fullName,
      record.scheduledTimeIn || '-',
      record.scheduledTimeOut || '-',
      record.actualTimeIn || '-',
      record.actualTimeOut || '-',
      String(record.paidHours ?? 0),
      record.status,
      record.reason || '-'
    ].forEach((value, colIndex) => {
      ctx.fillText(String(value).slice(0, colIndex === 1 ? 28 : 22), columns[colIndex][1], y);
    });
  });
  canvas.toBlob((blob) => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'gms-time-card.png';
    link.click();
    URL.revokeObjectURL(link.href);
  });
}

async function saveSettings(event) {
  event.preventDefault();
  $('settingsMessage').textContent = 'Saving...';
  try {
    const data = await api('/api/settings', {
      method: 'POST',
      body: JSON.stringify(getSettingsFromForm())
    });
    state.settings = data.settings || state.settings;
    setSettingsForm();
    buildScheduleForm();
    $('settingsMessage').textContent = 'Settings saved.';
    await loadAll();
  } catch (error) {
    $('settingsMessage').textContent = error.message;
  }
}

async function saveManualStatus(event) {
  event.preventDefault();
  $('manualStatusMessage').textContent = 'Saving...';
  try {
    await api('/api/timecard/manual-status', {
      method: 'POST',
      body: JSON.stringify({
        employeeId: $('manualEmployee').value,
        dateKey: $('manualDate').value,
        status: $('manualStatus').value,
        reason: $('manualReason').value,
        approvedBy: $('manualApprovedBy').value
      })
    });
    $('manualStatusMessage').textContent = 'Status saved.';
    await loadAll();
  } catch (error) {
    $('manualStatusMessage').textContent = error.message;
  }
}

async function saveEmergencyAttendance(event) {
  event.preventDefault();
  $('emergencyMessage').textContent = 'Saving...';
  try {
    const localValue = $('emergencyDateTime').value;
    const scannedAt = localValue ? new Date(localValue).toISOString() : new Date().toISOString();
    await api('/api/admin/emergency-attendance', {
      method: 'POST',
      body: JSON.stringify({
        employeeId: $('emergencyEmployee').value,
        attendanceType: $('emergencyType').value,
        scannedAt,
        reason: $('emergencyReason').value,
        approvedBy: $('emergencyApprovedBy').value,
        remarks: $('emergencyRemarks').value
      })
    });
    $('emergencyMessage').textContent = 'Emergency attendance saved.';
    await loadAll();
  } catch (error) {
    $('emergencyMessage').textContent = error.message;
  }
}

async function startEnrollment() {
  $('enrollmentMessage').textContent = 'Sending enrollment command...';
  try {
    const data = await api('/api/fingerprints/start-enrollment', {
      method: 'POST',
      body: JSON.stringify({ deviceId: $('enrollDeviceSelect').value || 'ALL' })
    });
    $('enrollmentMessage').textContent = `Queued ${data.deviceDisplay.title} for ${data.deviceId}.`;
  } catch (error) {
    $('enrollmentMessage').textContent = error.message;
  }
}

async function saveEmployee(event) {
  event.preventDefault();
  const employeeId = $('employeeIdInput').value;
  const fingerprintIdValue = $('fingerprintIdInput').value;
  const fingerprintId = fingerprintIdValue ? Number(fingerprintIdValue) : null;
  const fullName = $('fullNameInput').value.trim();
  const graceMinutes = Number($('graceMinutesInput').value || 0);
  const weeklySchedule = getScheduleFromForm();
  const fingerprintLabel = $('fingerprintLabelInput').value.trim() || 'Primary Finger';
  $('formMessage').textContent = employeeId ? 'Updating...' : 'Saving...';

  try {
    const path = employeeId ? `/api/employees/${encodeURIComponent(employeeId)}` : '/api/employees';
    const method = employeeId ? 'PATCH' : 'POST';
    await api(path, {
      method,
      body: JSON.stringify({
        fingerprintId,
        fullName,
        graceMinutes,
        weeklySchedule,
        fingerprintLabel,
        allowNoFingerprint: !fingerprintId
      })
    });
    closeModal();
    await loadAll();
    if (employeeId) {
      $('employeeMessage').textContent = `${fullName} updated.`;
    } else if (fingerprintId) {
      $('enrollmentMessage').textContent = `Fingerprint ID ${fingerprintId} registered to ${fullName}.`;
      $('employeeMessage').textContent = `${fullName} created.`;
    } else {
      $('employeeMessage').textContent = `${fullName} created. Link a fingerprint from Enrollment when ready.`;
    }
  } catch (error) {
    $('formMessage').textContent = error.message;
  }
}

async function clearAttendance() {
  if (!confirm('Clear all attendance logs?')) return;
  await api('/api/testing/clear-attendance', { method: 'POST', body: '{}' });
  await loadAll();
}

async function clearPending() {
  if (!confirm('Clear pending registration list?')) return;
  await api('/api/testing/clear-pending', { method: 'POST', body: '{}' });
  await loadAll();
}

function unlockAudio() {
  state.audioReady = true;
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  const audio = new Audio(ALARM_AUDIO_URL);
  audio.preload = 'auto';
  audio.load();
  $('settingsMessage').textContent = 'Notifications and alarm sound enabled.';
}

function stopAlarmSound() {
  if (state.alarmStopTimer) {
    clearTimeout(state.alarmStopTimer);
    state.alarmStopTimer = null;
  }

  if (state.activeAlarmAudio) {
    state.activeAlarmAudio.pause();
    state.activeAlarmAudio.currentTime = 0;
    state.activeAlarmAudio = null;
  }
}

function playFallbackAlarmSound(durationMs = 30000) {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  const ctx = new AudioContext();
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = 'square';
  oscillator.frequency.value = 1200;
  gain.gain.value = 0.2;
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start();

  let high = true;
  const pulse = setInterval(() => {
    high = !high;
    oscillator.frequency.value = high ? 1200 : 750;
    gain.gain.value = high ? 0.24 : 0.08;
  }, 280);

  setTimeout(() => {
    clearInterval(pulse);
    oscillator.stop();
    ctx.close();
  }, durationMs);
}

function playAlarmSound(durationMs = 30000) {
  if (!state.audioReady) return;
  stopAlarmSound();

  const audio = new Audio(ALARM_AUDIO_URL);
  audio.loop = true;
  audio.volume = 1;
  state.activeAlarmAudio = audio;

  state.alarmStopTimer = setTimeout(stopAlarmSound, durationMs);

  audio.play().catch(() => {
    stopAlarmSound();
    playFallbackAlarmSound(durationMs);
    $('settingsMessage').textContent = 'Browser blocked MP3. Click Test Alarm again.';
  });
}

function testAlarm() {
  if (state.activeAlarmAudio) {
    stopAlarmSound();
    $('settingsMessage').textContent = 'Test alarm stopped.';
    return;
  }

  state.audioReady = true;
  playAlarmSound(15000);
  $('settingsMessage').textContent = 'Playing test alarm... click Test Alarm again to stop.';
}

function notifyBreak(title) {
  if ('Notification' in window && Notification.permission === 'granted') {
    new Notification(title);
  }
  playAlarmSound(30000);
}

function checkBreakAlarm() {
  if (!state.settings.pcBreakAlarmEnabled) return;
  const now = new Date();
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const today = todayKey();
  const events = [
    [state.settings.lunchBreakStart, 'LUNCH BREAK STARTED'],
    [state.settings.lunchBreakEnd, 'LUNCH BREAK ENDED'],
    [state.settings.afternoonBreakStart, 'AFTERNOON BREAK STARTED'],
    [state.settings.afternoonBreakEnd, 'AFTERNOON BREAK ENDED']
  ];
  events.forEach(([time, title]) => {
    const key = `${today}-${time}-${title}`;
    if (time === hhmm && !state.alarmKeys.has(key)) {
      state.alarmKeys.add(key);
      notifyBreak(title);
    }
  });
}

async function loadAll() {
  await checkServer();
  try {
    const [settingsData, summaryData, readersData, pendingData, employeesData, attendanceData] = await Promise.all([
      api('/api/settings'),
      api('/api/dashboard/summary'),
      api('/api/readers'),
      api('/api/fingerprints/pending'),
      api('/api/employees'),
      api('/api/attendance?limit=100')
    ]);

    const hadNoPending = state.pending.length === 0;
    state.settings = settingsData.settings || state.settings;
    state.summary = summaryData.summary || {};
    state.readers = readersData.readers || [];
    state.pending = pendingData.pending || [];
    state.employees = employeesData.employees || [];
    state.attendance = attendanceData.attendance || [];

    setSettingsForm();
    renderSummary();
    renderDashboardLists();
    renderReaders();
    renderPending();
    renderEmployees();
    renderAttendance();
    await loadTimeCard();

    if (hadNoPending && state.pending.length > 0 && $('modalBackdrop').classList.contains('hidden')) {
      openRegisterModal(state.pending[0].fingerprintId);
    }
  } catch (error) {
    console.error(error);
  }
}

function boot() {
  document.querySelectorAll('[data-login-mode]').forEach((button) => button.addEventListener('click', () => setLoginMode(button.dataset.loginMode)));
  $('toggleLoginPassword').addEventListener('click', () => setSecretVisibility('loginPassword', 'toggleLoginPassword'));
  $('toggleLoginApiKey').addEventListener('click', () => setSecretVisibility('loginApiKey', 'toggleLoginApiKey'));
  buildScheduleForm();
  const today = todayKey();
  $('timeCardFrom').value = today;
  $('timeCardTo').value = today;
  $('timeCardCutoff').value = defaultCutoffForDate(today);
  applyCutoffToDates();
  $('manualDate').value = today;
  $('emergencyDateTime').value = new Date().toISOString().slice(0, 16);
  setSettingsForm();
  setActiveView(new URLSearchParams(window.location.search).get('view') || 'dashboardView');
  setTimeCardTab('recordsTab');

  document.querySelectorAll('.nav-item').forEach((button) => {
    button.addEventListener('click', () => setActiveView(button.dataset.view));
  });
  document.querySelectorAll('[data-view-link]').forEach((button) => {
    button.addEventListener('click', () => setActiveView(button.dataset.viewLink));
  });
  document.querySelectorAll('.subnav-item').forEach((button) => {
    button.addEventListener('click', () => setTimeCardTab(button.dataset.timecardTab));
  });
  $('refreshBtn').addEventListener('click', loadAll);
  $('createEmployeeBtn').addEventListener('click', openCreateEmployeeModal);
  $('startEnrollmentBtn').addEventListener('click', startEnrollment);
  $('loadTimeCardBtn').addEventListener('click', loadTimeCard);
  $('timeCardCutoff').addEventListener('change', () => {
    applyCutoffToDates();
    loadTimeCard();
  });
  $('timeCardFrom').addEventListener('change', () => {
    $('timeCardCutoff').value = 'custom';
    loadTimeCard();
  });
  $('timeCardTo').addEventListener('change', () => {
    $('timeCardCutoff').value = 'custom';
    loadTimeCard();
  });
  $('timeCardEmployee').addEventListener('change', () => {
    const employeeId = $('timeCardEmployee').value;
    state.reportEmployeeId = employeeId;
    loadTimeCard().then(() => {
      if (employeeId) openTimeCardModal(employeeId);
    });
  });
  $('timeCardStatus').addEventListener('change', loadTimeCard);
  $('timeCardBranch').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') loadTimeCard();
  });
  $('printTimeCardBtn').addEventListener('click', printTimeCard);
  $('pdfTimeCardBtn').addEventListener('click', printTimeCard);
  $('pngTimeCardBtn').addEventListener('click', saveTimeCardPng);
  $('csvTimeCardBtn').addEventListener('click', exportCsv);
  $('saveTimeCardPhotoBtn').addEventListener('click', saveModalTimeCardPhoto);
  $('saveTimeCardPdfBtn').addEventListener('click', printModalTimeCardPdf);
  $('closeTimeCardModalBtn').addEventListener('click', closeTimeCardModal);
  $('settingsForm').addEventListener('submit', saveSettings);
  $('manualStatusForm').addEventListener('submit', saveManualStatus);
  $('emergencyForm').addEventListener('submit', saveEmergencyAttendance);
  $('employeeForm').addEventListener('submit', saveEmployee);
  $('closeModalBtn').addEventListener('click', closeModal);
  $('cancelBtn').addEventListener('click', closeModal);
  $('clearAttendanceBtn').addEventListener('click', clearAttendance);
  $('clearPendingBtn').addEventListener('click', clearPending);
  $('enableAlarmBtn').addEventListener('click', unlockAudio);
  $('testAlarmBtn').addEventListener('click', testAlarm);
  $('modalBackdrop').addEventListener('click', (event) => {
    if (event.target === $('modalBackdrop')) closeModal();
  });
  $('timeCardModalBackdrop').addEventListener('click', (event) => {
    if (event.target === $('timeCardModalBackdrop')) closeTimeCardModal();
  });
  window.addEventListener('click', () => { state.audioReady = state.audioReady || false; }, { once: true });

  loadAll();
  setInterval(loadAll, 5000);
  setInterval(checkBreakAlarm, 15000);
}

boot();
