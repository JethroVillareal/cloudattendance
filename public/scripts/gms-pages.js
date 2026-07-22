(() => {
  const routes = {
    Dashboard: '/dashboard', 'Time Card': '/timecard', Enrollment: '/enrollment',
    Employees: '/employees', 'Employee Accounts': '/accounts', Devices: '/devices', Settings: '/settings', Logs: '/logs'
  };
  const $ = (id) => document.getElementById(id);
  let currentUser = null;

  const roleProfiles = {
    admin: {
      label: 'Administrator',
      subtitle: 'Full system control',
      nav: ['Dashboard', 'Time Card', 'Enrollment', 'Employees', 'Employee Accounts', 'Devices', 'Settings', 'Logs']
    },
    hr: {
      label: 'HR Workspace',
      subtitle: 'People and attendance operations',
      nav: ['Dashboard', 'Time Card', 'Enrollment', 'Employees', 'Devices', 'Logs']
    },
    viewer: {
      label: 'Viewer Mode',
      subtitle: 'Read-only monitoring',
      nav: ['Dashboard', 'Time Card', 'Employees', 'Devices', 'Logs']
    }
  };

  const roleProfile = () => roleProfiles[currentUser?.role] || roleProfiles.admin;

  // Re-initialize Lucide after dynamic rendering and browser back/forward cache restores.
  const refreshLucideIcons = () => {
    if (!window.lucide?.createIcons) return;
    requestAnimationFrame(() => window.lucide?.createIcons());
  };

  window.addEventListener('pageshow', refreshLucideIcons);
  function clearStaticDemoContent() {
    const loadingRow = (body) => {
      const columns = body.closest('table')?.querySelectorAll('thead th').length || 1;
      body.innerHTML = `<tr class="live-loading-row"><td colspan="${columns}" style="padding:28px;text-align:center;color:#75829b">Waiting for authenticated live server data...</td></tr>`;
    };
    document.querySelectorAll('main table tbody, .main-content table tbody').forEach(loadingRow);

    document.querySelectorAll('.summary-card, .stat-card, .dashboard-card').forEach((card) => {
      const value = card.querySelector('strong');
      if (value) value.textContent = '—';
    });

    const gridView = $('gridView');
    if (location.pathname === '/employees' && gridView) {
      gridView.innerHTML = '<section class="employee-section live-employee-section"><div class="empty-state">Waiting for authenticated live employee data...</div></section>';
    }
    const listRows = $('listRows');
    if (listRows) listRows.innerHTML = '<div class="empty-state">Waiting for authenticated live employee data...</div>';

    ['entriesInfo', 'entriesText', 'employeeCountText'].forEach((id) => {
      const element = $(id);
      if (element) element.textContent = 'Waiting for live data...';
    });
  }
  clearStaticDemoContent();
  const esc = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]);
  const when = (value) => value ? new Date(value).toLocaleString() : 'Never';
  let authenticationPromise = null;
  const authenticateBrowser = async () => {
    if (!authenticationPromise) {
      authenticationPromise = (async () => {
        const credential = window.prompt('Enter your username:');
        if (!credential) throw new Error('Authentication is required.');
        const password = window.prompt(`Enter the password for ${credential}:`);
        if (!password) throw new Error('Authentication is required.');
        const login = await fetch('/api/auth/login', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: credential, password })
        });
        if (!login.ok) throw new Error('Invalid login credentials.');
      })().finally(() => { authenticationPromise = null; });
    }
    return authenticationPromise;
  };
  const api = async (path, options = {}) => {
    let response = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
    });
    if (response.status === 401 && path !== '/api/auth/login') {
      await authenticateBrowser();
      response = await fetch(path, {
        ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
      });
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || `Request failed (${response.status})`);
    return data;
  };
  const toast = (message) => {
    const box = $('toast');
    const label = $('toastMessage');
    if (label) label.textContent = message;
    if (box) {
      box.classList.add('show');
      setTimeout(() => box.classList.remove('show'), 2600);
    }
  };

  function applyRoleShell() {
    const role = currentUser?.role || 'admin';
    document.body.dataset.accountRole = role;
    document.body.classList.toggle('viewer-mode', role === 'viewer');
    document.body.classList.toggle('hr-mode', role === 'hr');
    document.body.classList.toggle('admin-mode', role === 'admin');
    const restrictedPage = role === 'viewer' && ['/enrollment', '/accounts', '/settings'].includes(location.pathname);
    const hrAdminPage = role === 'hr' && ['/accounts', '/settings'].includes(location.pathname);
    if (restrictedPage) {
      toast('Viewer mode is read-only. Opening dashboard.');
      window.location.replace('/dashboard');
    }
    if (hrAdminPage) {
      toast('HR workspace does not include administrator settings.');
      window.location.replace('/dashboard');
    }
  }

  function installCanonicalSidebar(currentPath) {
    document.querySelectorAll('.topbar').forEach((topbar) => topbar.remove());
    const workspace = document.querySelector('.workspace');
    if (workspace && !workspace.querySelector('.topbar')) {
      const topbar = document.createElement('header');
      topbar.className = 'topbar';
      topbar.innerHTML = `
        <div class="topbar-left">
          <button class="top-icon menu" title="Menu" type="button"><i data-lucide="menu"></i></button>
          <button class="top-icon" title="Messages" type="button"><i data-lucide="mail"></i></button>
          <button class="top-icon" title="Notifications" type="button"><i data-lucide="bell"></i><span class="notification-count">3</span></button>
          <button class="top-icon" title="Calendar" type="button"><i data-lucide="calendar-days"></i></button>
          <button class="top-icon" title="Help" type="button"><i data-lucide="circle-help"></i></button>
        </div>`;
      workspace.insertBefore(topbar, workspace.firstChild);
      window.lucide?.createIcons();
    }
    const sidebar = document.querySelector('.sidebar');
    if (!sidebar) return;
    const allItems = [
      ['Dashboard', '/dashboard', 'dashboard.svg'],
      ['Time Card', '/timecard', 'timecard.svg'],
      ['Enrollment', '/enrollment', 'fingerprint.svg'],
      ['Employees', '/employees', 'employee.svg'],
      ['Employee Accounts', '/accounts', 'accounts.svg'],
      ['Devices', '/devices', 'device.svg'],
      ['Settings', '/settings', 'settings.svg'],
      ['Logs', '/logs', 'logs.svg']
    ];
    const allowed = new Set(roleProfile().nav);
    const items = allItems.filter(([label]) => allowed.has(label));
    sidebar.innerHTML = `
      <div class="brand shared-brand">
        <div class="brand-logo"><img src="/images/gwd-logo.jpg" alt="Gluta White Distributor logo"></div>
        <div class="brand-info"><h1>GWD Attendance</h1><p>Loading branch...</p><span class="role-badge">${roleProfile().label}</span></div>
      </div>
      <nav class="navigation shared-navigation" aria-label="Main navigation">
        ${items.map(([label, route, icon]) => `<button class="nav-item shared-nav-item ${currentPath === route ? 'active' : ''}" type="button" data-page="${label}">
          <img class="shared-nav-icon" src="/icons/${icon}" alt=""><span>${label}</span>
        </button>`).join('')}
      </nav>
      <div class="server-status shared-server-status">
        <span class="status-dot"></span><span><strong>Online</strong><small>Asia/Manila</small></span>
      </div>`;
  }

  function installSharedBrand() {
    const logo = document.querySelector('.brand-logo');
    if (logo) logo.innerHTML = '<img src="/images/gwd-logo.jpg" alt="Gluta White Distributor logo">';
    const info = document.querySelector('.brand-info, .brand-details');
    if (info) {
      const title = info.querySelector('h1');
      const subtitle = info.querySelector('p');
      if (title) title.textContent = 'GWD Attendance';
      if (subtitle) subtitle.textContent = 'Loading branch...';
    }
    const heading = document.querySelector('.page-heading h2, .page-title h1, .page-header h1');
    if (heading && !heading.querySelector('.live-data-note')) {
      heading.insertAdjacentHTML('beforeend', '<span class="live-data-note">Live server data</span>');
    }
    document.querySelectorAll('.admin-avatar').forEach((avatar) => {
      avatar.innerHTML = '<img src="/images/gwd-logo.jpg" alt="GWD logo">';
    });
    document.querySelectorAll('.admin-info strong').forEach((name) => { name.textContent = roleProfile().label; });
    document.querySelectorAll('.admin-info span').forEach((role) => { role.textContent = roleProfile().subtitle; });
    document.querySelectorAll('.notification-badge').forEach((badge) => badge.remove());
  }

  async function loadSharedIdentity() {
    try {
      const [identity, { settings }] = await Promise.all([api('/api/auth/me'), api('/api/settings')]);
      currentUser = identity;
      applyRoleShell();
      installCanonicalSidebar(location.pathname);
      installSharedBrand();
      const subtitle = document.querySelector('.brand-info p, .brand-details p');
      if (subtitle) subtitle.textContent = settings.branchName || 'Main Branch';
      document.querySelectorAll('.admin-info span').forEach((role) => {
        role.textContent = `${roleProfile().subtitle} - ${settings.branchName || 'Main Branch'}`;
      });
    } catch (error) {
      console.error(error);
    }
  }

  document.addEventListener('click', (event) => {
    const nav = event.target.closest('.nav-item[data-page], .nav-link[data-page]');
    if (!nav || !routes[nav.dataset.page]) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.location.assign(routes[nav.dataset.page]);
  }, true);

  document.addEventListener('click', (event) => {
    const pageButton = event.target.closest('[data-enrollment-page]');
    if (!pageButton || pageButton.disabled) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    renderEnrollmentPage(pageButton.dataset.enrollmentPage);
  }, true);

  function setStat(label, value) {
    document.querySelectorAll('.stat-card').forEach((card) => {
      const title = card.querySelector('.stat-label')?.textContent.trim().toLowerCase();
      if (title === label.toLowerCase()) {
        const target = card.querySelector('.stat-value');
        if (target) target.textContent = value;
      }
    });
  }

  let dashboardVerificationRecords = [];
  let dashboardHasLoaded = false;

  function updateLiveHtml(element, html) {
    if (!element) return false;
    const nextHtml = String(html || '').trim();
    if (element.dataset.liveHtml === nextHtml) return false;
    element.innerHTML = nextHtml;
    element.dataset.liveHtml = nextHtml;
    return true;
  }

  async function dashboard() {
    if (!dashboardHasLoaded) document.querySelectorAll('table tbody').forEach((body) => {
      const columns = body.closest('table')?.querySelectorAll('thead th').length || 5;
      updateLiveHtml(body, `<tr><td colspan="${columns}" style="padding:24px;text-align:center;color:#75829b">Loading live records...</td></tr>`);
    });
    if (!dashboardHasLoaded) {
      document.querySelectorAll('.cutoff-detail strong').forEach((value) => { value.textContent = '—'; });
      document.querySelectorAll('.alert-number').forEach((value) => { value.textContent = '0'; });
    }
    const initialDate = $('dateFilter');
    const today = new Date();
    const todayKey = today.toLocaleDateString('en-CA');
    const selectedDateKey = initialDate?.dataset.liveReady === 'true' && initialDate.value ? initialDate.value : todayKey;
    if (initialDate) {
      const oldestDate = new Date(today); oldestDate.setFullYear(today.getFullYear() - 2);
      initialDate.min = oldestDate.toLocaleDateString('en-CA');
      initialDate.max = todayKey;
      initialDate.value = selectedDateKey;
      initialDate.dataset.liveReady = 'true';
    }
    const selectedDate = new Date(`${selectedDateKey}T12:00:00`);
    const monthFrom = `${selectedDateKey.slice(0, 7)}-01`;
    const monthTo = new Date(selectedDate.getFullYear(), selectedDate.getMonth() + 1, 0).toLocaleDateString('en-CA');
    const weekFromDate = new Date(selectedDate);
    weekFromDate.setDate(selectedDate.getDate() - 6);
    const timeCardFrom = weekFromDate.toLocaleDateString('en-CA') < monthFrom
      ? weekFromDate.toLocaleDateString('en-CA') : monthFrom;
    const [{ summary }, attendanceData, timeCardData, employeeData] = await Promise.all([
      api('/api/dashboard/summary'),
      api('/api/attendance?limit=500'),
      api(`/api/time-card?from=${encodeURIComponent(timeCardFrom)}&to=${encodeURIComponent(monthTo)}`),
      api('/api/employees')
    ]);
    const liveAttendance = attendanceData.attendance || [];
    const liveTimeCards = timeCardData.timeCards || [];
    const dashboardEmployees = employeeData.employees || [];
    const verificationRecords = liveAttendance.filter((log) =>
      String(log.reviewStatus || '').toUpperCase() !== 'VERIFIED' && (log.accepted === false || log.emergency === true ||
      String(log.code || '').toUpperCase().startsWith('EMERGENCY') ||
      String(log.status || log.statusText || '').toUpperCase().includes('EMERGENCY'))
    );
    dashboardVerificationRecords = verificationRecords;
    setStat('Present Today', summary.presentToday);
    setStat('Late Today', summary.lateToday);
    setStat('Absent Today', summary.absentToday);
    setStat('On Leave', summary.excusedToday);
    setStat('Pending Verification', summary.pendingFingerprintRegistrations + summary.pendingOfflineSync + verificationRecords.length);
    const pendingEmployeeCount = new Set(verificationRecords.map((log) => log.employeeId || log.fullName)).size;
    setStat('Verified Today', Math.max(0, summary.presentToday + summary.lateToday - pendingEmployeeCount));
    setStat('Devices Online', summary.devicesOnline);
    setStat('Devices Offline', summary.devicesOffline);
    const branch = $('branchFilter');
    if (branch) branch.innerHTML = `<option>${esc(summary.branchName)}</option>`;
    const tableBodies = [...document.querySelectorAll('table tbody')];
    const queuePanel = [...document.querySelectorAll('.panel')].find((panel) =>
      panel.querySelector('.panel-title')?.textContent.includes('Verification Queue'));
    const queueBody = queuePanel?.querySelector('tbody');
    if (queueBody) {
      const queueHtml = verificationRecords.length ? verificationRecords.map((log) => {
        const type = String(log.type || log.attendanceType || log.code || 'Emergency attendance').replaceAll('_', ' ');
        const issue = log.emergency || String(log.code || '').toUpperCase().startsWith('EMERGENCY')
          ? `Emergency ${type}`.replace(/Emergency Emergency/i, 'Emergency')
          : (log.message || 'Attendance record needs review');
        const time = new Date(log.timestamp || log.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        return `<tr>
          <td><strong>${esc(log.fullName || log.employeeName || 'Unknown employee')}</strong></td>
          <td><span class="activity-pill emergency">${esc(issue)}</span></td>
          <td>${esc(time)}</td>
          <td><span class="activity-pill ${log.reviewStatus === 'CORRECTION_REQUESTED' ? 'danger' : 'warning'}">${log.reviewStatus === 'CORRECTION_REQUESTED' ? 'Correction Requested' : 'Needs Review'}</span></td>
          <td><button type="button" class="review-button review-record" data-record-id="${esc(log.id || '')}">Review</button></td>
        </tr>`;
      }).join('') : '<tr><td colspan="5" style="padding:24px;text-align:center;color:#75829b">No live records for today.</td></tr>';
      updateLiveHtml(queueBody, queueHtml);
    }
    const body = tableBodies.at(-1);
    if (body) {
      const activityClass = (value) => {
        const text = String(value || '').toUpperCase();
        if (text.includes('EMERGENCY')) return 'emergency';
        if (text.includes('TIME_IN') || text.includes('PRESENT') || text.includes('VERIFIED')) return 'success';
        if (text.includes('TIME_OUT')) return 'info';
        if (text.includes('LATE') || text.includes('PENDING')) return 'warning';
        if (text.includes('ABSENT') || text.includes('ERROR') || text.includes('REJECT') || text.includes('CORRECTION')) return 'danger';
        return 'neutral';
      };
      const activityHtml = attendanceData.attendance?.length ? attendanceData.attendance.slice(0, 8).map((log) => {
        const type = log.type || log.attendanceType || 'Recorded';
        const status = log.status || log.statusText || 'Recorded';
        const reviewStatus = String(log.reviewStatus || '').toUpperCase();
        const isEmergency = log.emergency === true || String(log.code || '').toUpperCase().startsWith('EMERGENCY');
        const verification = reviewStatus === 'VERIFIED' ? 'Verified'
          : reviewStatus === 'CORRECTION_REQUESTED' ? 'Correction Requested'
          : (log.accepted === false || isEmergency) ? 'Needs Review' : 'Verified';
        return `<tr>
        <td>${esc(when(log.timestamp || log.createdAt))}</td><td>${employeeIdentity(dashboardEmployees.find((employee) => employee.id === log.employeeId) || { fullName: log.fullName || log.employeeName || 'Unknown', active: true })}</td>
        <td>${esc(log.branch || summary.branchName)}</td>
        <td><span class="activity-pill ${activityClass(type)}">${esc(String(type).replaceAll('_', ' '))}</span></td>
        <td><span class="activity-pill ${activityClass(status)}">${esc(String(status).replaceAll('_', ' '))}</span></td>
        <td title="${esc(log.message || '')}"><span class="activity-pill ${activityClass(verification)}">${verification}</span></td>
      </tr>`;
      }).join('') : '<tr><td colspan="6" style="padding:24px;text-align:center;color:#75829b">No live records for today.</td></tr>';
      updateLiveHtml(body, activityHtml);
    }
    const chartCanvas = $('attendanceChart');
    const chart = chartCanvas && window.Chart?.getChart?.(chartCanvas);
    if (chart) {
      const activePeriod = document.querySelector('.period-tab.active')?.dataset.period || 'daily';
      const referenceDate = new Date(`${selectedDateKey}T12:00:00`);
      const lastDay = new Date(referenceDate.getFullYear(), referenceDate.getMonth() + 1, 0).getDate();
      const dateForDay = (day) => new Date(referenceDate.getFullYear(), referenceDate.getMonth(), day, 12);
      let dates = [];
      if (activePeriod === 'daily') {
        dates = [referenceDate];
      } else if (activePeriod === 'weekly') {
        dates = Array.from({ length: 7 }, (_, index) => {
          const date = new Date(referenceDate);
          date.setDate(referenceDate.getDate() - (6 - index));
          return date;
        });
      } else if (activePeriod === 'monthly') {
        dates = Array.from({ length: lastDay }, (_, index) => dateForDay(index + 1));
      } else if (activePeriod === 'first') {
        dates = Array.from({ length: Math.min(15, lastDay) }, (_, index) => dateForDay(index + 1));
      } else {
        dates = Array.from({ length: Math.max(0, lastDay - 15) }, (_, index) => dateForDay(index + 16));
      }
      const keyFor = (value) => value.toLocaleDateString('en-CA');
      const logKey = (log) => {
        const date = new Date(log.timestamp || log.createdAt || 0);
        return Number.isNaN(date.getTime()) ? '' : keyFor(date);
      };
      const uniqueCount = (logs) => new Set(logs.map((log) => log.employeeId || log.fullName || log.employeeName)).size;
      const labels = dates.map((date) => activePeriod === 'daily'
        ? date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
        : activePeriod === 'weekly'
          ? date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })
          : String(date.getDate()));
      const present = [];
      const late = [];
      const absent = [];
      dates.forEach((date) => {
        const key = keyFor(date);
        const dayLogs = liveAttendance.filter((log) => logKey(log) === key && log.accepted !== false);
        const dayCards = liveTimeCards.filter((card) => card.dateKey === key);
        const isToday = key === summary.dateKey;
        const isFuture = key > summary.dateKey;
        present.push(isToday ? Number(summary.presentToday || 0) : isFuture ? 0
          : dayCards.filter((card) => card.actualTimeIn || card.timeIn).length || uniqueCount(dayLogs));
        late.push(isToday ? Number(summary.lateToday || 0) : isFuture ? 0
          : dayCards.filter((card) => Number(card.lateMinutes || 0) > 0 || String(card.status || '').includes('LATE')).length);
        absent.push(isToday ? Number(summary.absentToday || 0) : isFuture ? 0
          : dayCards.filter((card) => card.status === 'ABSENT').length);
      });
      chart.data.labels = labels;
      chart.data.datasets.forEach((dataset, index) => {
        dataset.data = index === 0 ? present : index === 1 ? late : absent;
      });
      const employeeTotal = Number(summary.totalEmployees ||
        (summary.presentToday + summary.absentToday + summary.excusedToday) || 1);
      const axisMaximum = Math.max(5, Math.ceil(employeeTotal / 5) * 5);
      chart.options.scales.y.max = axisMaximum;
      chart.options.scales.y.suggestedMax = axisMaximum;
      chart.options.scales.y.ticks.stepSize = axisMaximum <= 10 ? 1 : Math.ceil(axisMaximum / 5);
      const periodLabels = {
        daily: 'Selected Day', weekly: 'Last 7 Days', monthly: 'Full Month',
        first: 'Cutoff 1–15', second: 'Cutoff 16–End'
      };
      if ($('trendLabel')) $('trendLabel').textContent = `(${employeeTotal} Employees • ${periodLabels[activePeriod] || 'This Week'})`;
      chart.update();
    }
    document.querySelectorAll('.stat-comparison').forEach((note) => { note.textContent = 'Live server total'; });
    document.querySelectorAll('button, .table-footer').forEach((element) => {
      if (element.textContent.includes('pending records')) {
        const pendingTotal = summary.pendingFingerprintRegistrations + summary.pendingOfflineSync + verificationRecords.length;
        element.hidden = pendingTotal === 0;
        if (!element.hidden) element.childNodes[0].textContent = `View all ${pendingTotal} pending records `;
      }
      if (element.textContent.includes('Showing latest')) {
        element.innerHTML = `Showing latest ${Math.min(attendanceData.attendance?.length || 0, 8)} live records <span aria-hidden="true">&rarr;</span>`;
      }
    });
    const cutoffValues = [
      '—',
      String(summary.lateToday), String(summary.absentToday),
      `${summary.presentToday + summary.lateToday} verified today`
    ];
    document.querySelectorAll('.cutoff-box').forEach((box, boxIndex) => {
      box.querySelectorAll('.cutoff-detail strong').forEach((value, index) => {
        value.textContent = boxIndex === 0 ? cutoffValues[index] : '—';
      });
    });
    const liveAlerts = {
      'Missing Time Out': Number(summary.missingTimeOutToday || 0),
      'Duplicate Logs': 0,
      'Offline Device Sync': summary.pendingOfflineSync,
      'Pending Approvals': summary.pendingFingerprintRegistrations
    };
    document.querySelectorAll('.alert-item').forEach((item) => {
      const label = item.querySelector('.alert-text strong')?.textContent.trim();
      const number = item.querySelector('.alert-number');
      if (number && label in liveAlerts) number.textContent = liveAlerts[label];
    });
    document.body.classList.remove('live-dashboard-loading');
    document.body.classList.add('live-dashboard-ready');
    dashboardHasLoaded = true;
  }

  function bindLiveDashboardControls(refresh) {
    const main = document.querySelector('.main-content');
    if (!main || main.dataset.liveDashboardBound) return;
    main.dataset.liveDashboardBound = 'true';
    main.addEventListener('click', (event) => {
      const period = event.target.closest('.period-tab');
      if (period) {
        event.preventDefault();
        event.stopImmediatePropagation();
        document.querySelectorAll('.period-tab').forEach((tab) => tab.classList.toggle('active', tab === period));
        refresh();
        return;
      }
      const action = event.target.closest('#verifyRecordsButton, .quick-button, .open-modal[data-modal], .review-record');
      if (!action) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const modal = action.dataset.modal;
      const quick = action.dataset.action;
      if (action.classList.contains('review-record')) {
        const record = dashboardVerificationRecords.find((item) => item.id === action.dataset.recordId);
        if (!record) return toast('Attendance record was not found. Refresh the dashboard.');
        const modal = $('modalBackdrop');
        modal.dataset.modalMode = 'attendance-review';
        modal.dataset.recordId = record.id;
        if ($('modalTitle')) $('modalTitle').textContent = 'Review Attendance Record';
        if ($('modalMessage')) $('modalMessage').innerHTML = `<div class="dashboard-review-details">
          <div><span>Employee</span><strong>${esc(record.fullName || record.employeeName || 'Unknown')}</strong></div>
          <div><span>Attendance Type</span><strong>${esc(String(record.type || record.attendanceType || 'Emergency').replaceAll('_', ' '))}</strong></div>
          <div><span>Recorded Time</span><strong>${esc(when(record.timestamp || record.createdAt))}</strong></div>
          <div><span>Current Status</span><strong>${esc(record.reviewStatus === 'CORRECTION_REQUESTED' ? 'Correction Requested' : 'Needs Review')}</strong></div>
          <label><span>Review Notes</span><textarea id="dashboardReviewNotes" placeholder="Add review notes (optional)">${esc(record.reviewNotes || '')}</textarea></label>
        </div>`;
        if ($('modalCancel')) $('modalCancel').textContent = 'Request Correction';
        if ($('modalConfirm')) $('modalConfirm').textContent = 'Approve / Verify';
        modal.classList.add('show');
      } else if (action.id === 'verifyRecordsButton' || modal === 'queue' || modal === 'cutoff' || quick === 'Time Card') {
        location.assign('/timecard');
      } else if (modal === 'activity' || modal === 'alerts') {
        location.assign('/logs');
      } else if (quick === 'Employee') {
        location.assign('/employees?add=1');
      } else if (quick === 'Devices') {
        location.assign('/devices');
      } else if (quick === 'Export') {
        window.open('/api/timecard/export/pdf', '_blank', 'noopener');
      }
    }, true);
    const submitReview = (decision) => {
      const modal = $('modalBackdrop');
      if (modal?.dataset.modalMode !== 'attendance-review') return false;
      api('/api/attendance/review', { method: 'POST', body: JSON.stringify({
        id: modal.dataset.recordId, decision, notes: $('dashboardReviewNotes')?.value || '', reviewedBy: 'GWD Administrator'
      }) }).then(() => {
        modal.classList.remove('show');
        modal.dataset.modalMode = '';
        if ($('modalCancel')) $('modalCancel').textContent = 'Close';
        if ($('modalConfirm')) $('modalConfirm').textContent = 'Continue';
        toast(decision === 'VERIFIED' ? 'Attendance record verified.' : 'Correction requested.');
        refresh();
      }).catch((error) => toast(error.message));
      return true;
    };
    $('modalConfirm')?.addEventListener('click', (event) => {
      if (!submitReview('VERIFIED')) return;
      event.preventDefault(); event.stopImmediatePropagation();
    }, true);
    $('modalCancel')?.addEventListener('click', (event) => {
      if (!submitReview('CORRECTION_REQUESTED')) return;
      event.preventDefault(); event.stopImmediatePropagation();
    }, true);
    ['dateFilter', 'branchFilter'].forEach((id) => {
      $(id)?.addEventListener('change', (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        refresh();
      }, true);
    });
  }

  async function devicesLegacy() {
    const { readers } = await api('/api/readers');
    const body = $('deviceTableBody');
    if (!body) return;
    body.innerHTML = readers.length ? readers.map((reader, index) => `<tr data-id="${esc(reader.deviceId)}">
      <td>${index + 1}</td><td><strong>${esc(reader.source || 'ESP32 Reader')}</strong></td>
      <td>${esc(reader.deviceId)}</td><td>${esc(reader.location)}</td><td>${esc(reader.deviceIp || '—')}</td>
      <td><span class="status-badge ${reader.online ? 'online' : 'offline'}">${reader.online ? 'Online' : 'Offline'}</span></td>
      <td>${esc(when(reader.lastSeenAt))}</td><td>${esc(reader.firmwareVersion || '—')}</td>
      <td>${Number(reader.pendingOfflineLogs || 0)}</td><td><button class="action-button" type="button">Live</button></td>
    </tr>`).join('') : '<tr><td colspan="10">No ESP32 reader has connected yet.</td></tr>';
  }

  let liveDeviceReaders = [];

  function openLiveDeviceDetails(deviceId) {
    const reader = liveDeviceReaders.find((item) => item.deviceId === deviceId);
    const modal = $('detailsModal');
    if (!reader || !modal) return toast('Device details are unavailable.');
    const setText = (id, value) => { if ($(id)) $(id).textContent = value ?? '—'; };
    setText('detailsDeviceName', reader.source || 'ESP32-S3');
    setText('detailsDeviceId', reader.deviceId);
    setText('detailsDeviceType', reader.identityMode === 'FINGERPRINT_ONLY' ? 'Fingerprint Attendance Reader' : reader.identityMode || 'Attendance Reader');
    setText('detailsDeviceStatus', reader.online ? 'Online' : 'Offline');
    setText('detailsDeviceLocation', reader.location || 'Unassigned');
    setText('detailsDeviceIp', reader.deviceIp || '—');
    setText('detailsDeviceFirmware', reader.firmwareVersion || '—');
    setText('detailsDeviceLogs', Number(reader.logsToday || 0));
    setText('detailsDeviceLastSeen', reader.lastSeenAt ? when(reader.lastSeenAt) : 'Never');
    let capabilityBox = $('detailsDeviceCapabilities');
    if (!capabilityBox) {
      modal.querySelector('.modal-body')?.insertAdjacentHTML('beforeend', '<section class="live-device-capabilities" id="detailsDeviceCapabilities"></section>');
      capabilityBox = $('detailsDeviceCapabilities');
    }
    const labels = { fingerprintR503: 'R503 Fingerprint', oledSH1106: 'SH1106 OLED', rtcDS3231: 'DS3231 RTC', microSd: 'MicroSD', offlineStorage: 'Offline Storage', rgbLed: 'RGB LED', buzzer: 'Buzzer' };
    const capabilities = reader.capabilities || {};
    capabilityBox.innerHTML = `<h4>Detected Hardware</h4><div>${Object.entries(labels).map(([key, label]) =>
      `<span class="${capabilities[key] ? 'detected' : 'not-detected'}"><i></i>${label}<strong>${capabilities[key] ? 'Detected' : 'Not reported'}</strong></span>`).join('')}</div>`;
    modal.dataset.deviceId = reader.deviceId;
    modal.classList.add('show');
  }

  function renderDevices() {
    const body = $('deviceTableBody');
    if (!body) return;
    const search = ($('deviceSearch')?.value || '').trim().toLowerCase();
    const status = $('statusFilter')?.value || 'all';
    const location = $('locationFilter')?.value || 'all';
    const readers = liveDeviceReaders.filter((reader) => {
      const matchesSearch = !search || [reader.source, reader.deviceId, reader.location, reader.deviceIp].some((value) => String(value || '').toLowerCase().includes(search));
      const matchesStatus = status === 'all' || (status === 'Online' ? reader.online : status === 'Offline' ? !reader.online : Number(reader.pendingOfflineLogs || 0) > 0);
      return matchesSearch && matchesStatus && (location === 'all' || reader.location === location);
    });
    body.innerHTML = readers.length ? readers.map((reader, index) => `<tr data-id="${esc(reader.deviceId)}">
      <td>${index + 1}</td><td><div class="live-device-name"><span class="live-device-icon ${reader.online ? 'online' : 'offline'}"><i data-lucide="tablet-smartphone"></i></span><div><strong>${esc(reader.source || 'ESP32 Reader')}</strong><small>${esc(reader.identityMode === 'FINGERPRINT_ONLY' ? 'Fingerprint Reader' : reader.identityMode || 'Attendance Reader')}</small></div></div></td>
      <td>${esc(reader.deviceId)}</td><td>${esc(reader.location || 'Unassigned')}</td><td>${esc(reader.deviceIp || '—')}</td>
      <td><span class="status-badge ${reader.online ? 'online' : 'offline'}">${reader.online ? 'Online' : 'Offline'}</span></td>
      <td>${esc(when(reader.lastSeenAt))}</td><td>${esc(reader.firmwareVersion || '—')}</td>
      <td>${Number(reader.pendingOfflineLogs || 0)}</td><td><button class="action-button live-device-details" type="button">Details</button></td>
    </tr>`).join('') : '<tr><td colspan="10" class="empty-state">No devices match the current filters.</td></tr>';
    if ($('entriesInfo')) $('entriesInfo').textContent = readers.length ? `Showing ${readers.length} of ${liveDeviceReaders.length} device${liveDeviceReaders.length === 1 ? '' : 's'}` : `No matching devices (${liveDeviceReaders.length} total)`;
    const pagination = body.closest('.panel')?.querySelector('.pagination');
    if (pagination) { pagination.hidden = true; pagination.innerHTML = ''; }
    window.lucide?.createIcons();
  }

  async function devices() {
    const { readers } = await api('/api/readers');
    liveDeviceReaders = readers;
    const totals = {
      'Total Devices': readers.length,
      Online: readers.filter((reader) => reader.online).length,
      Offline: readers.filter((reader) => !reader.online).length,
      'Pending Sync': readers.reduce((sum, reader) => sum + Number(reader.pendingOfflineLogs || 0), 0),
      'Total Logs Today': readers.reduce((sum, reader) => sum + Number(reader.logsToday || 0), 0)
    };
    document.querySelectorAll('.page-devices .summary-card').forEach((card) => {
      const label = card.querySelector('h3')?.textContent.trim();
      const value = card.querySelector('.summary-info > strong');
      const note = card.querySelector('.summary-info > p');
      if (value && label in totals) value.textContent = totals[label].toLocaleString();
      if (note) note.textContent = label === 'Online' ? `${readers.length ? Math.round(totals.Online / readers.length * 100) : 0}% of devices` : label === 'Offline' ? `${readers.length ? Math.round(totals.Offline / readers.length * 100) : 0}% of devices` : label === 'Pending Sync' ? (totals['Pending Sync'] ? 'Needs attention' : 'All synchronized') : 'Live server total';
    });
    if ($('locationFilter')) $('locationFilter').innerHTML = `<option value="all">All Locations</option>${Array.from(new Set(readers.map((reader) => reader.location).filter(Boolean))).map((item) => `<option value="${esc(item)}">${esc(item)}</option>`).join('')}`;
    const typeControl = $('typeFilter')?.closest('.select-control');
    if (typeControl) typeControl.hidden = true;
    if ($('filterButton')) $('filterButton').hidden = true;
    if ($('refreshDevicesButton')) $('refreshDevicesButton').hidden = true;
    const addWrap = document.querySelector('.page-devices .add-device-wrap');
    if (addWrap) addWrap.innerHTML = '<button class="add-device-button live-refresh-devices" id="liveRefreshDevices" type="button"><i data-lucide="refresh-cw"></i> Refresh Devices</button>';
    if (!document.body.dataset.liveDevicesBound) {
      document.body.dataset.liveDevicesBound = 'true';
      ['deviceSearch', 'statusFilter', 'locationFilter'].forEach((id) => $(id)?.addEventListener(id === 'deviceSearch' ? 'input' : 'change', renderDevices, true));
      $('refreshDevicesButton')?.addEventListener('click', (event) => { event.preventDefault(); event.stopImmediatePropagation(); devices().catch((error) => toast(error.message)); }, true);
      $('deviceTableBody')?.addEventListener('click', (event) => {
        const button = event.target.closest('.live-device-details');
        if (!button) return;
        event.preventDefault(); event.stopImmediatePropagation();
        openLiveDeviceDetails(button.closest('tr')?.dataset.id || '');
      }, true);
      ['closeDetailsModal', 'closeDetailsButton'].forEach((id) => $(id)?.addEventListener('click', (event) => {
        event.preventDefault(); event.stopImmediatePropagation(); $('detailsModal')?.classList.remove('show');
      }, true));
      $('detailsModal')?.addEventListener('click', (event) => { if (event.target === $('detailsModal')) $('detailsModal').classList.remove('show'); }, true);
      $('syncDetailsButton')?.addEventListener('click', (event) => {
        event.preventDefault(); event.stopImmediatePropagation();
        devices().then(() => {
          const id = $('detailsModal')?.dataset.deviceId;
          if (id) openLiveDeviceDetails(id);
          toast('Device status refreshed from the latest heartbeat.');
        }).catch((error) => toast(error.message));
      }, true);
    }
    $('liveRefreshDevices')?.addEventListener('click', () => devices().catch((error) => toast(error.message)), { once: true });
    renderDevices();
  }

  const employeeProfilePhotos = {
    'james malit': '/images/employees/james-malit.jpg',
    'kian maximo': '/images/employees/kian-maximo.jpg',
    'airine sosa': '/images/employees/airine-sosa.jpg',
    'stephanie dapiaoen': '/images/employees/stephanie-dapiaoen.jpg',
    'diana corilla': '/images/employees/diana-corilla.jpg',
    'jethro villareal': '/images/employees/jethro-villareal.jpg',
    'pia suing': '/images/employees/pia-suing.jpg',
    'jun claude cabral': '/images/employees/jun-claude-cabral.jpg',
    'shawn kyle cabangis': '/images/employees/shawn-kyle-cabangis.jpg'
  };
  const employeeAvatar = (employee) => {
    const photo = employee.photoUrl || employeeProfilePhotos[String(employee.fullName || '').trim().toLowerCase()];
    const initials = String(employee.fullName || '?').split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
    return photo ? `<img src="${esc(photo)}" alt="${esc(employee.fullName)} profile photo" loading="lazy" data-employee-avatar><span hidden>${esc(initials)}</span>` : `<span>${esc(initials)}</span>`;
  };
  document.addEventListener('error', (event) => {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !image.matches('[data-employee-avatar]')) return;
    image.hidden = true;
    if (image.nextElementSibling) image.nextElementSibling.hidden = false;
  }, true);
  const employeeIdentity = (employee, options = {}) => {
    const active = employee?.active !== false;
    const status = options.status || (active ? 'Active' : 'Inactive');
    return `<span class="shared-employee-identity">
      <span class="shared-employee-avatar">${employeeAvatar(employee || { fullName: options.name || 'Unknown' })}</span>
      <span class="shared-employee-name"><strong>${esc(employee?.fullName || options.name || 'Unknown')}</strong><small><i class="account-indicator ${active ? 'active' : 'inactive'}"></i>${esc(status)}</small></span>
    </span>`;
  };

  let attendancePopupLastId = null;
  let attendancePopupInitialized = false;
  let attendancePopupTimer = null;
  const attendanceNotificationAudio = new Audio('/sounds/attendance-popup-notification.mp3');
  attendanceNotificationAudio.preload = 'auto';
  attendanceNotificationAudio.volume = 0.82;
  document.addEventListener('pointerdown', () => {
    attendanceNotificationAudio.muted = true;
    attendanceNotificationAudio.play().then(() => {
      attendanceNotificationAudio.pause();
      attendanceNotificationAudio.currentTime = 0;
      attendanceNotificationAudio.muted = false;
    }).catch(() => { attendanceNotificationAudio.muted = false; });
  }, { once: true, capture: true });

  function playAttendanceNotification() {
    if (localStorage.getItem('gwdAttendanceSound') === 'off') return Promise.resolve();
    attendanceNotificationAudio.pause();
    attendanceNotificationAudio.currentTime = 0;
    attendanceNotificationAudio.volume = 0.82;
    return attendanceNotificationAudio.play().catch(() => null);
  }

  function ensureAttendancePopup() {
    let popup = $('liveAttendancePopup');
    if (popup) return popup;
    document.body.insertAdjacentHTML('beforeend', `<div class="live-attendance-popup-backdrop" id="liveAttendancePopup">
      <article class="live-attendance-popup"><button type="button" class="live-popup-close" id="livePopupClose" aria-label="Close">&times;</button>
        <div class="live-popup-accent"></div>
        <header class="live-popup-header"><span class="live-popup-success"><i data-lucide="check"></i></span><div><span class="live-popup-kicker">ESP32-S3 ATTENDANCE</span><strong id="livePopupHeadline">Scan recorded successfully</strong></div></header>
        <div class="live-popup-person"><div class="live-popup-avatar" id="livePopupAvatar"></div><div class="live-popup-person-copy"><h2 id="livePopupName">Employee</h2><div class="live-popup-account"><i></i> Active account</div></div></div>
        <div class="live-popup-type-row"><div class="live-popup-type" id="livePopupType">TIME IN</div><span class="live-popup-status" id="livePopupStatus">ON TIME</span><span class="live-popup-demo" id="livePopupDemo">PREVIEW</span></div>
        <div class="live-popup-details"><div><span>Time</span><strong class="live-popup-time" id="livePopupTime">--:--</strong></div><div><span>Date</span><strong id="livePopupDate">--</strong></div><div><span>Source</span><strong id="livePopupDevice">ESP32-S3</strong></div></div>
        <p id="livePopupMessage">Attendance recorded successfully.</p>
        <div class="live-popup-countdown"><span></span></div>
      </article></div>`);
    popup = $('liveAttendancePopup');
    $('livePopupClose')?.addEventListener('click', () => popup.classList.remove('show'));
    popup.addEventListener('click', (event) => { if (event.target === popup) popup.classList.remove('show'); });
    return popup;
  }

  function showAttendancePopup(record, demo = false) {
    if (!demo && localStorage.getItem('gwdAttendancePopup') === 'off') return;
    const popup = ensureAttendancePopup();
    const name = record.fullName || record.employeeName || 'Employee';
    const type = String(record.type || record.attendanceType || 'TIME_IN').toUpperCase().replaceAll('_', ' ');
    const isOut = type.includes('OUT');
    const rawStatus = String(record.status || record.statusText || record.manualStatus?.status || '').toUpperCase().replaceAll('_', ' ');
    const isEmergency = rawStatus.includes('EMERGENCY') || String(record.message || '').toUpperCase().includes('EMERGENCY');
    const lateMinutes = Math.max(0, Number(record.lateMinutes || 0));
    const isLate = !isOut && (lateMinutes > 0 || rawStatus.includes('LATE'));
    const theme = isEmergency ? 'emergency' : isLate ? 'late' : isOut ? 'time-out' : 'on-time';
    popup.classList.remove('time-out', 'theme-on-time', 'theme-late', 'theme-emergency');
    popup.classList.add(`theme-${theme}`);
    popup.classList.toggle('time-out', isOut);
    popup.classList.toggle('demo', demo);
    const occurredAt = new Date(record.timestamp || record.createdAt || Date.now());
    const popupEmployee = liveEmployeeRecords?.find((employee) => employee.id === record.employeeId);
    if ($('livePopupAvatar')) $('livePopupAvatar').innerHTML = employeeAvatar(popupEmployee || { fullName: name, photoUrl: record.photoUrl });
    if ($('livePopupName')) $('livePopupName').textContent = name;
    if ($('livePopupType')) $('livePopupType').textContent = type;
    if ($('livePopupHeadline')) $('livePopupHeadline').textContent = isEmergency ? 'Emergency attendance recorded' : isLate ? 'Attendance recorded with warning' : isOut ? 'Time out recorded successfully' : 'Scan recorded successfully';
    if ($('livePopupStatus')) $('livePopupStatus').textContent = isEmergency ? 'EMERGENCY' : isLate ? (lateMinutes ? `LATE BY ${lateMinutes}M` : 'LATE') : isOut ? 'TIME OUT SAVED' : 'ON TIME';
    if ($('livePopupTime')) $('livePopupTime').textContent = occurredAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if ($('livePopupDate')) $('livePopupDate').textContent = occurredAt.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
    if ($('livePopupDevice')) $('livePopupDevice').textContent = record.deviceId || record.readerId || 'ESP32-S3';
    if ($('livePopupDemo')) $('livePopupDemo').hidden = !demo;
    if ($('livePopupMessage')) $('livePopupMessage').textContent = demo ? 'Preview only — no attendance record was created.' : (record.message || `${type} recorded successfully.`);
    popup.classList.remove('show');
    requestAnimationFrame(() => popup.classList.add('show'));
    playAttendanceNotification();
    window.lucide?.createIcons();
    clearTimeout(attendancePopupTimer);
    attendancePopupTimer = setTimeout(() => popup.classList.remove('show'), 6500);
  }

  async function startAttendancePopupMonitor() {
    try {
      const { attendance } = await api('/api/attendance?limit=1');
      attendancePopupLastId = attendance[0]?.id || null;
    } catch (_) {}
    attendancePopupInitialized = true;
    setInterval(async () => {
      try {
        const { attendance } = await api('/api/attendance?limit=1');
        const newest = attendance[0];
        if (newest?.id && attendancePopupInitialized && newest.id !== attendancePopupLastId) showAttendancePopup(newest);
        if (newest?.id) attendancePopupLastId = newest.id;
      } catch (_) {}
    }, 2200);
  }

  const employeeRow = (employee, index) => `<div class="employee-list-row" data-id="${esc(employee.id)}">
    <span class="employee-row-avatar">${employeeAvatar(employee)}</span><strong>${esc(employee.fullName)}</strong><span>${esc(employee.employeeCode || `FP ${employee.fingerprintId ?? 'Unlinked'}`)}</span>
    <span>${esc(employee.shiftStart)} - ${esc(employee.shiftEnd)}</span><span>${employee.fingerprints?.length || 0} fingerprint(s)</span>
    <span class="status-badge ${employee.active ? 'active' : 'inactive'}">${employee.active ? 'Active' : 'Inactive'}</span>
  </div>`;

  let liveEmployeeRecords = [];
  let liveEmployeeReaders = [];
  let liveEmployeePendingFingerprints = [];
  let editingEmployeeId = null;
  let employeeScanTimer = null;
  let employeePreviewTimer = null;
  let employeeStagedFingerprints = [];
  const employeeScheduleDays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

  function employeeFormMarkup(employee) {
    const schedule = employee?.weeklySchedule || {};
    const rows = employeeScheduleDays.map((day) => {
      const item = schedule[day] || { dayOff: day === 'sunday', timeIn: '09:00', timeOut: '18:00' };
      const label = day[0].toUpperCase() + day.slice(1);
      return `<div class="employee-schedule-row" data-day="${day}">
        <strong>${label}</strong>
        <label class="day-off-toggle"><input type="checkbox" data-schedule-off ${item.dayOff ? 'checked' : ''}><span>Day Off</span></label>
        <input type="time" data-schedule-in value="${esc(item.timeIn || '09:00')}" ${item.dayOff ? 'disabled' : ''}>
        <input type="time" data-schedule-out value="${esc(item.timeOut || '18:00')}" ${item.dayOff ? 'disabled' : ''}>
      </div>`;
    }).join('');
    const onlineReaders = liveEmployeeReaders.filter((reader) => reader.online);
    const linkedFingerprints = Array.from(new Set([
      ...(employee?.fingerprints || []).map((item) => Number(item.fingerprintId)),
      Number(employee?.fingerprintId)
    ].filter((id) => Number.isInteger(id) && id > 0)));
    return `<div class="employee-modal-fields">
      <section class="employee-edit-profile">
        <span class="employee-edit-avatar">${employeeAvatar(employee || { fullName: 'New Employee' })}</span>
        <div class="employee-edit-profile-copy">
          <strong id="employeeEditProfileName">${esc(employee?.fullName || 'New Employee')}</strong>
          <span id="employeeEditProfileCode">${esc(employee?.employeeCode || (employee?.id ? employee.id.slice(-8) : 'Employee ID will be auto-generated'))}</span>
        </div>
        <span id="employeeEditAccountState" class="employee-edit-account-state ${employee?.active === false ? 'inactive' : 'active'}">
          <i></i>${employee?.active === false ? 'Inactive Account' : 'Active Account'}
        </span>
      </section>
      <label><span>Employee ID</span><input id="newEmployeeCode" type="text" value="${esc(employee?.employeeCode || (employee?.id ? employee.id.slice(-8) : 'Auto-generated after save'))}" readonly aria-readonly="true"><small>The server automatically assigns a unique 8-character Employee ID.</small></label>
      <label><span>Full Name</span><input id="newFullName" type="text" placeholder="e.g. Juan Dela Cruz" value="${esc(employee?.fullName || '')}" required></label>
      <section class="employee-fingerprint-box">
        <div><span>Fingerprints</span><strong id="employeeFingerprintStatus">${linkedFingerprints.length ? `${linkedFingerprints.length} linked finger${linkedFingerprints.length === 1 ? '' : 's'}` : 'No fingerprint linked'}</strong></div>
        <div class="employee-fingerprint-list" id="employeeFingerprintList">${linkedFingerprints.length ? linkedFingerprints.map((id, index) => `<span class="employee-fingerprint-chip ${index === 0 ? 'primary' : ''}"><i data-lucide="fingerprint"></i><b>Fingerprint ID ${id}</b>${index === 0 ? '<small>Primary</small>' : ''}<button type="button" data-remove-fingerprint="${id}" aria-label="Remove fingerprint ID ${id}" title="Remove fingerprint only">&times; Remove</button></span>`).join('') : '<span class="employee-fingerprint-empty">Scan a finger to add it here.</span>'}</div>
        <select id="employeeScanDevice">${onlineReaders.length ? onlineReaders.map((reader) => `<option value="${esc(reader.deviceId)}">${esc(reader.deviceId)} — Online</option>`).join('') : '<option value="">No online ESP32-S3</option>'}</select>
        <button id="scanEmployeeFingerprint" type="button" ${onlineReaders.length ? '' : 'disabled'}><i data-lucide="plus"></i> Add Another Fingerprint</button>
        <div class="employee-pending-link" ${liveEmployeePendingFingerprints.length ? '' : 'hidden'}>
          <select id="employeePendingFingerprint">${liveEmployeePendingFingerprints.map((request) => `<option value="${esc(request.fingerprintId)}">Unassigned Fingerprint ID ${esc(request.fingerprintId)} — ${esc(request.deviceId || request.lastDeviceId || 'ESP32-S3')}</option>`).join('')}</select>
          <button id="linkPendingFingerprint" type="button"><i data-lucide="link"></i> Add Scanned Fingerprint</button>
        </div>
      </section>
      <section class="employee-weekly-schedule"><h4>Weekly Schedule</h4>${rows}<p>Set Day Off kapag walang pasok. Kapag working day, kailangan ang Time In at Time Out.</p></section>
      <label><span>Status</span><select id="newStatus"><option>Active</option><option>Inactive</option></select></label>
    </div>`;
  }

  function renderEmployeeFingerprintList() {
    const employee = liveEmployeeRecords.find((record) => record.id === editingEmployeeId);
    const existing = Array.from(new Set([
      ...(employee?.fingerprints || []).map((item) => Number(item.fingerprintId)),
      Number(employee?.fingerprintId)
    ].filter((id) => Number.isInteger(id) && id > 0)));
    const allIds = Array.from(new Set([...existing, ...employeeStagedFingerprints]));
    if ($('employeeFingerprintStatus')) $('employeeFingerprintStatus').textContent = allIds.length ? `${allIds.length} linked finger${allIds.length === 1 ? '' : 's'}` : 'No fingerprint linked';
    if ($('employeeFingerprintList')) $('employeeFingerprintList').innerHTML = allIds.length
      ? allIds.map((id, index) => `<span class="employee-fingerprint-chip ${index === 0 ? 'primary' : ''} ${employeeStagedFingerprints.includes(id) ? 'new' : ''}"><i data-lucide="fingerprint"></i><b>Fingerprint ID ${id}</b>${index === 0 ? '<small>Primary</small>' : ''}${employeeStagedFingerprints.includes(id) ? '<small>New</small>' : ''}<button type="button" data-remove-fingerprint="${id}" aria-label="Remove fingerprint ID ${id}" title="Remove fingerprint only">&times; Remove</button></span>`).join('')
      : '<span class="employee-fingerprint-empty">Scan a finger to add it here.</span>';
    window.lucide?.createIcons();
  }

  function ensureEmployeeScanModal() {
    let modal = $('employeeScanModal');
    if (modal) return modal;
    document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop employee-scan-backdrop" id="employeeScanModal">
      <div class="employee-scan-card"><div class="employee-scan-animation"><i data-lucide="fingerprint"></i></div>
      <h3 id="employeeScanTitle">Scan Fingerprint</h3><p id="employeeScanMessage">Place the finger on the ESP32-S3 scanner.</p>
      <div class="employee-scan-progress"><span></span></div><strong class="employee-scan-percent" id="employeeScanPercent">0%</strong><button type="button" id="cancelEmployeeScan">Cancel Scan</button></div></div>`);
    modal = $('employeeScanModal');
    $('cancelEmployeeScan')?.addEventListener('click', () => {
      clearTimeout(employeeScanTimer); employeeScanTimer = null;
      clearTimeout(enrollmentScanTimer); enrollmentScanTimer = null;
      clearTimeout(employeePreviewTimer); employeePreviewTimer = null;
      modal.classList.remove('show', 'scan-success', 'scan-failed', 'scan-preview-progress');
    });
    window.lucide?.createIcons();
    return modal;
  }

  function startScanPreviewSequence(result) {
    clearInterval(employeePreviewTimer);
    const modal = ensureEmployeeScanModal();
    const progress = modal.querySelector('.employee-scan-progress span');
    const percent = $('employeeScanPercent');
    modal.classList.remove('scan-success', 'scan-failed');
    modal.classList.add('show', 'scan-preview-progress');
    if (progress) progress.style.width = '1%';
    if (percent) percent.textContent = '1%';
    if ($('employeeScanTitle')) $('employeeScanTitle').textContent = 'Verifying Fingerprint';
    if ($('employeeScanMessage')) $('employeeScanMessage').textContent = 'Keep your finger on the ESP32-S3 scanner while your fingerprint is being verified.';
    if ($('cancelEmployeeScan')) $('cancelEmployeeScan').textContent = 'Close Preview';
    let value = 1;
    const target = result === 'failed' ? 43 : 100;
    employeePreviewTimer = setInterval(() => {
      value = Math.min(target, value + 1);
      if (progress) progress.style.width = `${value}%`;
      if (percent) percent.textContent = `${value}%`;
      if (value < target) return;
      clearInterval(employeePreviewTimer);
      employeePreviewTimer = setTimeout(() => {
        employeePreviewTimer = null;
        if (!modal.classList.contains('show')) return;
        if (result === 'success') modal.classList.remove('scan-preview-progress');
        modal.classList.add(result === 'success' ? 'scan-success' : 'scan-failed');
        if ($('employeeScanTitle')) $('employeeScanTitle').textContent = result === 'success' ? 'Fingerprint Verified' : 'Verification Failed';
        if ($('employeeScanMessage')) $('employeeScanMessage').textContent = result === 'success'
          ? 'Fingerprint matched successfully. Attendance is ready to be recorded.'
          : 'Fingerprint could not be verified. Clean the sensor and try again.';
        if (progress && result === 'success') progress.style.width = '';
      }, 180);
    }, 24);
  }

  function beginHardwareScanProgress(modal) {
    if (modal.classList.contains('scan-preview-progress')) return;
    clearInterval(employeePreviewTimer);
    const progress = modal.querySelector('.employee-scan-progress span');
    const percent = $('employeeScanPercent');
    let value = 1;
    modal.classList.add('scan-preview-progress');
    if (progress) progress.style.width = '1%';
    if (percent) percent.textContent = '1%';
    if ($('employeeScanTitle')) $('employeeScanTitle').textContent = 'Verifying Fingerprint';
    if ($('employeeScanMessage')) $('employeeScanMessage').textContent = 'Finger detected. Keep it steady while the R503 verifies the fingerprint.';
    employeePreviewTimer = setInterval(() => {
      value = Math.min(95, value + 1);
      if (progress) progress.style.width = `${value}%`;
      if (percent) percent.textContent = `${value}%`;
    }, 24);
  }

  function finishHardwareScanProgress(modal) {
    clearInterval(employeePreviewTimer); employeePreviewTimer = null;
    const progress = modal.querySelector('.employee-scan-progress span');
    if (progress) progress.style.width = '100%';
    if ($('employeeScanPercent')) $('employeeScanPercent').textContent = '100%';
  }

  function failHardwareScanProgress(modal, message = 'Fingerprint detection was interrupted. Keep your finger steady and try again.') {
    clearInterval(employeePreviewTimer); employeePreviewTimer = null;
    modal.classList.remove('scan-success');
    modal.classList.add('scan-failed');
    if ($('employeeScanTitle')) $('employeeScanTitle').textContent = 'Verification Failed';
    if ($('employeeScanMessage')) $('employeeScanMessage').textContent = message;
    if ($('cancelEmployeeScan')) $('cancelEmployeeScan').textContent = 'Close';
  }

  async function startEmployeeFingerprintScan(event) {
    event.preventDefault(); event.stopImmediatePropagation();
    const deviceId = $('employeeScanDevice')?.value;
    const reader = liveEmployeeReaders.find((item) => item.deviceId === deviceId && item.online);
    if (!reader) return toast('No online ESP32-S3 reader is available.');
    clearTimeout(employeeScanTimer);
    clearInterval(employeePreviewTimer); employeePreviewTimer = null;
    const { pending: before } = await api('/api/fingerprints/pending');
    const existingIds = new Set(before.map((item) => item.id));
    await api('/api/fingerprints/start-enrollment', { method: 'POST', body: JSON.stringify({ deviceId }) });
    const modal = ensureEmployeeScanModal();
    modal.classList.remove('scan-preview-progress');
    if ($('employeeScanTitle')) $('employeeScanTitle').textContent = 'Waiting for Fingerprint';
    if ($('employeeScanMessage')) $('employeeScanMessage').textContent = `Place a finger on ${deviceId}. Loading starts only after the R503 detects it.`;
    modal.classList.remove('scan-success', 'scan-failed');
    modal.classList.add('show');
    const scanRequestedAt = Date.now();
    let attempts = 0;
    const poll = async () => {
      attempts += 1;
      try {
        const [{ pending }, { readers }] = await Promise.all([api('/api/fingerprints/pending'), api('/api/readers')]);
        const activeReader = readers.find((item) => item.deviceId === deviceId);
        const fingerDetected = activeReader?.fingerprintDetectedAt && new Date(activeReader.fingerprintDetectedAt).getTime() >= scanRequestedAt;
        if (fingerDetected) beginHardwareScanProgress(modal);
        const statusIsCurrent = activeReader?.fingerprintScanStatusAt && new Date(activeReader.fingerprintScanStatusAt).getTime() >= scanRequestedAt;
        if (statusIsCurrent && activeReader.fingerprintScanStatus === 'FAILED') {
          failHardwareScanProgress(modal);
          employeeScanTimer = null;
          return;
        }
        const result = pending.find((item) => !existingIds.has(item.id) && (!item.deviceId || item.deviceId === deviceId));
        if (result?.fingerprintId) {
          finishHardwareScanProgress(modal);
          clearTimeout(employeeScanTimer); employeeScanTimer = null;
          const fingerprintId = Number(result.fingerprintId);
          const employee = liveEmployeeRecords.find((record) => record.id === editingEmployeeId);
          const alreadyLinked = (employee?.fingerprints || []).some((item) => Number(item.fingerprintId) === fingerprintId) || Number(employee?.fingerprintId) === fingerprintId;
          if (!alreadyLinked && !employeeStagedFingerprints.includes(fingerprintId)) employeeStagedFingerprints.push(fingerprintId);
          renderEmployeeFingerprintList();
          if ($('employeeScanTitle')) $('employeeScanTitle').textContent = 'Fingerprint Captured';
          if ($('employeeScanMessage')) $('employeeScanMessage').textContent = alreadyLinked ? `Fingerprint ID ${fingerprintId} is already linked to this employee.` : `Fingerprint ID ${fingerprintId} was added. You may scan another finger or save the employee.`;
          modal.classList.add('scan-success');
          setTimeout(() => modal.classList.remove('show', 'scan-success'), 1000);
          return;
        }
      } catch (error) {
        if ($('employeeScanMessage')) $('employeeScanMessage').textContent = error.message;
      }
      if (attempts >= 80) {
        if ($('employeeScanTitle')) $('employeeScanTitle').textContent = 'Scan Timed Out';
        if ($('employeeScanMessage')) $('employeeScanMessage').textContent = 'No fingerprint response was received from the ESP32-S3.';
        return;
      }
      employeeScanTimer = setTimeout(poll, 1500);
    };
    employeeScanTimer = setTimeout(poll, 900);
  }

  function ensureEmployeeEditorControls() {
    const modal = $('employeeModal');
    const footer = modal?.querySelector('.modal-footer');
    if (!modal || !footer) return null;

    let deleteButton = $('deleteEmployeeFromEditorButton');
    if (!deleteButton) {
      deleteButton = document.createElement('button');
      deleteButton.id = 'deleteEmployeeFromEditorButton';
      deleteButton.type = 'button';
      deleteButton.className = 'modal-button danger employee-delete-button';
      deleteButton.innerHTML = '<i data-lucide="trash-2"></i><span>Delete Employee</span>';
      footer.insertBefore(deleteButton, footer.firstChild);
    }

    deleteButton.style.setProperty('margin-right', 'auto');
    return deleteButton;
  }

  function closeEmployeeEditor() {
    clearTimeout(employeeScanTimer);
    employeeScanTimer = null;
    clearInterval(employeePreviewTimer);
    employeePreviewTimer = null;
    employeeStagedFingerprints = [];
    editingEmployeeId = null;
    $('employeeModal')?.classList.remove('show');
  }

  async function deleteEmployeeFromEditor(button) {
    if (!editingEmployeeId) return;

    const employee = liveEmployeeRecords.find((record) => record.id === editingEmployeeId);
    const employeeName = employee?.fullName || employee?.employeeCode || editingEmployeeId;

    if (!window.confirm(`Delete ${employeeName}? This permanently removes the employee profile and cannot be undone.`)) {
      return;
    }

    button.disabled = true;
    const originalHtml = button.innerHTML;
    button.innerHTML = '<i data-lucide="loader-circle"></i> Deleting...';
    refreshLucideIcons();

    try {
      const result = await api(`/api/employees/${encodeURIComponent(editingEmployeeId)}`, {
        method: 'DELETE'
      });

      closeEmployeeEditor();
      toast(result.message || `${employeeName} deleted.`);
      await employees();
    } catch (error) {
      button.disabled = false;
      button.innerHTML = originalHtml;
      refreshLucideIcons();
      toast(error.message);
    }
  }

  function setEmployeeModalMode(employee = null) {
    editingEmployeeId = employee?.id || null;
    employeeStagedFingerprints = [];
    const modal = $('employeeModal');
    if (!modal) return;
    const title = modal.querySelector('.modal-header h3');
    const saveButton = $('saveEmployeeButton');
    if ($('employeeForm')) $('employeeForm').innerHTML = employeeFormMarkup(employee);
    if ($('newStatus')) $('newStatus').value = employee?.active === false ? 'Inactive' : 'Active';
    if (title) title.textContent = employee ? 'Edit Employee' : 'Add Employee';
    if (saveButton) saveButton.textContent = employee ? 'Save Changes' : 'Save Employee';

    const deleteButton = ensureEmployeeEditorControls();
    if (deleteButton) {
      const editing = Boolean(employee);
      deleteButton.hidden = !editing;
      deleteButton.disabled = false;
      deleteButton.style.setProperty('display', editing ? 'inline-flex' : 'none', 'important');
      deleteButton.style.setProperty('align-items', 'center');
      deleteButton.style.setProperty('gap', '7px');
      deleteButton.style.setProperty('margin-right', 'auto');
    }

    modal.classList.add('show');
    refreshLucideIcons();
    const refreshProfilePreview = () => {
      const statusActive = $('newStatus')?.value !== 'Inactive';
      const state = $('employeeEditAccountState');
      if ($('employeeEditProfileName')) $('employeeEditProfileName').textContent = $('newFullName')?.value.trim() || 'New Employee';
      if ($('employeeEditProfileCode')) $('employeeEditProfileCode').textContent = employee?.employeeCode || (employee?.id ? employee.id.slice(-8) : 'Employee ID will be auto-generated');
      if (state) {
        state.className = `employee-edit-account-state ${statusActive ? 'active' : 'inactive'}`;
        state.innerHTML = `<i></i>${statusActive ? 'Active Account' : 'Inactive Account'}`;
      }
    };
    $('newStatus')?.addEventListener('change', refreshProfilePreview);
    $('newFullName')?.addEventListener('input', refreshProfilePreview);
  }

  function bindEmployeeEditing() {
    const page = document.querySelector('.page-employees') || document.body;
    if (page.dataset.liveEmployeeEditing) return;
    page.dataset.liveEmployeeEditing = 'true';
    page.addEventListener('click', async (event) => {
      const closeButton = event.target.closest('#closeEmployeeModal, #cancelEmployeeModal');
      if (closeButton) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeEmployeeEditor();
        return;
      }

      if (event.target === $('employeeModal')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeEmployeeEditor();
        return;
      }

      const deleteEmployeeButton = event.target.closest('#deleteEmployeeFromEditorButton');
      if (deleteEmployeeButton) {
        event.preventDefault();
        event.stopImmediatePropagation();
        await deleteEmployeeFromEditor(deleteEmployeeButton);
        return;
      }

      const removeFingerprintButton = event.target.closest('[data-remove-fingerprint]');
      if (removeFingerprintButton) {
        event.preventDefault();
        event.stopImmediatePropagation();
        removeEmployeeFingerprint(Number(removeFingerprintButton.dataset.removeFingerprint), removeFingerprintButton)
          .catch((error) => toast(error.message));
        return;
      }
      if (event.target.closest('#scanEmployeeFingerprint')) {
        startEmployeeFingerprintScan(event).catch((error) => toast(error.message));
        return;
      }
      if (event.target.closest('#linkPendingFingerprint')) {
        event.preventDefault(); event.stopImmediatePropagation();
        const fingerprintId = Number($('employeePendingFingerprint')?.value);
        if (fingerprintId > 0 && !employeeStagedFingerprints.includes(fingerprintId)) employeeStagedFingerprints.push(fingerprintId);
        renderEmployeeFingerprintList();
        toast(`Fingerprint ID ${fingerprintId} will be linked when you save the employee.`);
        return;
      }
      const dayOff = event.target.closest('[data-schedule-off]');
      if (dayOff) {
        const row = dayOff.closest('.employee-schedule-row');
        row?.querySelectorAll('input[type="time"]').forEach((input) => { input.disabled = dayOff.checked; });
        return;
      }
      const card = event.target.closest('.employee-card[data-id], .employee-list-row[data-id]');
      if (!card) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const employee = liveEmployeeRecords.find((record) => record.id === card.dataset.id);
      if (employee) setEmployeeModalMode(employee);
    }, true);
    $('addEmployeeButton')?.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      setEmployeeModalMode();
    }, true);
    $('saveEmployeeButton')?.addEventListener('click', saveEmployee, true);

    ensureEmployeeEditorControls();

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && $('employeeModal')?.classList.contains('show')) {
        event.preventDefault();
        closeEmployeeEditor();
      }
    }, true);
  }

  async function removeEmployeeFingerprint(fingerprintId, button) {
    if (!Number.isInteger(fingerprintId) || fingerprintId < 1) return;
    if (employeeStagedFingerprints.includes(fingerprintId)) {
      employeeStagedFingerprints = employeeStagedFingerprints.filter((id) => id !== fingerprintId);
      renderEmployeeFingerprintList();
      toast(`Unsaved fingerprint ID ${fingerprintId} removed.`);
      return;
    }
    if (!editingEmployeeId) return toast('Save the employee before removing a linked fingerprint.');
    if (!window.confirm(`Remove fingerprint ID ${fingerprintId} only? The employee, account, schedule, and attendance history will remain.`)) return;
    button.disabled = true;
    try {
      const result = await api(`/api/employees/${encodeURIComponent(editingEmployeeId)}/fingerprints/${encodeURIComponent(fingerprintId)}`, { method: 'DELETE' });
      const index = liveEmployeeRecords.findIndex((employee) => employee.id === editingEmployeeId);
      if (index >= 0 && result.employee) liveEmployeeRecords[index] = result.employee;
      renderEmployeeFingerprintList();
      toast(result.message || `Fingerprint ID ${fingerprintId} removed.`);
    } finally {
      button.disabled = false;
    }
  }

  function bindEmployeeViewControls() {
    const gridButton = $('gridViewButton');
    const listButton = $('listViewButton');
    const grid = $('gridView');
    const list = $('listView');
    if (!gridButton || !listButton || !grid || !list || gridButton.dataset.liveBound) return;
    gridButton.dataset.liveBound = 'true';
    listButton.dataset.liveBound = 'true';
    const showEmployeeView = (showGrid) => {
      grid.hidden = !showGrid;
      list.hidden = showGrid;
      grid.classList.toggle('live-view-visible', showGrid);
      grid.classList.toggle('live-view-hidden', !showGrid);
      list.classList.toggle('live-view-visible', !showGrid);
      list.classList.toggle('live-view-hidden', showGrid);
      grid.style.setProperty('display', showGrid ? 'block' : 'none', 'important');
      list.style.setProperty('display', showGrid ? 'none' : 'block', 'important');
    };
    gridButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      showEmployeeView(true);
      gridButton.classList.add('active');
      listButton.classList.remove('active');
    }, true);
    listButton.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
      showEmployeeView(false);
      listButton.classList.add('active');
      gridButton.classList.remove('active');
      if ($('listRows')) $('listRows').innerHTML = liveEmployeeRecords.map(employeeRow).join('') || '<div class="empty-state">No employees yet.</div>';
    }, true);
  }

  async function employees() {
    const [{ employees: records }, { readers }, { pending }] = await Promise.all([api('/api/employees'), api('/api/readers'), api('/api/fingerprints/pending')]);
    liveEmployeeReaders = readers;
    liveEmployeePendingFingerprints = pending || [];
    liveEmployeeRecords = records;
    const pageSize = 20;
    const pageCount = Math.ceil(records.length / pageSize);
    if ($('employeeCountText')) $('employeeCountText').textContent = `${records.length} employee${records.length === 1 ? '' : 's'}`;
    const pagination = document.querySelector('.pagination-buttons');
    if (pagination) {
      pagination.hidden = pageCount <= 1;
      if (pageCount > 1) {
        pagination.innerHTML = `<button class="page-button" type="button" aria-label="Previous page" disabled>‹</button>${
          Array.from({ length: pageCount }, (_, index) => `<button class="page-button ${index === 0 ? 'active' : ''}" type="button" data-live-page="${index + 1}">${index + 1}</button>`).join('')
        }<button class="page-button" type="button" aria-label="Next page">›</button>`;
      }
    }
    if ($('listRows')) $('listRows').innerHTML = records.map(employeeRow).join('') || '<div class="empty-state">No employees yet.</div>';
    if ($('gridView')) {
      $('gridView').innerHTML = `<section class="employee-section live-employee-section">
        <div class="employee-grid">${records.map((employee) => {
          return `<article class="employee-card" data-id="${esc(employee.id)}">
            <div class="profile-photo-wrap live-avatar">${employeeAvatar(employee)}</div>
            <h4>${esc(employee.fullName)}</h4>
            <div class="employee-meta"><span>Fingerprint: ${esc(employee.fingerprintId ?? 'Not linked')}</span><i></i><span>${employee.fingerprints?.length || 0} finger(s)</span></div>
            <p class="employee-position">Employee</p>
            <p class="employee-department">Attendance</p>
            <div class="employee-schedule">${esc(employee.shiftStart)} - ${esc(employee.shiftEnd)}</div>
            <span class="status-badge ${employee.active ? 'active' : 'inactive'}">${employee.active ? 'Active' : 'Inactive'}</span>
          </article>`;
        }).join('')}</div>
      </section>`;
    }
    bindEmployeeViewControls();
    bindEmployeeEditing();
    if (new URLSearchParams(location.search).get('add') === '1' && !document.body.dataset.addEmployeeOpened) {
      document.body.dataset.addEmployeeOpened = 'true';
      setEmployeeModalMode();
      history.replaceState(null, '', '/employees');
    }
  }

  async function saveEmployee(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const fullName = $('newFullName')?.value.trim() || '';
    const employeeCode = editingEmployeeId
      ? (liveEmployeeRecords.find((employee) => employee.id === editingEmployeeId)?.employeeCode || '')
      : '';
    if (!fullName) return toast('Full name is required.');
    const primaryFingerprintId = employeeStagedFingerprints[0];
    const weeklySchedule = {};
    document.querySelectorAll('.employee-schedule-row').forEach((row) => {
      weeklySchedule[row.dataset.day] = {
        dayOff: row.querySelector('[data-schedule-off]').checked,
        timeIn: row.querySelector('[data-schedule-in]').value || '09:00',
        timeOut: row.querySelector('[data-schedule-out]').value || '18:00'
      };
    });
    const monday = weeklySchedule.monday || { timeIn: '09:00', timeOut: '18:00' };
    const payload = {
      fullName, employeeCode, allowNoFingerprint: true,
      fingerprintId: editingEmployeeId ? undefined : primaryFingerprintId,
      deviceId: $('employeeScanDevice')?.value || '', weeklySchedule,
      shiftStart: monday.timeIn, shiftEnd: monday.timeOut,
      graceMinutes: 10, active: $('newStatus')?.value !== 'Inactive'
    };
    try {
      let savedEmployeeId = editingEmployeeId;
      if (editingEmployeeId) {
        for (const [index, fingerprintId] of employeeStagedFingerprints.entries()) {
          await api(`/api/employees/${encodeURIComponent(editingEmployeeId)}/fingerprints`, {
            method: 'POST',
            body: JSON.stringify({ fingerprintId, label: `Additional Finger ${index + 1}`, deviceId: $('employeeScanDevice')?.value || '' })
          });
        }
        await api(`/api/employees/${encodeURIComponent(editingEmployeeId)}`, {
          method: 'PATCH', body: JSON.stringify(payload)
        });
      } else {
        const saved = await api('/api/employees', { method: 'POST', body: JSON.stringify(payload) });
        savedEmployeeId = saved.employee.id;
        editingEmployeeId = savedEmployeeId;
        for (const [index, fingerprintId] of employeeStagedFingerprints.slice(1).entries()) {
          await api(`/api/employees/${encodeURIComponent(saved.employee.id)}/fingerprints`, {
          method: 'POST',
            body: JSON.stringify({ fingerprintId, label: `Additional Finger ${index + 2}`, deviceId: $('employeeScanDevice')?.value || '' })
          });
        }
      }
      toast(editingEmployeeId ? 'Employee changes saved.' : 'Employee saved to the server.');
      closeEmployeeEditor();
      await employees();
    } catch (error) {
      toast(error.message);
    }
  }

  let enrollmentRecords = [];
  let enrollmentPendingRecords = [];
  let enrollmentScanTimer = null;
  const enrollmentPageSize = 10;

  function ensureEnrollmentAssignmentModal() {
    let modal = $('enrollmentAssignmentModal');
    if (modal) return modal;
    document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop enrollment-assignment-backdrop" id="enrollmentAssignmentModal"><article class="enrollment-assignment-card">
      <button type="button" class="enrollment-assignment-close" id="closeEnrollmentAssignment" aria-label="Close">&times;</button>
      <span class="enrollment-assignment-icon"><i data-lucide="fingerprint"></i></span><h3>Assign Fingerprint</h3><p>Fingerprint ID <strong id="assignmentFingerprintId">—</strong> was scanned successfully. Choose where to link it.</p>
      <section><h4>Link to Existing Employee</h4><select id="assignmentEmployeeSelect"></select><button type="button" class="assignment-primary" id="linkAssignmentEmployee"><i data-lucide="link"></i> Link Fingerprint</button></section>
      <div class="enrollment-assignment-divider"><span>or</span></div>
      <section><h4>Create New Employee</h4><input id="assignmentEmployeeName" type="text" placeholder="Enter employee full name"><button type="button" class="assignment-secondary" id="createAssignmentEmployee"><i data-lucide="user-plus"></i> Create & Link</button></section>
    </article></div>`);
    modal = $('enrollmentAssignmentModal');
    $('closeEnrollmentAssignment')?.addEventListener('click', () => modal.classList.remove('show'));
    $('linkAssignmentEmployee')?.addEventListener('click', async () => {
      const employeeId = $('assignmentEmployeeSelect')?.value;
      const fingerprintId = Number(modal.dataset.fingerprintId);
      if (!employeeId || !fingerprintId) return toast('Select an employee first.');
      try {
        await api(`/api/employees/${encodeURIComponent(employeeId)}/fingerprints`, { method: 'POST', body: JSON.stringify({ fingerprintId, label: 'Primary Finger', deviceId: modal.dataset.deviceId || '' }) });
        modal.classList.remove('show');
        toast(`Fingerprint ID ${fingerprintId} linked successfully.`);
        await enrollment();
      } catch (error) { toast(error.message); }
    });
    $('createAssignmentEmployee')?.addEventListener('click', async () => {
      const fullName = $('assignmentEmployeeName')?.value.trim();
      const fingerprintId = Number(modal.dataset.fingerprintId);
      if (!fullName) return toast('Enter the new employee name.');
      try {
        await api('/api/employees', { method: 'POST', body: JSON.stringify({ fullName, fingerprintId, deviceId: modal.dataset.deviceId || '', active: true }) });
        modal.classList.remove('show');
        toast(`${fullName} created and linked to fingerprint ID ${fingerprintId}.`);
        await enrollment();
      } catch (error) { toast(error.message); }
    });
    window.lucide?.createIcons();
    return modal;
  }

  function openEnrollmentAssignment(result) {
    const modal = ensureEnrollmentAssignmentModal();
    modal.dataset.fingerprintId = String(result.fingerprintId || '');
    modal.dataset.deviceId = result.deviceId || result.lastDeviceId || '';
    if ($('assignmentFingerprintId')) $('assignmentFingerprintId').textContent = result.fingerprintId;
    if ($('assignmentEmployeeSelect')) $('assignmentEmployeeSelect').innerHTML = enrollmentRecords.length
      ? enrollmentRecords.map((employee) => `<option value="${esc(employee.id)}">${esc(employee.fullName)} — ${esc(employee.employeeCode || employee.id.slice(-8))}</option>`).join('')
      : '<option value="">No existing employees available</option>';
    if ($('assignmentEmployeeName')) $('assignmentEmployeeName').value = '';
    modal.classList.add('show');
  }

  function renderUnassignedFingerprints(pending) {
    const registeredPanel = $('employeeTableBody')?.closest('.table-panel');
    if (!registeredPanel) return;
    let panel = $('unassignedFingerprintPanel');
    if (!panel) {
      registeredPanel.insertAdjacentHTML('beforebegin', `<section class="panel unassigned-fingerprint-panel" id="unassignedFingerprintPanel">
        <header><div><h3>Unassigned Fingerprints <span id="unassignedFingerprintCount">0</span></h3><p>Fingerprints stored on a reader but not yet linked to an employee.</p></div></header>
        <div class="unassigned-fingerprint-list" id="unassignedFingerprintList"></div>
      </section>`);
      panel = $('unassignedFingerprintPanel');
      panel.addEventListener('click', (event) => {
        const assignButton = event.target.closest('[data-assign-pending]');
        const deleteButton = event.target.closest('[data-delete-pending]');
        if (assignButton) {
          const request = enrollmentPendingRecords.find((item) => item.id === assignButton.dataset.assignPending);
          if (request) openEnrollmentAssignment(request);
          return;
        }
        if (deleteButton) {
          const request = enrollmentPendingRecords.find((item) => item.id === deleteButton.dataset.deletePending);
          if (!request || !window.confirm(`Delete unused fingerprint ID ${request.fingerprintId} from the server and reader?`)) return;
          deleteButton.disabled = true;
          api(`/api/fingerprints/pending/${encodeURIComponent(request.id)}`, { method: 'DELETE' })
            .then((result) => { toast(result.message || `Fingerprint ID ${request.fingerprintId} deleted.`); return enrollment(); })
            .catch((error) => { deleteButton.disabled = false; toast(error.message); });
        }
      });
    }
    if ($('unassignedFingerprintCount')) $('unassignedFingerprintCount').textContent = pending.length;
    if ($('unassignedFingerprintList')) $('unassignedFingerprintList').innerHTML = pending.length
      ? pending.map((request) => `<article class="unassigned-fingerprint-row">
          <span class="unassigned-fingerprint-icon"><i data-lucide="fingerprint"></i></span>
          <div><strong>Fingerprint ID ${esc(request.fingerprintId)}</strong><small>${esc(request.deviceId || request.lastDeviceId || 'Any reader')} · ${esc(when(request.enrolledAt || request.scannedAt || request.createdAt))}</small></div>
          <span class="unassigned-fingerprint-status">Unassigned</span>
          <div class="unassigned-fingerprint-actions"><button type="button" data-assign-pending="${esc(request.id)}">Assign Employee</button><button class="danger" type="button" data-delete-pending="${esc(request.id)}">Delete Fingerprint</button></div>
        </article>`).join('')
      : '<div class="unassigned-fingerprint-empty"><i data-lucide="badge-check"></i><div><strong>No unused fingerprints</strong><span>New scans without an employee will appear here.</span></div></div>';
    window.lucide?.createIcons();
  }

  function renderEnrollmentPage(requestedPage) {
    const total = enrollmentRecords.length;
    const totalPages = Math.max(1, Math.ceil(total / enrollmentPageSize));
    const page = Math.min(Math.max(1, Number(requestedPage) || 1), totalPages);
    const start = (page - 1) * enrollmentPageSize;
    const pageRecords = enrollmentRecords.slice(start, start + enrollmentPageSize);
    if ($('employeeCount')) $('employeeCount').textContent = total;
    if ($('employeeTableBody')) $('employeeTableBody').innerHTML = pageRecords.map((employee, index) => `<tr>
      <td>${start + index + 1}</td><td>${employeeIdentity(employee)}</td><td>${esc(employee.employeeCode || employee.id.slice(-8))}</td>
      <td>Attendance</td><td>Employee</td><td>${esc(employee.shiftStart)} - ${esc(employee.shiftEnd)}</td>
      <td>${esc(when(employee.createdAt))}</td><td>${esc(employee.fingerprints?.[0]?.deviceId || 'Any reader')}</td>
      <td>${employee.fingerprints?.length || 0}</td><td><span class="status-badge ${employee.active ? 'active' : 'inactive'}">${employee.active ? 'Active' : 'Inactive'}</span></td><td>—</td>
    </tr>`).join('') || '<tr><td colspan="11">No employees registered.</td></tr>';
    if ($('entriesText')) {
      const from = total ? start + 1 : 0;
      const to = Math.min(start + enrollmentPageSize, total);
      $('entriesText').textContent = `Showing ${from} to ${to} of ${total} entries`;
    }
    const pagination = $('employeeTableBody')?.closest('.table-panel')?.querySelector('.pagination');
    if (pagination) {
      pagination.hidden = totalPages <= 1;
      pagination.innerHTML = totalPages <= 1 ? '' : `
        <button class="page-button" type="button" data-enrollment-page="${page - 1}" ${page === 1 ? 'disabled' : ''}>‹</button>
        ${Array.from({ length: totalPages }, (_, index) => `<button class="page-button ${page === index + 1 ? 'active' : ''}" type="button" data-enrollment-page="${index + 1}">${index + 1}</button>`).join('')}
        <button class="page-button" type="button" data-enrollment-page="${page + 1}" ${page === totalPages ? 'disabled' : ''}>›</button>`;
    }
  }

  async function enrollment() {
    const [{ readers }, { employees: records }, { pending }] = await Promise.all([
      api('/api/readers'), api('/api/employees'), api('/api/fingerprints/pending')
    ]);
    const onlineReaders = readers.filter((reader) => reader.online);
    if ($('registrationForm')) $('registrationForm').style.setProperty('display', 'none', 'important');
    const registrationHeading = document.querySelector('.registration-header h3');
    if (registrationHeading) registrationHeading.textContent = 'Fingerprint Enrollment';
    if ($('deviceSelect')) $('deviceSelect').innerHTML = onlineReaders.map((reader) =>
      `<option value="${esc(reader.deviceId)}">${esc(reader.deviceId)} — Online</option>`
    ).join('') || '<option value="">No online ESP32-S3 available</option>';
    if ($('startEnrollmentButton')) {
      $('startEnrollmentButton').disabled = onlineReaders.length === 0;
      $('startEnrollmentButton').title = onlineReaders.length ? 'Scan and save an unassigned fingerprint' : 'Connect an ESP32-S3 first';
    }
    enrollmentRecords = records;
    enrollmentPendingRecords = pending || [];
    renderUnassignedFingerprints(enrollmentPendingRecords);
    renderEnrollmentPage(1);
    if ($('enrollmentMessage')) $('enrollmentMessage').textContent = pending.length
      ? `${pending.length} unassigned fingerprint${pending.length === 1 ? '' : 's'} ready to link from an Employee profile.`
      : onlineReaders.length ? 'Select an online device, then scan a fingerprint. A name is not required.' : 'Start Enrollment is available when an ESP32-S3 is online.';
  }

  async function startEnrollment(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const deviceId = $('deviceSelect')?.value || '';
    if (!deviceId) return toast('No online ESP32-S3 reader is available.');
    clearTimeout(enrollmentScanTimer);
    clearInterval(employeePreviewTimer); employeePreviewTimer = null;
    const { pending: before } = await api('/api/fingerprints/pending');
    const existingIds = new Set(before.map((item) => item.id));
    const data = await api('/api/fingerprints/start-enrollment', { method: 'POST', body: JSON.stringify({ deviceId }) });
    const modal = ensureEmployeeScanModal();
    modal.classList.remove('scan-success', 'scan-failed', 'scan-preview-progress');
    if ($('employeeScanTitle')) $('employeeScanTitle').textContent = 'Register Fingerprint';
    if ($('employeeScanMessage')) $('employeeScanMessage').textContent = `Place a finger on ${data.deviceId}. The scan will be saved without an employee name.`;
    if ($('cancelEmployeeScan')) $('cancelEmployeeScan').textContent = 'Cancel Scan';
    modal.classList.add('show');
    const scanRequestedAt = Date.now();
    if ($('enrollmentMessage')) $('enrollmentMessage').textContent = `Waiting for a fingerprint scan from ${data.deviceId}...`;
    let attempts = 0;
    const poll = async () => {
      attempts += 1;
      try {
        const [{ pending }, { readers }] = await Promise.all([api('/api/fingerprints/pending'), api('/api/readers')]);
        const activeReader = readers.find((item) => item.deviceId === deviceId);
        const fingerDetected = activeReader?.fingerprintDetectedAt && new Date(activeReader.fingerprintDetectedAt).getTime() >= scanRequestedAt;
        if (fingerDetected) beginHardwareScanProgress(modal);
        const statusIsCurrent = activeReader?.fingerprintScanStatusAt && new Date(activeReader.fingerprintScanStatusAt).getTime() >= scanRequestedAt;
        if (statusIsCurrent && activeReader.fingerprintScanStatus === 'FAILED') {
          failHardwareScanProgress(modal);
          enrollmentScanTimer = null;
          if ($('enrollmentMessage')) $('enrollmentMessage').textContent = 'Fingerprint verification failed. Keep the finger steady and try again.';
          return;
        }
        const result = pending.find((item) => !existingIds.has(item.id) && (!item.deviceId || item.deviceId === deviceId));
        if (result?.fingerprintId) {
          finishHardwareScanProgress(modal);
          enrollmentScanTimer = null;
          modal.classList.add('scan-success');
          if ($('employeeScanTitle')) $('employeeScanTitle').textContent = 'Fingerprint Registered Successfully';
          if ($('employeeScanMessage')) $('employeeScanMessage').textContent = `Fingerprint ID ${result.fingerprintId} is saved as unassigned. Open an Employee profile to link it to an account.`;
          if ($('cancelEmployeeScan')) $('cancelEmployeeScan').textContent = 'Done';
          if ($('enrollmentMessage')) $('enrollmentMessage').textContent = `Fingerprint ID ${result.fingerprintId} is ready to link to an employee account.`;
          toast(`Fingerprint ID ${result.fingerprintId} registered successfully.`);
          setTimeout(() => {
            modal.classList.remove('show', 'scan-success', 'scan-preview-progress');
            openEnrollmentAssignment(result);
          }, 850);
          return;
        }
      } catch (error) {
        if ($('employeeScanMessage')) $('employeeScanMessage').textContent = error.message;
      }
      if (attempts >= 80) {
        enrollmentScanTimer = null;
        if ($('employeeScanTitle')) $('employeeScanTitle').textContent = 'Scan Timed Out';
        if ($('employeeScanMessage')) $('employeeScanMessage').textContent = 'No completed fingerprint enrollment was received. Check the ESP32-S3 connection and try again.';
        return;
      }
      enrollmentScanTimer = setTimeout(poll, 1500);
    };
    enrollmentScanTimer = setTimeout(poll, 900);
  }

  async function registerForEnrollment(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const fullName = [$('firstName')?.value, $('middleName')?.value, $('lastName')?.value]
      .map((part) => part?.trim()).filter(Boolean).join(' ');
    if (!fullName) return toast('Employee name is required.');
    const phone = $('phone')?.value.trim() || '';
    if (phone && !/^\+?[0-9 ()-]{7,20}$/.test(phone)) return toast('Enter a valid phone number using numbers, spaces, parentheses, +, or hyphens.');
    await api('/api/employees', { method: 'POST', body: JSON.stringify({
      fullName,
      email: $('email')?.value.trim() || '',
      phone,
      allowNoFingerprint: true,
      active: $('employeeStatus')?.value !== 'Inactive',
      graceMinutes: 10
    }) });
    toast(`${fullName} saved. You can now start ESP32 enrollment.`);
    event.target.reset();
    await enrollment();
  }

  let liveLogRecords = [];
  let liveLogEmployees = new Map();
  let liveLogsPage = 1;

  function logLevel(log) {
    const text = `${log.status || ''} ${log.statusText || ''} ${log.code || ''}`.toUpperCase();
    if (log.accepted === false || /ERROR|FAILED|REJECTED/.test(text)) return 'Error';
    if (log.emergency || /EMERGENCY|WARNING|LATE|PENDING/.test(text)) return 'Warning';
    return 'Success';
  }

  function renderLiveLogs() {
    const body = $('logsTableBody');
    if (!body) return;
    const keyword = String($('logSearch')?.value || '').trim().toLowerCase();
    const type = $('typeFilter')?.value || 'all';
    const status = $('statusFilter')?.value || 'all';
    const device = $('deviceFilter')?.value || 'all';
    const date = $('dateFilter')?.value || '';
    const filtered = liveLogRecords.filter((log) => {
      const logType = String(log.type || log.attendanceType || 'Recorded');
      const logDevice = String(log.deviceId || log.readerId || 'ESP32');
      const timestamp = new Date(log.timestamp || log.createdAt || 0);
      const dateKey = Number.isNaN(timestamp.getTime()) ? '' : timestamp.toLocaleDateString('en-CA');
      const text = [logType, logDevice, log.fullName, log.employeeName, log.message, log.status, log.statusText, log.deviceIp].join(' ').toLowerCase();
      return (!keyword || text.includes(keyword)) && (type === 'all' || logType === type) &&
        (status === 'all' || logLevel(log) === status) && (device === 'all' || logDevice === device) && (!date || dateKey === date);
    });
    const pageSize = 10;
    const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
    liveLogsPage = Math.min(liveLogsPage, totalPages);
    const start = (liveLogsPage - 1) * pageSize;
    const pageRecords = filtered.slice(start, start + pageSize);
    const html = pageRecords.length ? pageRecords.map((log, index) => {
      const level = logLevel(log);
      const rawStatus = log.status || log.statusText || (log.emergency ? 'Emergency' : 'Recorded');
      const employee = liveLogEmployees.get(log.employeeId) || { fullName: log.fullName || log.employeeName || 'Unknown', active: true };
      return `<tr><td>${start + index + 1}</td><td>${esc(when(log.timestamp || log.createdAt))}</td><td>${esc(String(log.type || log.attendanceType || 'Recorded').replaceAll('_', ' '))}</td>
        <td>${esc(log.message || `${employee.fullName} attendance scan`)}</td><td>${esc(log.deviceId || log.readerId || 'ESP32')}</td><td>${employeeIdentity(employee)}</td><td>${esc(log.deviceIp || '—')}</td>
        <td><span class="status-badge ${level.toLowerCase()}">${esc(String(rawStatus).replaceAll('_', ' '))}</span></td><td>—</td></tr>`;
    }).join('') : '<tr><td colspan="9" style="padding:28px;text-align:center;color:#75829b">No logs match the selected filters.</td></tr>';
    updateLiveHtml(body, html);
    if ($('entriesInfo')) $('entriesInfo').textContent = filtered.length ? `Showing ${start + 1} to ${start + pageRecords.length} of ${filtered.length} log${filtered.length === 1 ? '' : 's'}` : 'Showing 0 logs';
    const pagination = document.querySelector('.page-logs .pagination');
    if (pagination) {
      pagination.hidden = totalPages <= 1;
      updateLiveHtml(pagination, totalPages <= 1 ? '' : Array.from({ length: totalPages }, (_, index) => index + 1).map((page) =>
        `<button class="page-button ${page === liveLogsPage ? 'active' : ''}" type="button" data-live-log-page="${page}">${page}</button>`).join(''));
      pagination.querySelectorAll('[data-live-log-page]').forEach((button) => button.addEventListener('click', () => { liveLogsPage = Number(button.dataset.liveLogPage); renderLiveLogs(); }));
    }
  }

  async function logs() {
    const [{ attendance }, { employees }] = await Promise.all([api('/api/attendance?limit=500'), api('/api/employees')]);
    liveLogRecords = attendance || [];
    liveLogEmployees = new Map(employees.map((employee) => [employee.id, employee]));
    const todayKey = new Date().toLocaleDateString('en-CA');
    const todayRecords = liveLogRecords.filter((log) => { const date = new Date(log.timestamp || log.createdAt || 0); return !Number.isNaN(date.getTime()) && date.toLocaleDateString('en-CA') === todayKey; });
    const levels = { Success: 0, Warning: 0, Error: 0 };
    liveLogRecords.forEach((log) => { levels[logLevel(log)] += 1; });
    document.querySelectorAll('.page-logs .summary-card').forEach((card) => {
      const label = card.querySelector('h3')?.textContent.trim();
      const value = card.querySelector('strong');
      const note = card.querySelector('p');
      const count = label === 'Total Logs' ? liveLogRecords.length
        : label === "Today's Logs" ? todayRecords.length
          : label === 'Successful' ? levels.Success
            : label === 'Warnings' ? levels.Warning
              : label === 'Errors' ? levels.Error : 0;
      if (value && Number.isFinite(count)) value.textContent = count.toLocaleString();
      if (note && label === "Today's Logs") note.textContent = new Date().toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
      if (note && ['Successful', 'Warnings', 'Errors'].includes(label)) note.textContent = liveLogRecords.length ? `${((count / liveLogRecords.length) * 100).toFixed(1)}%` : '0%';
    });
    const typeFilter = $('typeFilter');
    const deviceFilter = $('deviceFilter');
    if (typeFilter) {
      const selected = typeFilter.value;
      typeFilter.innerHTML = '<option value="all">All Types</option>' + [...new Set(liveLogRecords.map((log) => String(log.type || log.attendanceType || 'Recorded')))].map((item) => `<option value="${esc(item)}">${esc(item.replaceAll('_', ' '))}</option>`).join('');
      if ([...typeFilter.options].some((option) => option.value === selected)) typeFilter.value = selected;
    }
    if (deviceFilter) {
      const selected = deviceFilter.value;
      deviceFilter.innerHTML = '<option value="all">All Devices</option>' + [...new Set(liveLogRecords.map((log) => String(log.deviceId || log.readerId || 'ESP32')))].map((item) => `<option value="${esc(item)}">${esc(item)}</option>`).join('');
      if ([...deviceFilter.options].some((option) => option.value === selected)) deviceFilter.value = selected;
    }
    const dateFilter = $('dateFilter');
    if (dateFilter && dateFilter.type !== 'date') { dateFilter.type = 'date'; dateFilter.readOnly = false; dateFilter.value = ''; }
    if ($('exportArrowButton')) {
      $('exportArrowButton').hidden = true;
      $('exportArrowButton').style.setProperty('display', 'none', 'important');
    }
    const body = $('logsTableBody');
    if (body && !body.dataset.liveLogControls) {
      body.dataset.liveLogControls = 'true';
      ['logSearch', 'typeFilter', 'statusFilter', 'deviceFilter', 'dateFilter'].forEach((id) => $(id)?.addEventListener(id === 'logSearch' ? 'input' : 'change', (event) => { event.stopImmediatePropagation(); liveLogsPage = 1; renderLiveLogs(); }, true));
      $('filterButton')?.addEventListener('click', (event) => { event.preventDefault(); event.stopImmediatePropagation(); liveLogsPage = 1; renderLiveLogs(); }, true);
      $('exportLogsButton')?.addEventListener('click', (event) => {
        event.preventDefault(); event.stopImmediatePropagation();
        const rows = [['Time', 'Log Type', 'Description', 'Device', 'Employee', 'IP Address', 'Status'], ...liveLogRecords.map((log) => [
          when(log.timestamp || log.createdAt), log.type || log.attendanceType || 'Recorded', log.message || '',
          log.deviceId || log.readerId || 'ESP32', log.fullName || log.employeeName || 'Unknown', log.deviceIp || '', log.status || log.statusText || (log.emergency ? 'Emergency' : 'Recorded')
        ])];
        const csv = rows.map((row) => row.map((cell) => `"${String(cell).replaceAll('"', '""')}"`).join(',')).join('\n');
        const link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        link.download = `gwd-attendance-logs-${new Date().toLocaleDateString('en-CA')}.csv`;
        link.click(); URL.revokeObjectURL(link.href);
      }, true);
    }
    renderLiveLogs();
  }

  let liveTimeCards = [];
  let liveTimeCardEmployees = [];
  let selectedTimeCard = null;
  let fullTimeCardExportParams = null;
  let fullTimeCardPhotoData = null;
  const timeCardAdvancedFilters = { source: 'all', completeness: 'all', exception: 'all' };

  function passesTimeCardAdvancedFilters(record) {
    if (timeCardAdvancedFilters.source === 'server' && record.manualStatus) return false;
    if (timeCardAdvancedFilters.source === 'manual' && !record.manualStatus) return false;
    if (timeCardAdvancedFilters.completeness === 'complete' && (!record.actualTimeIn || !record.actualTimeOut)) return false;
    if (timeCardAdvancedFilters.completeness === 'missing-in' && record.actualTimeIn) return false;
    if (timeCardAdvancedFilters.completeness === 'missing-out' && (!record.actualTimeIn || record.actualTimeOut)) return false;
    if (timeCardAdvancedFilters.exception === 'late' && !record.lateMinutes) return false;
    if (timeCardAdvancedFilters.exception === 'undertime' && !record.earlyOutMinutes) return false;
    if (timeCardAdvancedFilters.exception === 'overtime' && !record.overtimeMinutes) return false;
    if (timeCardAdvancedFilters.exception === 'emergency' && !record.emergency) return false;
    return true;
  }

  function saveFullTimeCardPhoto() {
    if (!fullTimeCardPhotoData) return toast('Open a Full Time Card report first.');
    const { employee, cards, from, to } = fullTimeCardPhotoData;
    const width = 1400;
    const height = Math.max(900, 460 + cards.length * 54);
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f7faff'; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#1677e8'; ctx.fillRect(0, 0, width, 8);
    ctx.fillStyle = '#1d5fc3'; ctx.font = '700 20px Arial'; ctx.fillText('GMS / GWD', 48, 62);
    ctx.fillStyle = '#10203b'; ctx.font = '700 42px Arial'; ctx.fillText('Employee Time Card Report', 48, 120);
    ctx.fillStyle = '#64748b'; ctx.font = '20px Arial'; ctx.fillText(`${employee.fullName}  •  ${from} to ${to}`, 48, 158);
    const info = [['EMPLOYEE', employee.fullName], ['FINGERPRINT ID', employee.fingerprintId ?? 'Not linked'], ['ACCOUNT STATUS', 'Active']];
    info.forEach(([label, value], index) => {
      const x = 48 + index * 438;
      ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#cbdced'; ctx.lineWidth = 2;
      ctx.fillRect(x, 195, 410, 110); ctx.strokeRect(x, 195, 410, 110);
      ctx.fillStyle = '#667790'; ctx.font = '700 15px Arial'; ctx.fillText(label, x + 20, 230);
      ctx.fillStyle = '#17233a'; ctx.font = '700 23px Arial'; ctx.fillText(String(value), x + 20, 272);
    });
    const columns = [48, 250, 430, 620, 810, 1010];
    const headers = ['DATE', 'DAY', 'TIME IN', 'TIME OUT', 'WORK HOURS', 'STATUS'];
    ctx.fillStyle = '#eaf3ff'; ctx.fillRect(48, 340, 1304, 52);
    ctx.fillStyle = '#40516a'; ctx.font = '700 15px Arial'; headers.forEach((header, index) => ctx.fillText(header, columns[index] + 12, 373));
    const photoStatusTheme = (statusValue) => {
      const status = String(statusValue || '').toUpperCase().replaceAll('_', ' ');
      if (status.includes('ABSENT') || status.includes('INCOMPLETE')) return { fill: '#fff0f2', stroke: '#ff9eaa', text: '#c9273b' };
      if (status.includes('LATE') || status.includes('WORKED DAY OFF') || status.includes('EARLY')) return { fill: '#fff6d9', stroke: '#f2c345', text: '#9a5700' };
      if (status.includes('DAY OFF') || status.includes('NO SCHEDULE')) return { fill: '#eef3f8', stroke: '#bdcada', text: '#52647a' };
      if (status.includes('EMERGENCY')) return { fill: '#fff0e5', stroke: '#f2a462', text: '#b74814' };
      if (status.includes('EXCUSED') || status.includes('LEAVE')) return { fill: '#f1edff', stroke: '#b9a5f4', text: '#6548ad' };
      if (status.includes('ON TIME') || status.includes('PRESENT') || status.includes('COMPLETED')) return { fill: '#e5fbef', stroke: '#67db98', text: '#087044' };
      return { fill: '#edf5ff', stroke: '#9bbfe9', text: '#285f9f' };
    };
    cards.forEach((card, rowIndex) => {
      const y = 392 + rowIndex * 54;
      ctx.fillStyle = rowIndex % 2 ? '#f8fbff' : '#ffffff'; ctx.fillRect(48, y, 1304, 54);
      ctx.fillStyle = '#26364e'; ctx.font = '18px Arial';
      const values = [card.dateKey, card.dayLabel, card.actualTimeIn || '—', card.actualTimeOut || '—', card.workDuration || hoursText(card.paidHours), card.status];
      values.forEach((value, index) => ctx.fillText(String(value).replaceAll('_', ' '), columns[index] + 12, y + 34));
      const statusText = String(card.status || 'Unknown').replaceAll('_', ' ').toUpperCase();
      const theme = photoStatusTheme(statusText);
      const badgeX = columns[5] + 8;
      const badgeY = y + 9;
      const badgeWidth = 222;
      const badgeHeight = 36;
      ctx.beginPath(); ctx.roundRect(badgeX, badgeY, badgeWidth, badgeHeight, 18);
      ctx.fillStyle = theme.fill; ctx.fill();
      ctx.strokeStyle = theme.stroke; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = theme.text; ctx.font = '700 14px Arial'; ctx.textAlign = 'center';
      ctx.fillText(statusText, badgeX + badgeWidth / 2, badgeY + 23);
      ctx.textAlign = 'left';
    });
    const link = document.createElement('a');
    link.download = `${employee.fullName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${from}-${to}-time-card.png`;
    link.href = canvas.toDataURL('image/png'); link.click();
  }

  function saveFullTimeCardPortraitPhoto() {
    if (!fullTimeCardPhotoData) return toast('Open a Full Time Card report first.');
    const { employee, cards, from, to, requiredPaidHours = 8 } = fullTimeCardPhotoData;
    const width = 1640;
    const height = 2332;
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    const formatReportDate = (value) => new Date(`${value}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const roundedBox = (x, y, boxWidth, boxHeight, radius, fill, stroke, lineWidth = 2) => {
      ctx.beginPath(); ctx.roundRect(x, y, boxWidth, boxHeight, radius);
      ctx.fillStyle = fill; ctx.fill();
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lineWidth; ctx.stroke(); }
    };
    const statusTheme = (statusValue) => {
      const status = String(statusValue || '').toUpperCase().replaceAll('_', ' ');
      if (status.includes('ABSENT') || status.includes('INCOMPLETE')) return ['#fff0f2', '#ff9eaa', '#c9273b'];
      if (status.includes('LATE') || status.includes('WORKED DAY OFF') || status.includes('EARLY')) return ['#fff6d9', '#f2c345', '#9a5700'];
      if (status.includes('DAY OFF') || status.includes('NO SCHEDULE')) return ['#eef3f8', '#bdcada', '#52647a'];
      if (status.includes('EMERGENCY')) return ['#fff0e5', '#f2a462', '#b74814'];
      if (status.includes('EXCUSED') || status.includes('LEAVE')) return ['#f1edff', '#b9a5f4', '#6548ad'];
      if (status.includes('ON TIME') || status.includes('PRESENT') || status.includes('COMPLETED')) return ['#e5fbef', '#67db98', '#087044'];
      return ['#edf5ff', '#9bbfe9', '#285f9f'];
    };

    ctx.fillStyle = '#f7faff'; ctx.fillRect(0, 0, width, height);
    const topGradient = ctx.createLinearGradient(0, 0, width, 0);
    topGradient.addColorStop(0, '#2878ed'); topGradient.addColorStop(.55, '#26afe0'); topGradient.addColorStop(1, '#087966');
    ctx.fillStyle = topGradient; ctx.fillRect(0, 0, width, 10);
    ctx.strokeStyle = '#d4e1ef'; ctx.lineWidth = 2; ctx.strokeRect(1, 1, width - 2, height - 2);
    ctx.fillStyle = '#1d5fc3'; ctx.font = '700 22px Arial'; ctx.fillText('GMS/GWD (GMS)', 50, 72);
    ctx.fillStyle = '#10203b'; ctx.font = '700 48px Arial'; ctx.fillText('Employee Time Card Report', 50, 148);
    ctx.fillStyle = '#64748b'; ctx.font = '22px Arial'; ctx.fillText('Semi-monthly cutoff attendance time card.', 50, 198);
    roundedBox(1310, 50, 270, 66, 33, '#eff7ff', '#a9ccfa');
    ctx.fillStyle = '#245fc8'; ctx.font = '700 18px Arial'; ctx.textAlign = 'center'; ctx.fillText('TIME CARD VIEW', 1445, 91); ctx.textAlign = 'left';

    const generated = new Date().toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    const info = [
      ['EMPLOYEE', employee.fullName], ['FINGERPRINT ID', employee.fingerprintId ?? 'Not linked'], ['ACCOUNT STATUS', 'Active'],
      ['CUTOFF RANGE', `${formatReportDate(from)} - ${formatReportDate(to)}`], ['GENERATED', generated], ['DAILY TARGET', `${Number(requiredPaidHours)}h / day`]
    ];
    info.forEach(([label, value], index) => {
      const column = index % 3;
      const row = Math.floor(index / 3);
      const x = 50 + column * 515;
      const y = 245 + row * 150;
      roundedBox(x, y, 480, 126, 22, '#ffffff', '#cbdced');
      ctx.fillStyle = '#667790'; ctx.font = '700 16px Arial'; ctx.fillText(label, x + 24, y + 42);
      ctx.fillStyle = '#17233a'; ctx.font = '700 25px Arial'; ctx.fillText(String(value), x + 24, y + 88);
    });

    const columns = [50, 290, 520, 760, 1000, 1270];
    const headers = ['DATE', 'DAY', 'TIME IN', 'TIME OUT', 'WORK HOURS', 'STATUS'];
    const tableTop = 570;
    const headerHeight = 62;
    const tableWidth = 1540;
    roundedBox(50, tableTop, tableWidth, height - tableTop - 48, 22, '#ffffff', '#cbdced');
    ctx.save(); ctx.beginPath(); ctx.roundRect(50, tableTop, tableWidth, headerHeight, [22, 22, 0, 0]); ctx.clip();
    ctx.fillStyle = '#eaf3ff'; ctx.fillRect(50, tableTop, tableWidth, headerHeight); ctx.restore();
    ctx.fillStyle = '#40516a'; ctx.font = '700 16px Arial'; headers.forEach((header, index) => ctx.fillText(header, columns[index] + 14, tableTop + 39));
    const bodyTop = tableTop + headerHeight;
    const rowHeight = Math.floor((height - bodyTop - 48) / Math.max(cards.length, 1));
    cards.forEach((card, rowIndex) => {
      const y = bodyTop + rowIndex * rowHeight;
      ctx.fillStyle = rowIndex % 2 ? '#f2f5f8' : '#ffffff'; ctx.fillRect(52, y, tableWidth - 4, rowHeight);
      ctx.strokeStyle = '#e2eaf3'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(52, y); ctx.lineTo(1588, y); ctx.stroke();
      const values = [formatReportDate(card.dateKey), card.dayLabel, card.actualTimeIn || '—', card.actualTimeOut || '—', card.workDuration || hoursText(card.paidHours)];
      ctx.fillStyle = '#26364e'; ctx.font = '20px Arial';
      values.forEach((value, index) => ctx.fillText(String(value).replaceAll('_', ' '), columns[index] + 14, y + Math.round(rowHeight * .58)));
      const statusText = String(card.status || 'Unknown').replaceAll('_', ' ').toUpperCase();
      const [fill, stroke, textColor] = statusTheme(statusText);
      const badgeHeight = Math.min(54, rowHeight - 22);
      const badgeY = y + Math.round((rowHeight - badgeHeight) / 2);
      roundedBox(columns[5] + 8, badgeY, 270, badgeHeight, badgeHeight / 2, fill, stroke);
      ctx.fillStyle = textColor; ctx.font = '700 17px Arial'; ctx.textAlign = 'center';
      ctx.fillText(statusText, columns[5] + 143, badgeY + Math.round(badgeHeight * .64)); ctx.textAlign = 'left';
    });
    const link = document.createElement('a');
    link.download = `timecard-${employee.fullName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${from}-to-${to}.png`;
    link.href = canvas.toDataURL('image/png'); link.click();
  }

  const hoursText = (hours) => `${Math.floor(Number(hours || 0))}h ${Math.round((Number(hours || 0) % 1) * 60)}m`;

  function showTimeCardDetails(record) {
    if (!record) return;
    selectedTimeCard = record;
    const rows = document.querySelectorAll('.details-body .detail-row');
    const setDetail = (label, value) => rows.forEach((row) => {
      if (row.querySelector('.detail-label')?.textContent.trim() === label) row.querySelector('.detail-value').textContent = value;
    });
    setDetail('Employee', `${record.fullName} (FP ${record.fingerprintId ?? '—'})`);
    setDetail('Date', `${record.dateKey} (${record.dayLabel})`);
    setDetail('Schedule', record.schedule || '—');
    setDetail('Time In (Actual)', record.actualTimeIn || '—');
    setDetail('Time Out (Actual)', record.actualTimeOut || '—');
    setDetail('Break Duration', `${record.lunchDeduction || 0}h`);
    setDetail('Regular Hours', hoursText(record.paidHours));
    setDetail('Overtime Hours', `${record.overtimeMinutes || 0}m`);
    setDetail('Late', `${record.lateMinutes || 0}m`);
    setDetail('Undertime', `${record.earlyOutMinutes || 0}m`);
    setDetail('Verified By', record.manualStatus ? 'Administrator (Manual)' : 'Attendance Server');
    setDetail('Verified At', record.manualStatus?.updatedAt ? when(record.manualStatus.updatedAt) : 'Live record');
    setDetail('Notes', record.reason || record.manualStatus?.reason || '—');
    const status = $('detailStatus');
    if (status) { status.textContent = record.status; status.className = `badge ${String(record.status).toLowerCase().replaceAll('_', '-')}`; }
    const verification = $('detailVerification');
    if (verification) verification.textContent = record.manualStatus ? 'Manual' : 'Server Record';
    document.querySelectorAll('#recordsTable tbody tr').forEach((row) => row.classList.toggle('selected', row.dataset.key === `${record.employeeId}|${record.dateKey}`));
  }

  function openTimeCardModal(record) {
    if (!record) return;
    const backdrop = $('modalBackdrop');
    const title = $('modalTitle');
    const body = $('modalBody');
    if (!backdrop || !body) return;
    backdrop.classList.remove('full-timecard-modal');
    backdrop.dataset.modalMode = 'record-details';
    if (title) title.textContent = `${record.fullName} • ${record.dateKey}`;
    const editableAbsent = record.status === 'ABSENT' || ['EXCUSED', 'SICK_LEAVE', 'EMERGENCY_LEAVE', 'DAY_OFF', 'NO_SCHEDULE'].includes(record.manualStatus?.status);
    if (title) title.textContent = 'Attendance Record';
    const employee = liveTimeCardEmployees.find((item) => item.id === record.employeeId) || { fullName: record.fullName, active: true };
    const statusControl = editableAbsent ? `<select id="recordStatusSelect" class="record-status-select">
      <option value="ABSENT">Absent</option><option value="EXCUSED">Excused</option><option value="SICK_LEAVE">Sick Leave</option>
      <option value="EMERGENCY_LEAVE">Emergency Leave</option><option value="DAY_OFF">Day Off</option><option value="NO_SCHEDULE">No Schedule</option>
    </select>` : `<strong>${esc(record.status)}</strong>`;
    body.innerHTML = `<section class="timecard-modal-profile">
      <span class="timecard-modal-avatar">${employeeAvatar(employee)}</span>
      <div class="timecard-modal-profile-copy"><strong>${esc(record.fullName)}</strong><span>${esc(record.dateKey)} • ${esc(record.dayLabel || '')}</span></div>
      <span class="timecard-modal-account ${employee.active === false ? 'inactive' : 'active'}"><i></i>${employee.active === false ? 'Inactive Account' : 'Active Account'}</span>
    </section>
    <div class="live-timecard-modal-grid">
      <div><span>Status</span>${statusControl}</div>
      <div><span>Schedule</span><strong>${esc(record.schedule || '—')}</strong></div>
      <div><span>Time In</span><strong>${esc(record.actualTimeIn || '—')}</strong></div>
      <div><span>Time Out</span><strong>${esc(record.actualTimeOut || '—')}</strong></div>
      <div><span>Paid Hours</span><strong>${esc(hoursText(record.paidHours))}</strong></div>
      <div><span>Overtime</span><strong>${Number(record.overtimeMinutes || 0)}m</strong></div>
      <div><span>Late</span><strong>${Number(record.lateMinutes || 0)}m</strong></div>
      <div><span>Undertime</span><strong>${Number(record.earlyOutMinutes || 0)}m</strong></div>
    </div>
    <div class="emergency-attendance-box">
      <div><span>Emergency scan time</span><input id="emergencyRecordTime" type="time" value="${new Date().toTimeString().slice(0,5)}"></div>
      <div><span>Emergency password</span><input id="emergencyRecordPassword" type="password" inputmode="numeric" maxlength="6" placeholder="Enter password"></div>
      <div class="emergency-action-buttons"><button type="button" data-emergency-type="TIME_IN">Emergency Time In</button><button type="button" data-emergency-type="TIME_OUT">Emergency Time Out</button></div>
    </div>`;
    if ($('recordStatusSelect')) $('recordStatusSelect').value = record.manualStatus?.status || record.status;
    if ($('modalCancel')) $('modalCancel').textContent = 'Close';
    if ($('modalConfirm')) $('modalConfirm').textContent = editableAbsent ? 'Save Status' : 'Done';
    if ($('modalPhoto')) $('modalPhoto').hidden = true;
    backdrop.classList.add('show');
  }

  async function openFullTimeCard(record) {
    if (!record) return toast('Select an employee record first.');
    const params = buildFullTimeCardParams(record.employeeId);
    const result = await api(`/api/timecard?${params}`);
    fullTimeCardExportParams = params;
    const filteredCards = result.timeCards || [];
    fullTimeCardPhotoData = { employee: record, cards: filteredCards, from: result.from, to: result.to, requiredPaidHours: result.settings?.requiredPaidHours || 8 };
    const formatDate = (value) => new Date(`${value}T00:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    const rows = filteredCards.map((card) => `<tr>
      <td>${esc(formatDate(card.dateKey))}</td><td>${esc(card.dayLabel)}</td><td>${esc(card.actualTimeIn || '—')}</td>
      <td>${esc(card.actualTimeOut || '—')}</td><td><strong>${esc(card.workDuration || hoursText(card.paidHours))}</strong></td>
      <td><span class="report-status ${esc(String(card.status).toLowerCase().replaceAll('_','-'))}">${esc(card.status)}</span></td>
    </tr>`).join('');
    const backdrop = $('modalBackdrop');
    backdrop?.classList.add('show', 'full-timecard-modal');
    backdrop.dataset.modalMode = 'full-timecard';
    if ($('modalTitle')) $('modalTitle').textContent = 'Employee Time Card Report';
    if ($('modalBody')) $('modalBody').innerHTML = `<div class="timecard-report">
      <div class="report-top"><div><span class="report-brand">GMS / GWD</span><h2>Employee Time Card Report</h2><p>Semi-monthly cutoff attendance time card.</p></div><span class="report-view-chip">${Number(result.from.slice(8, 10)) === 1 ? '1–15 CUTOFF' : '16–END CUTOFF'}</span></div>
      <div class="report-info-grid">
        <div><span>Employee</span><strong>${esc(record.fullName)}</strong></div>
        <div><span>Fingerprint ID</span><strong>${esc(record.fingerprintId ?? 'Not linked')}</strong></div>
        <div><span>Account Status</span><strong>Active</strong></div>
        <div><span>Cutoff Range</span><strong>${esc(formatDate(result.from))} – ${esc(formatDate(result.to))}</strong></div>
        <div><span>Generated</span><strong>${esc(new Date().toLocaleString())}</strong></div>
        <div><span>Daily Target</span><strong>${Number(result.settings?.requiredPaidHours || 8)}h / day</strong></div>
      </div>
      <div class="report-filter-note">Showing the complete ${esc(formatDate(result.from))} – ${esc(formatDate(result.to))} cutoff.</div>
      <div class="report-table-wrap"><table class="report-table"><thead><tr><th>Date</th><th>Day</th><th>Time In</th><th>Time Out</th><th>Work Hours</th><th>Status</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No records match the current filters.</td></tr>'}</tbody></table></div>
    </div>`;
    if ($('modalCancel')) $('modalCancel').textContent = 'Close';
    if ($('modalPhoto')) $('modalPhoto').hidden = false;
    if ($('modalConfirm')) $('modalConfirm').textContent = 'Export PDF';
  }

  function bindTimeCardControls(refresh) {
    const main = document.querySelector('.main');
    if (!main || main.dataset.liveTimecardBound) return;
    main.dataset.liveTimecardBound = 'true';
    main.addEventListener('click', (event) => {
      const tab = event.target.closest('.view-tab');
      if (tab) {
        event.preventDefault(); event.stopImmediatePropagation();
        document.querySelectorAll('.view-tab').forEach((item) => item.classList.toggle('active', item === tab));
        refresh(); return;
      }
      const row = event.target.closest('#recordsTable tbody tr[data-key]');
      if (row) {
        event.preventDefault(); event.stopImmediatePropagation();
        const record = liveTimeCards.find((item) => `${item.employeeId}|${item.dateKey}` === row.dataset.key);
        showTimeCardDetails(record);
        if (event.target.closest('.action-menu')) openTimeCardModal(record);
        return;
      }
      if (event.target.closest('#exportButton')) {
        event.preventDefault(); event.stopImmediatePropagation();
        window.open(`/api/timecard/export/pdf?${buildTimeCardParams()}`, '_blank', 'noopener'); return;
      }
      if (event.target.closest('#filterButton')) {
        event.preventDefault(); event.stopImmediatePropagation();
        if ($('modalTitle')) $('modalTitle').textContent = 'Advanced Filters';
        if ($('modalBody')) $('modalBody').innerHTML = `<div class="advanced-filter-grid">
          <label><span>Record Source</span><select id="advancedSource"><option value="all">All Sources</option><option value="server">Attendance Server</option><option value="manual">Manual Records</option></select></label>
          <label><span>Scan Completeness</span><select id="advancedCompleteness"><option value="all">All Records</option><option value="complete">Complete Time In & Out</option><option value="missing-in">Missing Time In</option><option value="missing-out">Missing Time Out</option></select></label>
          <label><span>Attendance Exception</span><select id="advancedException"><option value="all">All Results</option><option value="late">With Late Minutes</option><option value="undertime">With Undertime</option><option value="overtime">With Overtime</option><option value="emergency">Emergency Records</option></select></label>
        </div>`;
        if ($('advancedSource')) $('advancedSource').value = timeCardAdvancedFilters.source;
        if ($('advancedCompleteness')) $('advancedCompleteness').value = timeCardAdvancedFilters.completeness;
        if ($('advancedException')) $('advancedException').value = timeCardAdvancedFilters.exception;
        $('modalBackdrop')?.classList.remove('full-timecard-modal');
        $('modalBackdrop').dataset.modalMode = 'advanced-filter';
        $('modalBackdrop')?.classList.add('show');
        if ($('modalPhoto')) $('modalPhoto').hidden = true;
        return;
      }
      if (event.target.closest('#fullTimeCardButton')) {
        event.preventDefault(); event.stopImmediatePropagation();
        openFullTimeCard(selectedTimeCard).catch((error) => toast(error.message));
        return;
      }
      if (event.target.closest('#verifyButton')) {
        event.preventDefault(); event.stopImmediatePropagation();
        toast(selectedTimeCard ? `${selectedTimeCard.fullName}'s record is already sourced from the attendance server.` : 'Select a record first.'); return;
      }
      if (event.target.closest('#correctionButton')) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!selectedTimeCard) return toast('Select a record first.');
        location.assign(`/logs?employee=${encodeURIComponent(selectedTimeCard.employeeId)}&date=${selectedTimeCard.dateKey}`); return;
      }
      if (event.target.closest('#historyButton')) {
        event.preventDefault(); event.stopImmediatePropagation();
        location.assign(selectedTimeCard ? `/logs?employee=${encodeURIComponent(selectedTimeCard.employeeId)}` : '/logs');
      }
    }, true);
    ['employeeFilter', 'dateRange', 'cutoffFilter', 'branchFilter', 'statusFilter'].forEach((id) =>
      $(id)?.addEventListener('change', refresh, true));
    $('recordSearch')?.addEventListener('input', () => {
      const query = $('recordSearch').value.trim().toLowerCase();
      let visible = 0;
      document.querySelectorAll('#recordsTable tbody tr[data-key]').forEach((row) => {
        const matches = !query || row.dataset.name.includes(query);
        row.hidden = !matches;
        if (matches) visible += 1;
      });
      const count = document.querySelector('.record-count');
      if (count) count.textContent = `${visible} matching record(s)`;
    });
    $('modalConfirm')?.addEventListener('click', (event) => {
      if ($('modalBackdrop')?.dataset.modalMode === 'full-timecard') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (fullTimeCardExportParams) window.open(`/api/timecard/export/pdf?${fullTimeCardExportParams}`, '_blank', 'noopener');
        return;
      }
      if ($('modalBackdrop')?.dataset.modalMode === 'record-details') {
        event.preventDefault(); event.stopImmediatePropagation();
        if (!$('recordStatusSelect')) { $('modalBackdrop').classList.remove('show'); return; }
        if (!selectedTimeCard) return toast('Select a record first.');
        api('/api/timecard/manual-status', { method: 'POST', body: JSON.stringify({
          employeeId: selectedTimeCard.employeeId,
          dateKey: selectedTimeCard.dateKey,
          status: $('recordStatusSelect').value,
          reason: `Updated from Time Card: ${$('recordStatusSelect').selectedOptions[0].textContent}`,
          approvedBy: 'GWD Administrator'
        }) }).then(() => {
          $('modalBackdrop').classList.remove('show');
          toast('Attendance status updated.');
          refresh();
        }).catch((error) => toast(error.message));
        return;
      }
      if (!$('advancedSource')) return;
      event.preventDefault(); event.stopImmediatePropagation();
      timeCardAdvancedFilters.source = $('advancedSource').value;
      timeCardAdvancedFilters.completeness = $('advancedCompleteness').value;
      timeCardAdvancedFilters.exception = $('advancedException').value;
      $('modalBackdrop')?.classList.remove('show');
      refresh();
    }, true);
    $('modalPhoto')?.addEventListener('click', (event) => {
      event.preventDefault(); event.stopImmediatePropagation();
      saveFullTimeCardPortraitPhoto();
    }, true);
    $('modalBody')?.addEventListener('click', (event) => {
      const emergencyButton = event.target.closest('[data-emergency-type]');
      if (!emergencyButton) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (!selectedTimeCard) return toast('Select an employee record first.');
      const password = $('emergencyRecordPassword')?.value || '';
      if (!password) return toast('Enter the emergency password.');
      const time = $('emergencyRecordTime')?.value || new Date().toTimeString().slice(0,5);
      const scannedAt = new Date(`${selectedTimeCard.dateKey}T${time}:00`).toISOString();
      api('/api/admin/emergency-attendance', { method: 'POST', body: JSON.stringify({
        employeeId: selectedTimeCard.employeeId, attendanceType: emergencyButton.dataset.emergencyType,
        scannedAt, password, reason: emergencyButton.dataset.emergencyType === 'TIME_IN' ? 'Emergency Time In' : 'Emergency Time Out',
        approvedBy: 'GWD Administrator'
      }) }).then(() => {
        $('modalBackdrop').classList.remove('show');
        toast(`${emergencyButton.dataset.emergencyType === 'TIME_IN' ? 'Emergency Time In' : 'Emergency Time Out'} saved.`);
        refresh();
      }).catch((error) => toast(error.message));
    }, true);
  }

  function buildTimeCardParams() {
    const params = new URLSearchParams();
    const selectedDate = $('dateRange')?.value || new Date().toLocaleDateString('en-CA');
    const activeView = document.querySelector('.view-tab.active')?.dataset.view || 'Daily';
    const date = new Date(`${selectedDate}T00:00:00`);
    let from = selectedDate;
    let to = selectedDate;
    if (activeView === 'Weekly') {
      const day = date.getDay();
      const start = new Date(date); start.setDate(date.getDate() - day);
      const end = new Date(start); end.setDate(start.getDate() + 6);
      from = start.toLocaleDateString('en-CA'); to = end.toLocaleDateString('en-CA');
    } else if (activeView === 'Monthly') {
      from = `${selectedDate.slice(0, 7)}-01`;
      to = new Date(date.getFullYear(), date.getMonth() + 1, 0).toLocaleDateString('en-CA');
    }
    const cutoff = $('cutoffFilter')?.value || '';
    if (activeView === 'Monthly' && cutoff === 'FIRST_HALF') { from = `${selectedDate.slice(0, 7)}-01`; to = `${selectedDate.slice(0, 7)}-15`; }
    if (activeView === 'Monthly' && cutoff === 'SECOND_HALF') { from = `${selectedDate.slice(0, 7)}-16`; to = new Date(date.getFullYear(), date.getMonth() + 1, 0).toLocaleDateString('en-CA'); }
    if ($('employeeFilter')?.value) params.set('employeeId', $('employeeFilter').value);
    params.set('from', from); params.set('to', to);
    const status = $('statusFilter')?.value;
    const branch = $('branchFilter')?.value;
    if (status && !status.startsWith('All')) params.set('status', status.toUpperCase().replaceAll(' ', '_'));
    if (branch && !branch.startsWith('All')) params.set('branch', branch);
    return params;
  }

  function buildFullTimeCardParams(employeeId) {
    const params = new URLSearchParams();
    const selectedDate = $('dateRange')?.value || new Date().toLocaleDateString('en-CA');
    const date = new Date(`${selectedDate}T00:00:00`);
    const monthKey = selectedDate.slice(0, 7);
    const monthEnd = new Date(date.getFullYear(), date.getMonth() + 1, 0).toLocaleDateString('en-CA');
    const cutoff = $('cutoffFilter')?.value || (date.getDate() <= 15 ? 'FIRST_HALF' : 'SECOND_HALF');
    let from = `${monthKey}-01`;
    let to = `${monthKey}-15`;
    if (cutoff === 'SECOND_HALF' || (cutoff === 'FULL_MONTH' && date.getDate() > 15)) { from = `${monthKey}-16`; to = monthEnd; }
    params.set('employeeId', employeeId);
    params.set('from', from);
    params.set('to', to);
    return params;
  }

  function updateCurrentCutoffLabel(selectedDate, initializeSelection = false) {
    const cutoffFilter = $('cutoffFilter');
    if (!cutoffFilter) return;

    const today = new Date();
    const date = new Date(`${selectedDate}T00:00:00`);
    const isCurrentMonth =
      date.getFullYear() === today.getFullYear() &&
      date.getMonth() === today.getMonth();
    const currentValue = today.getDate() <= 15 ? 'FIRST_HALF' : 'SECOND_HALF';

    if (initializeSelection) {
      cutoffFilter.value = date.getDate() <= 15 ? 'FIRST_HALF' : 'SECOND_HALF';
    }

    const firstHalf = cutoffFilter.querySelector('[value="FIRST_HALF"]');
    const secondHalf = cutoffFilter.querySelector('[value="SECOND_HALF"]');
    if (firstHalf) firstHalf.textContent = `1 – 15${isCurrentMonth && currentValue === 'FIRST_HALF' ? ' (Current)' : ''}`;
    if (secondHalf) secondHalf.textContent = `16 – End${isCurrentMonth && currentValue === 'SECOND_HALF' ? ' (Current)' : ''}`;
  }

  async function timecard() {
    document.body.classList.add('live-timecard-loading');
    const dateInput = $('dateRange');
    if (dateInput && dateInput.type !== 'date') {
      dateInput.type = 'date'; dateInput.readOnly = false;
      dateInput.value = new Date().toLocaleDateString('en-CA');
    }
    if (dateInput) {
      dateInput.classList.add('live-date-input');
      if (!dateInput.dataset.pickerBound) {
        dateInput.dataset.pickerBound = 'true';
        dateInput.addEventListener('click', () => {
          if (typeof dateInput.showPicker === 'function') try { dateInput.showPicker(); } catch (_) {}
        });
        dateInput.addEventListener('keydown', (event) => {
          if ((event.key === 'Enter' || event.key === ' ') && typeof dateInput.showPicker === 'function') {
            event.preventDefault();
            try { dateInput.showPicker(); } catch (_) {}
          }
        });
      }
      let dateLabel = dateInput.parentElement.querySelector('.live-date-label');
      if (!dateLabel) {
        dateLabel = document.createElement('span');
        dateLabel.className = 'live-date-label';
        dateInput.insertAdjacentElement('afterend', dateLabel);
      }
      const parsedDate = new Date(`${dateInput.value}T00:00:00`);
      dateLabel.textContent = parsedDate.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
    }
    const cutoffFilter = $('cutoffFilter');
    const initializeCutoff = cutoffFilter && !cutoffFilter.dataset.initialized;
    updateCurrentCutoffLabel(dateInput?.value || new Date().toLocaleDateString('en-CA'), initializeCutoff);
    if (initializeCutoff) cutoffFilter.dataset.initialized = 'true';
    const [{ employees }, { settings }, result] = await Promise.all([
      api('/api/employees'), api('/api/settings'), api(`/api/timecard?${buildTimeCardParams()}`)
    ]);
    liveTimeCardEmployees = employees;
    const employeeBox = document.querySelector('.employee-select')?.closest('.input-box');
    if (employeeBox && !$('employeeFilter')) employeeBox.innerHTML = `<select id="employeeFilter"><option value="">All Employees</option>${employees.map((employee) => `<option value="${esc(employee.id)}">${esc(employee.fullName)} (FP ${esc(employee.fingerprintId ?? '—')})</option>`).join('')}</select>`;
    if ($('branchFilter')) $('branchFilter').innerHTML = `<option>All Branches</option><option>${esc(settings.branchName)}</option>`;
    bindTimeCardControls(() => timecard().catch((error) => toast(error.message)));
    liveTimeCards = (result.timeCards || []).filter(passesTimeCardAdvancedFilters);
    const body = document.querySelector('#recordsTable tbody');
    if (!body) return;
    body.innerHTML = liveTimeCards.length ? liveTimeCards.map((record) => `<tr data-key="${esc(record.employeeId)}|${esc(record.dateKey)}" data-name="${esc(record.fullName.toLowerCase())}">
      <td>${esc(record.dateKey)}</td><td>${esc(record.dayLabel)}</td><td>${esc(record.actualTimeIn || '—')}</td>
      <td>${esc(record.actualTimeOut || '—')}</td><td>${record.lunchDeduction || 0}h</td><td>${record.paidHours || 0}h</td>
      <td>${Math.round((record.overtimeMinutes || 0) / 6) / 10}h</td><td>${record.lateMinutes || 0}m</td>
      <td>${record.earlyOutMinutes || 0}m</td><td><span class="status-badge ${esc(String(record.status).toLowerCase().replaceAll('_', '-'))}">${esc(record.status)}</span></td>
      <td>${record.manualStatus ? 'Manual' : 'Server'}</td><td>${employeeIdentity(employees.find((employee) => employee.id === record.employeeId) || { fullName: record.fullName, active: true })}</td>
      <td><button class="action-menu" type="button" aria-label="View ${esc(record.fullName)} details">•••</button></td>
    </tr>`).join('') : '<tr><td colspan="13" class="empty-state">No time card records match these filters.</td></tr>';
    const total = liveTimeCards.length || 1;
    document.querySelectorAll('.stat-card').forEach((card) => {
      const label = card.querySelector('h3')?.textContent.trim();
      const value = card.querySelector('.stat-info > strong');
      const note = card.querySelector('.stat-info > p');
      if (!value) return;
      const counts = { Present: liveTimeCards.filter((r) => r.status.includes('PRESENT')).length, Late: liveTimeCards.filter((r) => r.lateMinutes > 0).length, Absent: liveTimeCards.filter((r) => r.status === 'ABSENT').length, 'On Leave': liveTimeCards.filter((r) => r.status.includes('LEAVE') || r.status === 'EXCUSED').length, Undertime: liveTimeCards.filter((r) => r.earlyOutMinutes > 0).length, Overtime: liveTimeCards.filter((r) => r.overtimeMinutes > 0).length };
      if (label === 'Total Hours') { value.textContent = hoursText(liveTimeCards.reduce((sum, r) => sum + Number(r.paidHours || 0), 0)); if (note) note.textContent = 'Live filtered total'; }
      else if (label in counts) { value.textContent = counts[label]; if (note) note.textContent = `${Math.round(counts[label] / total * 100)}%`; }
    });
    const count = document.querySelector('.record-count'); if (count) count.textContent = `${liveTimeCards.length} live record(s)`;
    if ($('recordSearch')?.value) $('recordSearch').dispatchEvent(new Event('input'));
    const summaryValues = {
      'Total Regular Hours': hoursText(liveTimeCards.reduce((sum, r) => sum + Number(r.paidHours || 0), 0)),
      'Total Overtime Hours': `${liveTimeCards.reduce((sum, r) => sum + Number(r.overtimeMinutes || 0), 0)}m`,
      'Total Paid Hours': hoursText(liveTimeCards.reduce((sum, r) => sum + Number(r.paidHours || 0) + Number(r.overtimeMinutes || 0) / 60, 0)),
      'Late (Total)': `${liveTimeCards.reduce((sum, r) => sum + Number(r.lateMinutes || 0), 0)}m`,
      'Undertime (Total)': `${liveTimeCards.reduce((sum, r) => sum + Number(r.earlyOutMinutes || 0), 0)}m`,
      Absences: `${liveTimeCards.filter((r) => r.status === 'ABSENT').length} day(s)`,
      Leaves: `${liveTimeCards.filter((r) => r.status.includes('LEAVE') || r.status === 'EXCUSED').length} day(s)`
    };
    document.querySelectorAll('.summary-item').forEach((item) => {
      const label = item.querySelector('span')?.textContent.trim();
      if (label in summaryValues) item.querySelector('strong').textContent = summaryValues[label];
    });
    showTimeCardDetails(liveTimeCards[0]);

    // timecard() updates the DOM asynchronously, so restore any Lucide icons
    // that were not initialized during the first page render.
    refreshLucideIcons();

    document.body.classList.remove('live-timecard-loading');
    document.body.classList.add('live-timecard-ready');
  }

  async function settings() {
    const { settings: data } = await api('/api/settings');
    if ($('branchSelect')) $('branchSelect').innerHTML = `<option>${esc(data.branchName)}</option>`;
    if ($('defaultTimeIn')) $('defaultTimeIn').value = data.defaultShiftStart;
    if ($('defaultTimeOut')) $('defaultTimeOut').value = data.defaultShiftEnd;
    if ($('gracePeriod')) $('gracePeriod').value = data.graceMinutes;
    if ($('breakStart')) $('breakStart').value = data.afternoonBreakStart;
    if ($('breakEnd')) $('breakEnd').value = data.afternoonBreakEnd;
    if ($('regularHours')) $('regularHours').value = data.requiredPaidHours;
    installFunctionalSettingsPanels(data);
  }

  function bindSettingsTabs() {
    document.querySelectorAll('.settings-tab').forEach((button) => {
      if (button.dataset.liveTabBound === 'true') return;
      button.dataset.liveTabBound = 'true';
      button.addEventListener('click', (event) => {
        event.preventDefault();
        document.querySelectorAll('.settings-tab').forEach((tab) => tab.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach((content) => content.classList.remove('active'));
        button.classList.add('active');
        const target = $(`${button.dataset.tab}Content`);
        if (target) target.classList.add('active');
      }, true);
    });
  }

  function installFunctionalSettingsPanels(data) {
    const generalPanel = $('generalContent');
    const attendancePanel = $('attendanceContent');
    const notificationsPanel = $('notificationsContent');
    const devicesPanel = $('devicesContent');
    const systemPanel = $('systemContent');
    const backupPanel = $('backupContent');
    if (!generalPanel || !attendancePanel || attendancePanel.dataset.functionalSettings) return;
    attendancePanel.dataset.functionalSettings = 'true';
    const switchRow = (id, title, text, checked) => `<label class="functional-setting-row"><span><strong>${title}</strong><small>${text}</small></span><input id="${id}" type="checkbox" ${checked ? 'checked' : ''}><i></i></label>`;
    generalPanel.innerHTML = `<article class="panel functional-settings-panel"><div class="functional-panel-heading"><div><h3>General Settings</h3><p>Core branch, schedule and break values stored on the attendance server.</p></div><span class="live-settings-chip">Saved on server</span></div><form id="generalSettingsForm" class="functional-settings-grid">
      <label class="functional-field"><span>Company / Branch</span><div><input id="branchSelect" type="text" maxlength="80" value="${esc(data.branchName)}"></div><small>Name displayed throughout the attendance system.</small></label>
      <label class="functional-field"><span>Default Time In</span><div><input id="defaultTimeIn" type="time" value="${esc(data.defaultShiftStart)}"></div><small>Used when an employee has no custom weekly schedule.</small></label>
      <label class="functional-field"><span>Default Time Out</span><div><input id="defaultTimeOut" type="time" value="${esc(data.defaultShiftEnd)}"></div><small>Default end of the employee workday.</small></label>
      <label class="functional-field"><span>Grace Period</span><div><input id="gracePeriod" type="number" min="0" max="120" value="${esc(data.graceMinutes)}"><b>minutes</b></div><small>Allowed time after scheduled Time In.</small></label>
      <label class="functional-field"><span>Lunch Break</span><div><input id="lunchBreakStart" type="time" value="${esc(data.lunchBreakStart)}"><b>to</b><input id="lunchBreakEnd" type="time" value="${esc(data.lunchBreakEnd)}"></div><small>Main unpaid break used by time-card calculations.</small></label>
      <label class="functional-field"><span>Afternoon Break</span><div><input id="breakStart" type="time" value="${esc(data.afternoonBreakStart)}"><b>to</b><input id="breakEnd" type="time" value="${esc(data.afternoonBreakEnd)}"></div><small>Configured afternoon break window.</small></label>
      <label class="functional-field"><span>Required Regular Hours</span><div><input id="regularHours" type="number" min="1" max="16" step="0.5" value="${esc(data.requiredPaidHours)}"><b>hours/day</b></div><small>Paid-hours target for one complete workday.</small></label>
      <div class="save-row functional-actions"><span id="generalSettingsSaveState" aria-live="polite">Change a value, then save.</span><button class="settings-action primary" id="saveGeneralSettings" type="submit"><i data-lucide="save"></i><span>Save General Settings</span></button></div>
    </form></article>`;
    attendancePanel.innerHTML = `<article class="panel functional-settings-panel"><div class="functional-panel-heading"><div><h3>Attendance Rules</h3><p>These values are used by the server when calculating time cards.</p></div><span class="live-settings-chip">Live server rules</span></div><div class="functional-settings-grid">
      <label class="functional-field"><span>Late grace period</span><div><input id="rulesGraceMinutes" type="number" min="0" max="120" value="${esc(data.graceMinutes)}"><b>minutes</b></div><small>Employees are marked late after this allowance.</small></label>
      <label class="functional-field"><span>Required paid hours</span><div><input id="rulesPaidHours" type="number" min="1" max="16" step="0.5" value="${esc(data.requiredPaidHours)}"><b>hours/day</b></div><small>Daily target used in paid-hours calculations.</small></label>
      <label class="functional-field"><span>Duplicate scan protection</span><div><input id="rulesDuplicateMinutes" type="number" min="1" max="60" value="${esc(data.duplicateScanDelayMinutes)}"><b>minutes</b></div><small>Ignores repeated fingerprint scans within this time.</small></label>
      ${switchRow('rulesEarlyOut', 'Early-out protection', 'Flag records when an employee leaves before schedule.', data.earlyOutProtectionEnabled)}
      ${switchRow('rulesEmergencyOut', 'Emergency Time Out', 'Allow password-protected emergency attendance correction.', data.emergencyTimeOutEnabled)}
    </div><div class="functional-actions"><button class="settings-action primary" id="saveAttendanceRules" type="button"><i data-lucide="save"></i> Save Attendance Rules</button></div></article>`;
    const popupOn = localStorage.getItem('gwdAttendancePopup') !== 'off';
    const soundOn = localStorage.getItem('gwdAttendanceSound') !== 'off';
    const deviceAlertOn = localStorage.getItem('gwdDeviceAlerts') !== 'off';
    notificationsPanel.innerHTML = `<article class="panel functional-settings-panel"><div class="functional-panel-heading"><div><h3>Notifications</h3><p>Control browser alerts shown by this attendance server.</p></div><span class="live-settings-chip">This browser</span></div><div class="functional-settings-list">
      ${switchRow('prefAttendancePopup', 'Time In / Time Out popup', 'Show the employee photo and scan details for new ESP32 records.', popupOn)}
      ${switchRow('prefAttendanceSound', 'Attendance notification sound', 'Play the supplied MP3 when a new scan is received.', soundOn)}
      ${switchRow('prefDeviceAlerts', 'Offline device alerts', 'Keep device connectivity warnings enabled on this browser.', deviceAlertOn)}
    </div><div class="functional-actions"><button class="settings-action secondary" id="settingsTestSound" type="button"><i data-lucide="volume-2"></i> Test Sound</button><button class="settings-action ghost" id="settingsPreviewScanModal" type="button"><i data-lucide="fingerprint"></i> Verifying</button><button class="settings-action ghost" id="settingsPreviewScanSuccess" type="button"><i data-lucide="badge-check"></i> Verify → Success</button><button class="settings-action ghost" id="settingsPreviewScanFailed" type="button"><i data-lucide="circle-x"></i> Verify → Failed</button><button class="settings-action primary" id="settingsPreviewPopup" type="button"><i data-lucide="log-in"></i> On Time</button><button class="settings-action popup-preview-blue" id="settingsPreviewTimeOut" type="button"><i data-lucide="log-out"></i> Time Out</button><button class="settings-action popup-preview-yellow" id="settingsPreviewLate" type="button"><i data-lucide="clock-alert"></i> Late</button><button class="settings-action popup-preview-red" id="settingsPreviewEmergency" type="button"><i data-lucide="triangle-alert"></i> Emergency</button></div></article>`;
    devicesPanel.innerHTML = `<article class="panel functional-settings-panel"><div class="functional-panel-heading"><div><h3>Device Settings</h3><p>Live ESP32-S3 connectivity and device behavior.</p></div><span class="live-settings-chip" id="settingsDeviceState">Checking...</span></div><div class="functional-settings-grid">
      <div class="functional-info-card"><span>Registered readers</span><strong id="settingsReaderTotal">—</strong><small>Readers known by the attendance server.</small></div>
      <div class="functional-info-card"><span>Online now</span><strong id="settingsReaderOnline">—</strong><small>Readers with a current heartbeat.</small></div>
      <label class="functional-field"><span>ESP32 display duration</span><div><input id="settingsDisplaySeconds" type="number" min="1" max="15" value="${Math.round(Number(data.esp32DisplayDurationMs || 5000) / 1000)}"><b>seconds</b></div><small>How long server messages stay on the OLED.</small></label>
      <div class="functional-info-card"><span>Offline storage</span><strong>Enabled by firmware</strong><small>Pending records sync automatically when the server returns.</small></div>
    </div><div class="functional-actions"><button class="settings-action secondary" id="refreshSettingsDevices" type="button"><i data-lucide="refresh-cw"></i> Refresh Status</button><button class="settings-action primary" id="saveDeviceSettings" type="button"><i data-lucide="save"></i> Save Device Setting</button><button class="settings-action ghost" id="openDevicesPage" type="button"><i data-lucide="external-link"></i> Open Devices</button></div></article>`;
    systemPanel.innerHTML = `<article class="panel functional-settings-panel"><div class="functional-panel-heading"><div><h3>System</h3><p>Current local attendance-server health and useful administration links.</p></div><span class="live-settings-chip" id="settingsHealthChip">Checking...</span></div><div class="functional-settings-grid">
      <div class="functional-info-card"><span>Server status</span><strong id="settingsServerStatus">Checking...</strong><small id="settingsServerTime">Waiting for health response.</small></div>
      <div class="functional-info-card"><span>Timezone</span><strong id="settingsTimezone">—</strong><small>Timezone used for attendance records.</small></div>
      <div class="functional-info-card"><span>Schema version</span><strong id="settingsSchema">—</strong><small>Current local database structure.</small></div>
      <div class="functional-info-card"><span>Server address</span><strong>${esc(location.origin)}</strong><small>Local URL used by this browser.</small></div>
    </div><div class="functional-actions settings-system-actions"><button class="settings-action danger" id="settingsLogout" type="button"><i data-lucide="log-out"></i> Sign Out</button><button class="settings-action secondary" id="refreshSystemHealth" type="button"><i data-lucide="activity"></i> Check Health</button><button class="settings-action primary" id="openSystemLogs" type="button"><i data-lucide="list"></i> Open Logs</button></div></article>`;
    backupPanel.innerHTML = `<article class="panel functional-settings-panel"><div class="functional-panel-heading"><div><h3>Backup & Maintenance</h3><p>Safe tools for downloading and validating local attendance data.</p></div><span class="live-settings-chip">Local database</span></div><div class="functional-settings-grid">
      <div class="functional-action-card"><i data-lucide="download"></i><div><strong>Download Database Backup</strong><small>Save employees, fingerprints, schedules, attendance and settings as JSON.</small></div><button id="downloadDatabaseBackup" type="button">Download Backup</button></div>
      <div class="functional-action-card"><i data-lucide="badge-check"></i><div><strong>Validate Server & Database</strong><small>Run a safe health check without changing any records.</small></div><button id="validateDatabase" type="button">Run Validation</button></div>
      <div class="functional-action-card"><i data-lucide="scroll-text"></i><div><strong>Review Attendance Logs</strong><small>Open the live log page to review saved scanner records.</small></div><button id="reviewDatabaseLogs" type="button">View Logs</button></div>
      <div class="functional-action-card"><i data-lucide="trash-2"></i><div><strong>Clear Attendance Logs</strong><small>Permanently remove all attendance logs after administrator password verification.</small></div><button class="danger" id="clearAttendanceLogs" type="button">Clear Logs</button></div>
      <div class="functional-action-card"><i data-lucide="file-pen-line"></i><div><strong>Edit Attendance</strong><small>Add a protected Time In or Time Out correction to an employee record.</small></div><button id="editAttendanceSecret" type="button">Edit Attendance</button></div>
      <div class="functional-action-card"><i data-lucide="refresh-cw"></i><div><strong>Reload Live Settings</strong><small>Discard unsaved fields and fetch the latest server values.</small></div><button id="reloadLiveSettings" type="button">Reload</button></div>
    </div><p class="functional-safety-note"><i data-lucide="shield-check"></i> PostgreSQL restore requires explicit validation and the server-side <code>-Apply</code> switch.</p></article>`;
    bindFunctionalSettingsControls();
    $('generalSettingsForm')?.addEventListener('submit', saveSettings, true);
    refreshSettingsDeviceStatus();
    refreshSettingsHealth();
    window.lucide?.createIcons();
  }

  async function saveSettingsPatch(payload, message) {
    await api('/api/settings', { method: 'POST', body: JSON.stringify(payload) });
    toast(message);
  }

  async function refreshSettingsDeviceStatus() {
    try {
      const { readers } = await api('/api/readers');
      const online = readers.filter((reader) => reader.online).length;
      if ($('settingsReaderTotal')) $('settingsReaderTotal').textContent = readers.length;
      if ($('settingsReaderOnline')) $('settingsReaderOnline').textContent = online;
      if ($('settingsDeviceState')) $('settingsDeviceState').textContent = `${online} online • ${readers.length - online} offline`;
    } catch (error) { toast(error.message); }
  }

  async function refreshSettingsHealth() {
    try {
      const health = await fetch('/health').then((response) => response.json());
      if ($('settingsServerStatus')) $('settingsServerStatus').textContent = health.ok ? 'Healthy' : 'Needs attention';
      if ($('settingsServerTime')) $('settingsServerTime').textContent = `Checked ${when(health.serverTime)}`;
      if ($('settingsTimezone')) $('settingsTimezone').textContent = health.timezone || 'Asia/Manila';
      if ($('settingsSchema')) $('settingsSchema').textContent = health.schemaVersion || '—';
      if ($('settingsHealthChip')) $('settingsHealthChip').textContent = health.ok ? 'Server healthy' : 'Check required';
      return health;
    } catch (error) { if ($('settingsHealthChip')) $('settingsHealthChip').textContent = 'Server unavailable'; throw error; }
  }

  function bindFunctionalSettingsControls() {
    $('saveAttendanceRules')?.addEventListener('click', () => saveSettingsPatch({ graceMinutes: Number($('rulesGraceMinutes').value), requiredPaidHours: Number($('rulesPaidHours').value), duplicateScanDelayMinutes: Number($('rulesDuplicateMinutes').value), earlyOutProtectionEnabled: $('rulesEarlyOut').checked, emergencyTimeOutEnabled: $('rulesEmergencyOut').checked }, 'Attendance rules saved.').catch((error) => toast(error.message)));
    ['prefAttendancePopup', 'prefAttendanceSound', 'prefDeviceAlerts'].forEach((id) => $(id)?.addEventListener('change', () => {
      const keys = { prefAttendancePopup: 'gwdAttendancePopup', prefAttendanceSound: 'gwdAttendanceSound', prefDeviceAlerts: 'gwdDeviceAlerts' };
      localStorage.setItem(keys[id], $(id).checked ? 'on' : 'off'); toast('Notification preference saved for this browser.');
    }));
    $('settingsTestSound')?.addEventListener('click', () => { attendanceNotificationAudio.pause(); attendanceNotificationAudio.currentTime = 0; attendanceNotificationAudio.volume = .82; attendanceNotificationAudio.play().catch(() => null); toast('Playing notification sound.'); });
    $('settingsPreviewScanModal')?.addEventListener('click', () => {
      startScanPreviewSequence('success');
    });
    $('settingsPreviewScanSuccess')?.addEventListener('click', () => {
      startScanPreviewSequence('success');
    });
    $('settingsPreviewScanFailed')?.addEventListener('click', () => {
      startScanPreviewSequence('failed');
    });
    $('settingsPreviewPopup')?.addEventListener('click', () => showAttendancePopup({ fullName: 'James Malit', attendanceType: 'TIME_IN', timestamp: new Date().toISOString(), deviceId: 'ESP32-S3', message: 'Preview of a successful fingerprint attendance scan.' }, true));
    $('settingsPreviewTimeOut')?.addEventListener('click', () => showAttendancePopup({ fullName: 'James Malit', attendanceType: 'TIME_OUT', timestamp: new Date().toISOString(), deviceId: 'ESP32-S3', message: 'Preview of a successfully recorded time out.' }, true));
    $('settingsPreviewLate')?.addEventListener('click', () => showAttendancePopup({ fullName: 'James Malit', attendanceType: 'TIME_IN', status: 'LATE', lateMinutes: 12, timestamp: new Date().toISOString(), deviceId: 'ESP32-S3', message: 'Preview of a late attendance warning.' }, true));
    $('settingsPreviewEmergency')?.addEventListener('click', () => showAttendancePopup({ fullName: 'James Malit', attendanceType: 'TIME_OUT', status: 'EMERGENCY', timestamp: new Date().toISOString(), deviceId: 'ESP32-S3', message: 'Preview of an emergency attendance event.' }, true));
    $('refreshSettingsDevices')?.addEventListener('click', refreshSettingsDeviceStatus);
    $('saveDeviceSettings')?.addEventListener('click', () => saveSettingsPatch({ esp32DisplayDurationMs: Number($('settingsDisplaySeconds').value) * 1000 }, 'ESP32 display setting saved.').catch((error) => toast(error.message)));
    $('openDevicesPage')?.addEventListener('click', () => { location.href = '/devices'; });
    $('settingsLogout')?.addEventListener('click', async () => {
      const button = $('settingsLogout');
      if (button) { button.disabled = true; button.innerHTML = '<i data-lucide="loader-circle"></i> Signing out...'; window.lucide?.createIcons(); }
      try {
        await fetch('/api/auth/logout', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      } finally {
        window.location.replace('/');
      }
    });
    $('refreshSystemHealth')?.addEventListener('click', () => refreshSettingsHealth().then(() => toast('Server health check passed.')).catch((error) => toast(error.message)));
    $('openSystemLogs')?.addEventListener('click', () => { location.href = '/logs'; });
    $('downloadDatabaseBackup')?.addEventListener('click', () => { location.href = '/api/export/db'; });
    $('validateDatabase')?.addEventListener('click', () => refreshSettingsHealth().then(() => toast('Server and database validation passed.')).catch((error) => toast(error.message)));
    $('reviewDatabaseLogs')?.addEventListener('click', () => { location.href = '/logs'; });
    $('clearAttendanceLogs')?.addEventListener('click', clearAttendanceLogsFromSettings);
    $('editAttendanceSecret')?.addEventListener('click', openAttendanceEditor);
    $('reloadLiveSettings')?.addEventListener('click', () => location.reload());
  }

  async function clearAttendanceLogsFromSettings() {
    const host = document.createElement('div');
    host.className = 'functional-secret-modal clear-logs-modal';
    host.innerHTML = `<div class="functional-secret-dialog clear-logs-dialog" role="dialog" aria-modal="true" aria-labelledby="clearLogsTitle">
      <button class="clear-logs-close" data-close-clear type="button" aria-label="Close">&times;</button>
      <div class="clear-logs-icon"><i data-lucide="trash-2"></i></div>
      <div class="clear-logs-copy"><span>Danger zone</span><h3 id="clearLogsTitle">Clear Attendance Logs</h3><p>This permanently deletes every saved Time In and Time Out record. Employee profiles and fingerprint registrations will remain.</p></div>
      <form id="clearLogsForm" class="clear-logs-step">
        <label for="clearLogsPassword">Administrator password</label>
        <div class="clear-logs-password"><i data-lucide="lock-keyhole"></i><input id="clearLogsPassword" type="password" autocomplete="current-password" placeholder="Enter your password" required><button id="toggleClearLogsPassword" type="button">Show</button></div>
        <p class="clear-logs-warning"><i data-lucide="triangle-alert"></i><span><strong>This action cannot be undone.</strong> Download a database backup first if these records may still be needed.</span></p>
        <p class="clear-logs-error" id="clearLogsError" aria-live="polite"></p>
        <div class="clear-logs-actions"><button class="settings-action secondary" data-close-clear type="button">Cancel</button><button class="settings-action danger confirm-clear" type="submit"><span>Continue</span><i data-lucide="arrow-right"></i></button></div>
      </form>
      <section class="clear-logs-step clear-logs-final" id="clearLogsFinal" hidden>
        <div class="clear-logs-final-icon"><i data-lucide="shield-alert"></i></div>
        <h4>Confirm permanent deletion</h4>
        <p>You are about to permanently remove all attendance logs. Double-check that this is the action you intended.</p>
        <label class="clear-logs-check"><input id="clearLogsAcknowledge" type="checkbox"><span>I understand that deleted attendance logs cannot be recovered.</span></label>
        <p class="clear-logs-error" id="clearLogsFinalError" aria-live="polite"></p>
        <div class="clear-logs-actions"><button class="settings-action secondary" id="backToClearPassword" type="button"><i data-lucide="arrow-left"></i> Back</button><button class="settings-action danger confirm-clear" id="finalClearLogs" type="button" disabled><i data-lucide="trash-2"></i><span>Yes, Clear All Logs</span></button></div>
      </section>
    </div>`;
    document.body.appendChild(host);
    const passwordInput = host.querySelector('#clearLogsPassword');
    const close = () => host.remove();
    host.addEventListener('click', (event) => { if (event.target === host || event.target.closest('[data-close-clear]')) close(); });
    host.querySelector('#toggleClearLogsPassword').addEventListener('click', (event) => {
      const show = passwordInput.type === 'password';
      passwordInput.type = show ? 'text' : 'password';
      event.currentTarget.textContent = show ? 'Hide' : 'Show';
      passwordInput.focus();
    });
    const form = host.querySelector('form');
    const finalStep = host.querySelector('#clearLogsFinal');
    const acknowledge = host.querySelector('#clearLogsAcknowledge');
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const errorText = host.querySelector('#clearLogsError');
      errorText.textContent = '';
      if (!passwordInput.value) { errorText.textContent = 'Administrator password is required.'; passwordInput.focus(); return; }
      form.hidden = true;
      finalStep.hidden = false;
      acknowledge.focus();
    });
    host.querySelector('#backToClearPassword').addEventListener('click', () => {
      finalStep.hidden = true;
      form.hidden = false;
      acknowledge.checked = false;
      host.querySelector('#finalClearLogs').disabled = true;
      passwordInput.focus();
    });
    acknowledge.addEventListener('change', () => { host.querySelector('#finalClearLogs').disabled = !acknowledge.checked; });
    host.querySelector('#finalClearLogs').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      const errorText = host.querySelector('#clearLogsFinalError');
      errorText.textContent = '';
      button.disabled = true;
      button.querySelector('span').textContent = 'Clearing...';
      try {
        const result = await api('/api/admin/clear-attendance', { method: 'POST', body: JSON.stringify({ password: passwordInput.value }) });
        close();
        toast(`${Number(result.deleted || 0)} attendance log${Number(result.deleted || 0) === 1 ? '' : 's'} cleared.`);
      } catch (error) {
        errorText.textContent = error.message;
        button.disabled = false;
        button.querySelector('span').textContent = 'Yes, Clear All Logs';
      }
    });
    window.lucide?.createIcons();
    setTimeout(() => passwordInput.focus(), 50);
  }

  async function openAttendanceEditor() {
    try {
      const [{ employees }, { attendance }] = await Promise.all([api('/api/employees'), api('/api/attendance?limit=500')]);
      const active = employees.filter((employee) => employee.active !== false);
      if (!active.length) return toast('Create an active employee first.');
      const records = attendance.filter((record) => record.employeeId && ['TIME_IN', 'TIME_OUT'].includes(String(record.attendanceType || record.type || '').toUpperCase()));
      const host = document.createElement('div');
      host.className = 'functional-secret-modal attendance-editor-modal';
      host.innerHTML = `<div class="attendance-editor-dialog" role="dialog" aria-modal="true" aria-labelledby="attendanceEditorTitle">
        <header class="attendance-editor-head"><div><span>Protected workspace</span><h3 id="attendanceEditorTitle">Edit Attendance</h3><p>Select an employee, review every saved scan, then edit the exact Time In or Time Out record.</p></div><button data-close-editor type="button"><i data-lucide="x"></i> Close</button></header>
        <div class="attendance-editor-layout">
          <aside class="attendance-employee-pane"><div class="attendance-pane-title"><strong>Employees</strong><span>${active.length}</span></div><label class="attendance-employee-search"><i data-lucide="search"></i><input id="attendanceEmployeeSearch" type="search" placeholder="Search employee" autocomplete="off"></label><div id="attendanceEmployeeList"></div></aside>
          <main class="attendance-record-pane"><div id="attendanceEditorEmployee"></div><div class="attendance-record-toolbar"><strong>Attendance records</strong><div class="attendance-record-toolbar-controls"><label for="attendanceMonth">Month</label><input id="attendanceMonth" type="month"><span id="attendanceRecordCount"></span></div></div><div id="attendanceRecordList"></div></main>
        </div>
      </div>`;
      document.body.appendChild(host);
      const close = () => host.remove();
      host.addEventListener('click', (event) => { if (event.target === host || event.target.closest('[data-close-editor]')) close(); });
      let selectedEmployeeId = active[0].id;
      const now = new Date();
      const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      let selectedMonth = todayKey.slice(0, 7);
      host.querySelector('#attendanceMonth').value = selectedMonth;
      host.querySelector('#attendanceMonth').max = selectedMonth;
      const employeeRecords = (employeeId) => records.filter((record) => record.employeeId === employeeId).sort((a, b) => new Date(b.scannedAt) - new Date(a.scannedAt));
      const recordStatus = (record) => {
        if (record.accepted === false || record.reviewStatus === 'CORRECTION_REQUESTED') return ['Pending', 'pending'];
        const type = String(record.attendanceType || record.type || '').toUpperCase();
        const punctuality = String(record.punctuality || record.statusText || '').toUpperCase();
        if (type === 'TIME_IN' && (Number(record.lateMinutes) > 0 || punctuality.includes('LATE'))) return [`Late${record.lateMinutes ? ` ${record.lateMinutes}m` : ''}`, 'late'];
        if (type === 'TIME_IN') return ['On Time', 'on-time'];
        if (Number(record.earlyOutMinutes) > 0 || punctuality.includes('EARLY')) return [`Early Out${record.earlyOutMinutes ? ` ${record.earlyOutMinutes}m` : ''}`, 'early-out'];
        if (punctuality.includes('SHORT')) return ['Short Hours', 'short'];
        if (punctuality.includes('OVERTIME')) return ['Overtime', 'overtime'];
        return ['Completed', 'completed'];
      };
      const localValue = (iso) => { const date = new Date(iso); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };
      const dailyRows = (employeeId, monthKey) => {
        const grouped = new Map();
        employeeRecords(employeeId).slice().reverse().forEach((record) => {
          const dateKey = localValue(record.scannedAt).slice(0, 10);
          if (!dateKey.startsWith(`${monthKey}-`)) return;
          const day = grouped.get(dateKey) || { dateKey, timeIn: null, timeOut: null };
          const type = String(record.attendanceType || record.type || '').toUpperCase();
          if (type === 'TIME_IN' && !day.timeIn) day.timeIn = record;
          if (type === 'TIME_OUT') day.timeOut = record;
          grouped.set(dateKey, day);
        });
        const [year, month] = monthKey.split('-').map(Number);
        const earliest = new Date(year, month - 1, 1, 12, 0, 0, 0);
        const latest = new Date(year, month, 0, 12, 0, 0, 0);
        const today = new Date(); today.setHours(12, 0, 0, 0);
        if (latest > today) latest.setTime(today.getTime());
        const employee = active.find((item) => item.id === employeeId);
        const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        for (let cursor = new Date(earliest); cursor <= latest; cursor.setDate(cursor.getDate() + 1)) {
          const dateKey = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
          const schedule = employee?.weeklySchedule?.[dayNames[cursor.getDay()]];
          const day = grouped.get(dateKey) || { dateKey, timeIn: null, timeOut: null };
          day.dayOff = schedule?.dayOff === true;
          grouped.set(dateKey, day);
        }
        return [...grouped.values()].sort((a, b) => b.dateKey.localeCompare(a.dateKey));
      };
      const dayStatus = (day) => {
        if (day.dayOff && !day.timeIn && !day.timeOut) return ['Day Off', 'day-off'];
        if (!day.timeIn && !day.timeOut) return ['Absent', 'absent'];
        if (!day.timeIn || !day.timeOut || day.timeIn.accepted === false || day.timeOut.accepted === false) return ['Pending', 'pending'];
        const inStatus = recordStatus(day.timeIn); const outStatus = recordStatus(day.timeOut);
        if (inStatus[1] === 'late' && outStatus[1] === 'early-out') return [`${inStatus[0]} / ${outStatus[0]}`, 'early-out'];
        if (outStatus[1] === 'early-out' || outStatus[1] === 'short') return outStatus;
        if (inStatus[1] === 'late') return inStatus;
        if (outStatus[1] === 'overtime') return outStatus;
        return ['On Time / Completed', 'completed'];
      };
      const renderEmployees = () => {
        const query = host.querySelector('#attendanceEmployeeSearch').value.trim().toLowerCase();
        host.querySelector('#attendanceEmployeeList').innerHTML = active.filter((employee) => !query || `${employee.fullName} ${employee.employeeCode || ''}`.toLowerCase().includes(query)).map((employee) => {
          const count = employeeRecords(employee.id).length;
          return `<button class="attendance-employee-item ${employee.id === selectedEmployeeId ? 'active' : ''}" data-attendance-employee="${esc(employee.id)}"><span class="attendance-editor-avatar">${employeeAvatar(employee)}</span><span><strong>${esc(employee.fullName)}</strong><small>${esc(employee.employeeCode || employee.department || 'Employee')}</small></span><b>${count}</b></button>`;
        }).join('') || '<p class="attendance-editor-empty">No employee found.</p>';
      };
      const renderRecords = () => {
        const employee = active.find((item) => item.id === selectedEmployeeId);
        const scans = employeeRecords(selectedEmployeeId).filter((record) => localValue(record.scannedAt).startsWith(selectedMonth));
        const rows = dailyRows(selectedEmployeeId, selectedMonth);
        host.querySelector('#attendanceEditorEmployee').innerHTML = `<div class="attendance-selected-person"><span class="attendance-editor-avatar">${employeeAvatar(employee)}</span><div><strong>${esc(employee.fullName)}</strong><small>${esc(employee.employeeCode || '')}${employee.department ? ` &bull; ${esc(employee.department)}` : ''}</small></div></div>`;
        host.querySelector('#attendanceRecordCount').textContent = `${rows.length} day${rows.length === 1 ? '' : 's'} · ${scans.length} saved scans`;
        host.querySelector('#attendanceRecordList').innerHTML = rows.length ? `<div class="attendance-record-columns"><span>Date</span><span>Time In</span><span>Time Out</span><span>Status</span><span>Password</span><span>Action</span></div>${rows.map((day) => {
          const status = dayStatus(day); const date = new Date(`${day.dateKey}T12:00:00`);
          return `<form class="attendance-record-row" data-date-key="${day.dateKey}" data-employee-id="${esc(employee.id)}" data-time-in-id="${esc(day.timeIn?.id || '')}" data-time-out-id="${esc(day.timeOut?.id || '')}"><div class="attendance-record-date"><strong>${esc(date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }))}</strong><small>${esc(date.toLocaleDateString(undefined, { weekday: 'long' }))}</small></div><label><span>Time In</span><input name="timeIn" type="time" value="${day.timeIn ? localValue(day.timeIn.scannedAt).slice(11, 16) : ''}" placeholder="Add Time In"></label><label><span>Time Out</span><input name="timeOut" type="time" value="${day.timeOut ? localValue(day.timeOut.scannedAt).slice(11, 16) : ''}" placeholder="Add Time Out"></label><span class="attendance-auto-status ${status[1]}">${esc(status[0])}</span><label class="attendance-edit-password"><span>Password</span><input name="password" type="password" placeholder="Required to edit" required></label><button type="submit"><i data-lucide="save"></i> Save</button><p class="attendance-row-message" aria-live="polite"></p></form>`;
        }).join('')}` : '<div class="attendance-editor-empty large"><i data-lucide="calendar-x"></i><strong>No attendance records</strong><span>This employee has no saved Time In or Time Out scans.</span></div>';
        window.lucide?.createIcons();
      };
      host.querySelector('#attendanceEmployeeSearch').addEventListener('input', renderEmployees);
      host.querySelector('#attendanceMonth').addEventListener('change', (event) => { selectedMonth = event.target.value || todayKey.slice(0, 7); renderRecords(); });
      host.querySelector('#attendanceEmployeeList').addEventListener('click', (event) => { const button = event.target.closest('[data-attendance-employee]'); if (!button) return; selectedEmployeeId = button.dataset.attendanceEmployee; renderEmployees(); renderRecords(); });
      host.querySelector('#attendanceRecordList').addEventListener('submit', async (event) => {
        const form = event.target.closest('.attendance-record-row'); if (!form) return; event.preventDefault();
        const button = event.submitter; const message = form.querySelector('.attendance-row-message');
        const edits = [{ id: form.dataset.timeInId, field: 'timeIn', type: 'TIME_IN' }, { id: form.dataset.timeOutId, field: 'timeOut', type: 'TIME_OUT' }];
        button.disabled = true; message.textContent = 'Saving correction...'; message.className = 'attendance-row-message';
        try {
          for (const edit of edits) {
            const record = records.find((item) => item.id === edit.id); const input = form.elements[edit.field];
            if (!input?.value || (record && localValue(record.scannedAt).slice(11, 16) === input.value)) continue;
            const correctedDate = new Date(`${form.dataset.dateKey}T${input.value}:00`);
            if (record) {
              const result = await api(`/api/admin/attendance/${encodeURIComponent(record.id)}`, { method: 'PATCH', body: JSON.stringify({ attendanceType: edit.type, scannedAt: correctedDate.toISOString(), password: form.elements.password.value, reason: 'Attendance correction' }) });
              Object.assign(record, result.attendance);
            } else {
              await api('/api/admin/emergency-attendance', { method: 'POST', body: JSON.stringify({ employeeId: form.dataset.employeeId, attendanceType: edit.type, scannedAt: correctedDate.toISOString(), password: form.elements.password.value, reason: 'Attendance correction', approvedBy: 'Administrator' }) });
            }
          }
          const refreshed = await api('/api/attendance?limit=500'); records.splice(0, records.length, ...refreshed.attendance.filter((record) => record.employeeId));
          form.elements.password.value = ''; renderEmployees(); renderRecords();
          toast('Daily attendance updated and status recalculated.');
          if (location.pathname === '/timecard') timecard().catch((error) => toast(error.message));
        } catch (error) { message.textContent = error.message; message.className = 'attendance-row-message error'; button.disabled = false; }
      });
      renderEmployees(); renderRecords();
      window.lucide?.createIcons();
    } catch (error) { toast(error.message); }
  }

  async function saveSettings(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const button = $('saveGeneralSettings');
    const state = $('generalSettingsSaveState');
    if (button) { button.disabled = true; button.classList.add('is-saving'); }
    if (state) state.textContent = 'Saving settings to server...';
    const payload = {
      branchName: $('branchSelect')?.value,
      defaultShiftStart: $('defaultTimeIn')?.value,
      defaultShiftEnd: $('defaultTimeOut')?.value,
      graceMinutes: Number($('gracePeriod')?.value || 0),
      afternoonBreakStart: $('breakStart')?.value,
      afternoonBreakEnd: $('breakEnd')?.value,
      lunchBreakStart: $('lunchBreakStart')?.value,
      lunchBreakEnd: $('lunchBreakEnd')?.value,
      requiredPaidHours: Number($('regularHours')?.value || 8)
    };
    try {
      await api('/api/settings', { method: 'POST', body: JSON.stringify(payload) });
      if (state) state.textContent = 'Saved successfully on the server.';
      toast('Settings saved to the attendance server.');
    } catch (error) {
      if (state) state.textContent = `Save failed: ${error.message}`;
      toast(error.message);
    } finally {
      if (button) { button.disabled = false; button.classList.remove('is-saving'); }
    }
  }

  let liveEmployeeAccounts = [];
  let accountEmployees = [];
  let currentManagedUser = null;
  function renderEmployeeAccountRows() {
    const query = ($('accountSearch')?.value || '').trim().toLowerCase();
    const status = $('accountStatusFilter')?.value || 'all';
    const filtered = liveEmployeeAccounts.filter((account) => {
      const matchesQuery = !query || [account.employeeName, account.employeeCode, account.username, account.phone, account.role].some((value) => String(value || '').toLowerCase().includes(query));
      const matchesStatus = status === 'all' || (status === 'active' ? account.active : !account.active);
      return matchesQuery && matchesStatus;
    });
    $('employeeAccountRows').innerHTML = filtered.length ? filtered.map((account) => `<tr><td><strong>${esc(account.role === 'employee' ? account.employeeName : account.username)}</strong><small>${account.role === 'employee' ? esc(account.employeeCode || '—') : 'Managed portal account'}</small></td><td><span class="account-role ${esc(account.role)}">${esc(String(account.role).toUpperCase())}</span></td><td><span class="account-username">${esc(account.username)}</span><small>${esc(account.phone || 'No phone bound')}</small></td><td><span class="social-binding phone-binding ${account.socialConnections?.phone ? 'connected' : ''}" title="Phone"></span><span class="social-binding google-binding ${account.socialConnections?.google ? 'connected' : ''}" title="Google"></span><span class="social-binding facebook-binding ${account.socialConnections?.facebook ? 'connected' : ''}" title="Facebook"></span></td><td><span class="account-status ${account.active ? '' : 'inactive'}">${account.active ? 'Active' : 'Disabled'}</span></td><td>${esc(when(account.updatedAt))}</td><td><div class="account-row-actions"><button data-edit-account="${esc(account.id)}">Edit</button><button class="delete" data-delete-account="${esc(account.id)}">Delete</button></div></td></tr>`).join('') : `<tr><td colspan="7" class="accounts-empty">${liveEmployeeAccounts.length ? 'No accounts match this search or filter.' : 'No managed accounts yet. Click “Add Account” to create one.'}</td></tr>`;
  }
  function openAccountModal(account = null) {
    const assignedIds = new Set(liveEmployeeAccounts.filter((item) => item.id !== account?.id).map((item) => item.employeeId));
    const availableEmployees = accountEmployees.filter((employee) => !assignedIds.has(employee.id));
    $('editingAccountId').value = account?.id || '';
    $('accountModalTitle').textContent = account ? 'Edit Account' : 'Add Account';
    $('accountRole').value = account?.role || 'employee';
    $('accountEmployee').innerHTML = availableEmployees.length ? availableEmployees.map((employee) => `<option value="${esc(employee.id)}">${esc(employee.fullName)} · ${esc(employee.employeeCode || employee.id.slice(-8))}</option>`).join('') : '<option value="">All employees already have an account</option>';
    $('accountEmployee').value = account?.employeeId || availableEmployees[0]?.id || '';
    const employeeRole = $('accountRole').value === 'employee';
    $('accountEmployeeField').hidden = !employeeRole;
    $('accountEmployee').disabled = !employeeRole || !availableEmployees.length;
    $('accountEmployee').required = employeeRole;
    $('accountUsername').value = account?.username || '';
    $('accountPhone').value = account?.phone || '';
    $('accountPassword').value = '';
    $('accountPassword').type = 'password';
    $('toggleAccountPassword').textContent = 'Show';
    $('accountPassword').required = !account;
    $('accountPasswordHelp').textContent = account ? 'Leave blank to keep the current password.' : 'Required for new accounts. Minimum 8 characters.';
    $('accountActiveInput').checked = account?.active !== false;
    const ownAccount = Boolean(account && currentManagedUser?.managedAccount && account.username === currentManagedUser.username && account.role === currentManagedUser.role);
    const connections = account?.socialConnections || {};
    $('modalPhoneBinding').classList.toggle('connected', Boolean(account?.phone));
    $('modalPhoneStatus').textContent = account?.phone || 'Not bound';
    [['Google', 'google'], ['Facebook', 'facebook']].forEach(([label, provider]) => {
      const connected = Boolean(connections[provider]);
      $(`modal${label}Binding`).classList.toggle('connected', connected);
      $(`modal${label}Status`).textContent = connected ? 'Connected' : 'Not connected';
      const bind = $(`modalBind${label}`); bind.disabled = !ownAccount; bind.textContent = connected ? 'Reconnect' : 'Bind';
    });
    $('accountBindHelp').textContent = !account ? 'Save the account first. The account owner can bind after signing in.' : ownAccount ? 'You are editing your own account. You can bind or reconnect a provider now.' : 'For security, the account owner must sign in and personally authorize Google or Facebook.';
    $('accountFormMessage').textContent = '';
    $('saveEmployeeAccount').disabled = employeeRole && !availableEmployees.length;
    $('accountModal').hidden = false;
    (availableEmployees.length ? $('accountUsername') : $('closeAccountModal')).focus();
  }
  async function employeeAccounts() {
    const [accountResult, employeeResult, authResult] = await Promise.all([api('/api/employee-accounts'), api('/api/employees'), api('/api/auth/me')]);
    liveEmployeeAccounts = accountResult.accounts || [];
    accountEmployees = employeeResult.employees || [];
    currentManagedUser = authResult;
    $('accountTotal').textContent = liveEmployeeAccounts.length;
    $('accountActive').textContent = liveEmployeeAccounts.filter((item) => item.active).length;
    const employeeAccountCount = liveEmployeeAccounts.filter((item) => item.role === 'employee').length;
    $('accountMissing').textContent = Math.max(0, accountEmployees.length - employeeAccountCount);
    renderEmployeeAccountRows();
    $('accountsPageMessage').textContent = `${liveEmployeeAccounts.length} account${liveEmployeeAccounts.length === 1 ? '' : 's'} linked to ${accountEmployees.length} employee${accountEmployees.length === 1 ? '' : 's'}.`;
    window.lucide?.createIcons();
  }
  function bindEmployeeAccountControls() {
    $('addEmployeeAccount')?.addEventListener('click', () => openAccountModal());
    ['closeAccountModal', 'cancelAccountModal'].forEach((id) => $(id)?.addEventListener('click', () => { $('accountModal').hidden = true; }));
    $('accountSearch')?.addEventListener('input', renderEmployeeAccountRows);
    $('accountStatusFilter')?.addEventListener('change', renderEmployeeAccountRows);
    $('accountRole')?.addEventListener('change', () => {
      const employeeRole = $('accountRole').value === 'employee';
      $('accountEmployeeField').hidden = !employeeRole;
      $('accountEmployee').disabled = !employeeRole;
      $('accountEmployee').required = employeeRole;
      $('saveEmployeeAccount').disabled = employeeRole && !$('accountEmployee').value;
    });
    $('toggleAccountPassword')?.addEventListener('click', () => { const input = $('accountPassword'); const show = input.type === 'password'; input.type = show ? 'text' : 'password'; $('toggleAccountPassword').textContent = show ? 'Hide' : 'Show'; });
    $('modalBindPhone')?.addEventListener('click', () => $('accountPhone').focus());
    $('accountModal')?.addEventListener('click', (event) => { if (event.target === $('accountModal')) $('accountModal').hidden = true; });
    $('employeeAccountRows')?.addEventListener('click', async (event) => {
      const edit = event.target.closest('[data-edit-account]');
      if (edit) return openAccountModal(liveEmployeeAccounts.find((item) => item.id === edit.dataset.editAccount));
      const remove = event.target.closest('[data-delete-account]');
      if (!remove || !confirm('Delete this login account and its social bindings?')) return;
      await api(`/api/employee-accounts/${encodeURIComponent(remove.dataset.deleteAccount)}`, { method: 'DELETE' });
      toast('Account deleted.'); await employeeAccounts();
    });
    $('employeeAccountForm')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const id = $('editingAccountId').value;
      const payload = { role: $('accountRole').value, employeeId: $('accountRole').value === 'employee' ? $('accountEmployee').value : '', username: $('accountUsername').value.trim(), phone: $('accountPhone').value.trim(), password: $('accountPassword').value, active: $('accountActiveInput').checked };
      try {
        await api(id ? `/api/employee-accounts/${encodeURIComponent(id)}` : '/api/employee-accounts', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(payload) });
        $('accountModal').hidden = true; toast(id ? 'Account updated.' : 'Account created.'); await employeeAccounts();
      } catch (error) { $('accountFormMessage').textContent = error.message; }
    });
  }

  const path = location.pathname === '/' ? '/dashboard' : location.pathname;
  document.body.classList.add(`page-${path.slice(1) || 'dashboard'}`);
  if (!['/dashboard', '/timecard'].includes(path)) {
    document.body.classList.add('live-page-entering');
    requestAnimationFrame(() => requestAnimationFrame(() => {
      document.body.classList.remove('live-page-entering');
      document.body.classList.add('live-page-ready');
    }));
  }
  const runners = { '/dashboard': dashboard, '/devices': devices, '/employees': employees,
    '/enrollment': enrollment, '/logs': logs, '/timecard': timecard, '/settings': settings, '/accounts': employeeAccounts };
  const run = runners[path];
  const safeRun = async () => {
    try {
      await run?.();

      // Every page runner can update the DOM asynchronously.
      // Restore Lucide icons after Dashboard, Time Card, Devices, and other pages render.
      refreshLucideIcons();
    } catch (error) {
      console.error(error);
      document.body.classList.remove('live-dashboard-loading');
      document.body.classList.remove('live-timecard-loading');
      document.body.classList.add('live-dashboard-ready');
      if (path === '/timecard') document.body.classList.add('live-timecard-ready');

      refreshLucideIcons();
      toast(error.message);
    }
  };

  installCanonicalSidebar(path);
  installSharedBrand();

  // Run once after the shared layout has been installed.
  refreshLucideIcons();

  (async () => {
    await loadSharedIdentity();
    if (currentUser?.role === 'viewer' && ['/enrollment', '/accounts', '/settings'].includes(path)) return;
    if (path === '/accounts') bindEmployeeAccountControls();
    if (path === '/dashboard') bindLiveDashboardControls(safeRun);
    if (path === '/employees' && currentUser?.role !== 'viewer') $('employeeForm')?.addEventListener('submit', saveEmployee, true);
    if (path === '/enrollment' && currentUser?.role !== 'viewer') {
      $('startEnrollmentButton')?.addEventListener('click', (event) => startEnrollment(event).catch((error) => toast(error.message)), true);
      $('registrationForm')?.addEventListener('submit', registerForEnrollment, true);
    }
    if (path === '/settings' && currentUser?.role === 'admin') {
      bindSettingsTabs();
      $('generalSettingsForm')?.addEventListener('submit', saveSettings, true);
    }
    const modalBackdrop = $('modalBackdrop');
    if (modalBackdrop) {
      $('modalClose')?.addEventListener('click', () => modalBackdrop.classList.remove('show'), true);
      $('modalCancel')?.addEventListener('click', () => {
        if (modalBackdrop.dataset.modalMode !== 'attendance-review') modalBackdrop.classList.remove('show');
      }, true);
      modalBackdrop.addEventListener('click', (event) => {
        if (event.target === modalBackdrop) modalBackdrop.classList.remove('show');
      }, true);
    }
    ['refreshButton', 'refreshDevicesButton', 'refreshLogsButton', 'loadButton'].forEach((id) =>
      $(id)?.addEventListener('click', (event) => { event.preventDefault(); event.stopImmediatePropagation(); safeRun(); }, true));
    safeRun();
    startAttendancePopupMonitor();
    if (['/dashboard', '/devices', '/logs'].includes(path)) setInterval(safeRun, 5000);
  })().catch((error) => {
    console.error(error);
    toast(error.message);
  });
})();
