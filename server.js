'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { createClient } = require('@supabase/supabase-js');

function loadEnvironmentFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvironmentFile(path.join(__dirname, '.env'));
const storage = require('./storage');

const PORT = Number(process.env.PORT || 3000);
const API_KEY = String(process.env.API_KEY || process.env.ATTENDANCE_API_KEY || '').trim();
const DEVICE_TIMEZONE = process.env.DEVICE_TIMEZONE || 'Asia/Manila';
const DUPLICATE_SECONDS = Number(process.env.DUPLICATE_SECONDS || 180);
const DEFAULT_DEVICE_DISPLAY_MS = Number(process.env.DEVICE_DISPLAY_MS || 3000);
const UNRECORDED_LOG_RETENTION_HOURS = Number(process.env.UNRECORDED_LOG_RETENTION_HOURS || 24);
const MAX_UNRECORDED_ATTENDANCE_LOGS = Number(process.env.MAX_UNRECORDED_ATTENDANCE_LOGS || 50);
const REQUESTS_PER_MINUTE = Math.max(30, Number(process.env.REQUESTS_PER_MINUTE || 300));
const AUTH_ATTEMPTS_PER_15_MINUTES = Math.max(3, Number(process.env.AUTH_ATTEMPTS_PER_15_MINUTES || 10));
const SESSION_TTL_MS = Math.max(15 * 60 * 1000, Number(process.env.SESSION_TTL_HOURS || 12) * 60 * 60 * 1000);
const TRUST_PROXY = process.env.TRUST_PROXY === 'true';
const ENABLE_TEST_ENDPOINTS = process.env.ENABLE_TEST_ENDPOINTS === 'true';
const CLOUD_MODE = process.env.CLOUD_MODE === 'true' || process.env.RENDER === 'true';
const EMERGENCY_ATTENDANCE_PASSWORD = String(process.env.EMERGENCY_ATTENDANCE_PASSWORD || '').trim();
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const ROLE_CREDENTIALS = [
  ['admin', process.env.ADMIN_USERNAME, process.env.ADMIN_PASSWORD],
  ['hr', process.env.HR_USERNAME, process.env.HR_PASSWORD],
  ['viewer', process.env.VIEWER_USERNAME, process.env.VIEWER_PASSWORD]
].filter(([, username, password]) => username && password).map(([role, username, password]) => ({ role, username: String(username), password: String(password) }));
const DEVICE_API_KEYS = new Map(String(process.env.DEVICE_API_KEYS || '').split(',').map((entry) => {
  const separator = entry.indexOf(':');
  return separator > 0 ? [entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()] : ['', ''];
}).filter(([deviceId, key]) => deviceId && key));
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean);
const SCHEMA_VERSION = 5;
const SUPABASE_URL = String(process.env.SUPABASE_URL || '').trim();
const SUPABASE_SERVICE_ROLE_KEY = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const SUPABASE_EMPLOYEE_PHOTOS_BUCKET = String(process.env.SUPABASE_EMPLOYEE_PHOTOS_BUCKET || 'employee-photos').trim();
const SUPABASE_IMAGE_ORIGIN = /^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(SUPABASE_URL)
  ? SUPABASE_URL
  : '';
const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const AUDIT_FILE = path.join(DATA_DIR, 'audit.jsonl');

const sessions = new Map();
const rateBuckets = new Map();

const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DISPLAY_COLORS = ['BLUE', 'GREEN', 'PURPLE', 'YELLOW', 'RED', 'CYAN', 'WHITE', 'BLACK'];
const DISPLAY_BEEPS = ['NONE', 'SUCCESS', 'ERROR', 'NOTICE', 'WARNING'];
const DISPLAY_COMMAND_TYPES = ['SHOW_MESSAGE', 'START_ENROLLMENT', 'SYNC_TIME', 'DELETE_FINGERPRINT'];
const MANUAL_STATUSES = ['ABSENT', 'EXCUSED', 'SICK_LEAVE', 'EMERGENCY_LEAVE', 'DAY_OFF', 'NO_SCHEDULE'];
const STATUS_FILTERS = ['PRESENT', 'LATE', 'ABSENT', 'EXCUSED', 'DAY_OFF', 'INCOMPLETE', 'EMERGENCY'];
const DISPLAY_COMMAND_TITLES = [
  'SYNCING OFFLINE LOGS',
  'SYNC COMPLETE',
  'DEVICE LOCKED',
  'ADMIN MODE',
  'ENROLL MODE',
  'ENROLLMENT READY',
  'PLACE SAME FINGER',
  'FINGERPRINT SAVED',
  'FINGERPRINT DELETED',
  'REMOVE FINGER',
  'LOW WIFI SIGNAL',
  'RTC ERROR',
  'SERVER MAINTENANCE',
  'ATTENDANCE CLOSED',
  'BREAK TIME',
  'LUNCH BREAK',
  'RETURN FROM BREAK',
  'SHIFT NOT STARTED',
  'NO SCHEDULE TODAY',
  'DAY OFF TODAY',
  'EMERGENCY APPROVED',
  'EMERGENCY DENIED'
];

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix) {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

function emptyDb() {
  return {
    employees: [],
    attendance: [],
    enrollmentRequests: [],
    readers: [],
    displayCommands: [],
    manualStatuses: [],
    settings: defaultSettings(),
    meta: {
      createdAt: nowIso(),
      updatedAt: nowIso(),
      schemaVersion: SCHEMA_VERSION
    }
  };
}

function defaultSettings() {
  return {
    branchName: 'Main Branch',
    defaultShiftStart: '09:00',
    defaultShiftEnd: '18:00',
    graceMinutes: 10,
    duplicateScanDelayMinutes: Math.max(1, Math.round(DUPLICATE_SECONDS / 60)),
    requiredPaidHours: 8,
    lunchBreakStart: '12:00',
    lunchBreakEnd: '13:00',
    afternoonBreakStart: '15:00',
    afternoonBreakEnd: '15:15',
    earlyOutProtectionEnabled: true,
    emergencyTimeOutEnabled: true,
    pcBreakAlarmEnabled: true,
    esp32DisplayDurationMs: DEFAULT_DEVICE_DISPLAY_MS,
    apiKey: API_KEY
  };
}

function normalizeSettings(input) {
  const defaults = defaultSettings();
  const source = input && typeof input === 'object' ? input : {};
  return {
    branchName: normalizeName(source.branchName || defaults.branchName),
    defaultShiftStart: validTimeText(source.defaultShiftStart, defaults.defaultShiftStart),
    defaultShiftEnd: validTimeText(source.defaultShiftEnd, defaults.defaultShiftEnd),
    graceMinutes: clampNumber(source.graceMinutes, defaults.graceMinutes, 0, 120),
    duplicateScanDelayMinutes: clampNumber(source.duplicateScanDelayMinutes, defaults.duplicateScanDelayMinutes, 1, 60),
    requiredPaidHours: Math.min(16, Math.max(1, Number(source.requiredPaidHours || defaults.requiredPaidHours))),
    lunchBreakStart: validTimeText(source.lunchBreakStart, defaults.lunchBreakStart),
    lunchBreakEnd: validTimeText(source.lunchBreakEnd, defaults.lunchBreakEnd),
    afternoonBreakStart: validTimeText(source.afternoonBreakStart, defaults.afternoonBreakStart),
    afternoonBreakEnd: validTimeText(source.afternoonBreakEnd, defaults.afternoonBreakEnd),
    earlyOutProtectionEnabled: source.earlyOutProtectionEnabled !== false,
    emergencyTimeOutEnabled: source.emergencyTimeOutEnabled !== false,
    pcBreakAlarmEnabled: source.pcBreakAlarmEnabled !== false,
    esp32DisplayDurationMs: clampNumber(source.esp32DisplayDurationMs, defaults.esp32DisplayDurationMs, 1000, 15000),
    apiKey: cleanDisplayText(source.apiKey || defaults.apiKey, 80)
  };
}

function defaultWeeklySchedule() {
  const schedule = {};
  for (const day of DAY_KEYS) {
    schedule[day] = {
      dayOff: day === 'sunday',
      timeIn: '09:00',
      timeOut: '18:00'
    };
  }
  return schedule;
}

function validTimeText(value, fallback) {
  const text = String(value || fallback || '').trim();
  const match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return fallback;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function normalizeWeeklySchedule(input, fallbackStart = '09:00', fallbackOut = '18:00') {
  const defaults = defaultWeeklySchedule();
  const source = input && typeof input === 'object' ? input : {};
  const out = {};

  for (const day of DAY_KEYS) {
    const item = source[day] && typeof source[day] === 'object' ? source[day] : {};
    out[day] = {
      dayOff: Boolean(item.dayOff ?? defaults[day].dayOff),
      timeIn: validTimeText(item.timeIn, fallbackStart || defaults[day].timeIn),
      timeOut: validTimeText(item.timeOut, fallbackOut || defaults[day].timeOut)
    };
  }

  return out;
}

function normalizeFingerprintRecord(input, fallbackId = null, fallbackDeviceId = '') {
  const source = input && typeof input === 'object' ? input : {};
  const fingerprintId = parseFingerprintId(source.fingerprintId ?? fallbackId);
  if (!fingerprintId) return null;

  return {
    fingerprintId,
    label: cleanDisplayText(source.label || 'Fingerprint', 32),
    createdAt: source.createdAt || nowIso(),
    deviceId: normalizeDeviceId(source.deviceId || fallbackDeviceId || ''),
    active: source.active !== false
  };
}

function normalizeEmployeeFingerprints(employee) {
  const seen = new Set();
  const source = Array.isArray(employee.fingerprints) ? employee.fingerprints : [];
  const normalized = [];

  for (const item of source) {
    const record = normalizeFingerprintRecord(item, null, item && item.deviceId);
    if (record && !seen.has(record.fingerprintId)) {
      seen.add(record.fingerprintId);
      normalized.push(record);
    }
  }

  const legacyId = parseFingerprintId(employee.fingerprintId);
  if (legacyId && !seen.has(legacyId)) {
    normalized.unshift(normalizeFingerprintRecord({ label: 'Primary Finger' }, legacyId, employee.deviceId || ''));
    seen.add(legacyId);
  }

  employee.fingerprints = normalized.filter(Boolean);
  if (!employee.fingerprintId && employee.fingerprints.length) {
    employee.fingerprintId = employee.fingerprints[0].fingerprintId;
  }
  return employee.fingerprints;
}

function activeEmployeeFingerprints(employee) {
  return normalizeEmployeeFingerprints(employee).filter((fingerprint) => fingerprint.active !== false);
}

function findEmployeeByFingerprint(db, fingerprintId) {
  const id = parseFingerprintId(fingerprintId);
  if (!id) return null;
  return db.employees.find((employee) => {
    if (employee.active === false) return false;
    return activeEmployeeFingerprints(employee).some((fingerprint) => Number(fingerprint.fingerprintId) === id);
  }) || null;
}

function findFingerprintOwner(db, fingerprintId, exceptEmployeeId = '') {
  const id = parseFingerprintId(fingerprintId);
  if (!id) return null;
  return db.employees.find((employee) => {
    if (employee.active === false || employee.id === exceptEmployeeId) return false;
    return activeEmployeeFingerprints(employee).some((fingerprint) => Number(fingerprint.fingerprintId) === id);
  }) || null;
}

function completeEnrollmentRequest(db, fingerprintId, employeeId) {
  for (const request of db.enrollmentRequests) {
    if (Number(request.fingerprintId) === Number(fingerprintId) && request.status === 'PENDING_EMPLOYEE_DETAILS') {
      request.status = 'COMPLETED';
      request.employeeId = employeeId;
      request.updatedAt = nowIso();
    }
  }
}

function normalizeManualStatus(input, db) {
  const source = input && typeof input === 'object' ? input : {};
  const employee = db.employees.find((item) => item.id === source.employeeId);
  const dateKey = String(source.dateKey || '').trim();
  const status = upperDisplayText(source.status || '', 32);

  if (!employee || !dateKeyToUtcDate(dateKey) || !MANUAL_STATUSES.includes(status)) return null;

  return {
    id: source.id || createId('manual'),
    employeeId: employee.id,
    dateKey,
    status,
    reason: cleanDisplayText(source.reason || status.replaceAll('_', ' '), 80),
    remarks: cleanDisplayText(source.remarks || '', 160),
    approvedBy: cleanDisplayText(source.approvedBy || 'Admin', 80),
    createdAt: source.createdAt || nowIso(),
    updatedAt: source.updatedAt || nowIso()
  };
}

function ensureDbFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(emptyDb(), null, 2));
  }
}

function migrateDb(db) {
  db.employees = Array.isArray(db.employees) ? db.employees : [];
  db.attendance = Array.isArray(db.attendance) ? db.attendance : [];
  db.enrollmentRequests = Array.isArray(db.enrollmentRequests) ? db.enrollmentRequests : [];
  db.readers = Array.isArray(db.readers) ? db.readers : [];
  db.displayCommands = Array.isArray(db.displayCommands) ? db.displayCommands : [];
  db.manualStatuses = Array.isArray(db.manualStatuses) ? db.manualStatuses : [];
  db.settings = normalizeSettings(db.settings);
  db.meta = db.meta || {};
  db.meta.schemaVersion = Math.max(Number(db.meta.schemaVersion || 0), SCHEMA_VERSION);

  for (const employee of db.employees) {
    normalizeEmployeeFingerprints(employee);
    employee.weeklySchedule = normalizeWeeklySchedule(
      employee.weeklySchedule,
      employee.shiftStart || db.settings.defaultShiftStart,
      employee.shiftEnd || db.settings.defaultShiftEnd
    );
    employee.graceMinutes = Math.max(0, Number(employee.graceMinutes ?? db.settings.graceMinutes));
    employee.active = employee.active !== false;
  }

  db.manualStatuses = db.manualStatuses
    .map((item) => normalizeManualStatus(item, db))
    .filter(Boolean);

  pruneUnrecordedAttendanceLogs(db);

  return db;
}

function loadDb() {
  ensureDbFile();

  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    return migrateDb(JSON.parse(raw));
  } catch (error) {
    const backup = DB_FILE + `.broken-${Date.now()}.bak`;
    if (fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, backup);
    const db = emptyDb();
    saveDb(db);
    return db;
  }
}

function isRecordedAttendanceLog(record) {
  return record && record.accepted === true && ['TIME_IN', 'TIME_OUT'].includes(record.attendanceType);
}

function pruneUnrecordedAttendanceLogs(db) {
  if (!db || !Array.isArray(db.attendance)) return false;

  const before = db.attendance.length;
  db.attendance = db.attendance.filter(isRecordedAttendanceLog);

  return before !== db.attendance.length;
}

function saveDb(db) {
  pruneUnrecordedAttendanceLogs(db);
  db.meta = db.meta || {};
  db.meta.updatedAt = nowIso();
  db.meta.schemaVersion = SCHEMA_VERSION;
  if (!CLOUD_MODE) {
    ensureDbFile();
    const tempFile = DB_FILE + '.tmp';
    fs.writeFileSync(tempFile, JSON.stringify(db, null, 2));
    fs.renameSync(tempFile, DB_FILE);
  }
  storage.scheduleSnapshot(db);
}

function requestIp(req) {
  if (TRUST_PROXY) {
    const forwarded = String(getHeader(req, 'x-forwarded-for') || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket?.remoteAddress || 'unknown';
}

function allowedOrigin(req) {
  const origin = String(getHeader(req, 'origin') || '');
  if (!origin) return '';
  if (ALLOWED_ORIGINS.includes(origin)) return origin;
  try {
    const requestHost = String(getHeader(req, 'host') || '');
    if (new URL(origin).host === requestHost) return origin;
  } catch {}
  return '';
}

function securityHeaders(req) {
  const origin = allowedOrigin(req);
  const imageSources = `'self' data:${SUPABASE_IMAGE_ORIGIN ? ` ${SUPABASE_IMAGE_ORIGIN}` : ''}`;
  return {
    ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
    'Content-Security-Policy': `default-src 'self'; img-src ${imageSources}; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'`,
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
  };
}

function send(res, status, data, headers = {}, req = null) {
  const isRaw = typeof data === 'string' || Buffer.isBuffer(data);
  const body = isRaw ? data : JSON.stringify(data, null, 2);
  res.writeHead(status, {
    ...(req ? securityHeaders(req) : {}),
    'Content-Type': isRaw ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    ...headers
  });
  res.end(body);
}

function sendJson(res, status, data, req = null) {
  send(res, status, data, { 'Content-Type': 'application/json; charset=utf-8' }, req);
}

function sendFile(req, res, filePath, contentType) {
  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendJson(res, 404, { code: 'NOT_FOUND', message: 'File not found.' });
      return;
    }
    const headers = {
      ...securityHeaders(req),
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Content-Type': contentType
    };
    let body = data;
    if (contentType.startsWith('text/html')) {
      const nonce = crypto.randomBytes(18).toString('base64');
      body = Buffer.from(data.toString('utf8').replace(/<script(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`));
      const imageSources = `'self' data:${SUPABASE_IMAGE_ORIGIN ? ` ${SUPABASE_IMAGE_ORIGIN}` : ''}`;
      headers['Content-Security-Policy'] = `default-src 'self'; img-src ${imageSources}; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'nonce-${nonce}'; connect-src 'self'`;
    }
    res.writeHead(200, headers);
    res.end(body);
  });
}

function getContentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml; charset=utf-8';
  if (filePath.endsWith('.jpg') || filePath.endsWith('.jpeg')) return 'image/jpeg';
  if (filePath.endsWith('.png')) return 'image/png';
  if (filePath.endsWith('.webp')) return 'image/webp';
  if (filePath.endsWith('.mp3')) return 'audio/mpeg';
  return 'application/octet-stream';
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        const error = new Error('Request body too large.');
        error.statusCode = 413;
        reject(error);
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch {
        const error = new Error('Invalid JSON body.');
        error.statusCode = 400;
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function getHeader(req, name) {
  return req.headers[String(name).toLowerCase()];
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(req) {
  return Object.fromEntries(String(getHeader(req, 'cookie') || '').split(';').map((part) => {
    const index = part.indexOf('=');
    return index < 0 ? ['', ''] : [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

function validSession(req) {
  const token = parseCookies(req).gms_session;
  const session = token && sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function apiKeyAuth(req, url) {
  const provided = getHeader(req, 'x-api-key') || '';
  if (!provided) return null;

  const deviceId = normalizeDeviceId(getHeader(req, 'x-device-id') || url?.searchParams.get('deviceId') || '');
  const deviceKey = deviceId && DEVICE_API_KEYS.get(deviceId);
  if (deviceKey && safeEqual(provided, deviceKey)) return { role: 'device', username: deviceId, deviceId };

  try {
    const db = loadDb();
    const keys = new Set([API_KEY, db.settings && db.settings.apiKey].filter(Boolean));
    return [...keys].some((key) => safeEqual(provided, key)) ? { role: 'device', username: deviceId || 'legacy-device', deviceId } : null;
  } catch {
    return safeEqual(provided, API_KEY) ? { role: 'device', username: deviceId || 'legacy-device', deviceId } : null;
  }
}

function authContext(req, url) {
  return validSession(req) || apiKeyAuth(req, url);
}

function deviceRoute(pathname, method) {
  return [
    'POST /api/readers/heartbeat',
    'POST /api/fingerprints/scan-status',
    'GET /api/devices/display-command',
    'POST /api/devices/display-command/ack',
    'POST /api/fingerprints/enrollment-request',
    'POST /api/attendance/scan'
  ].includes(`${method} ${pathname}`);
}

function roleCanAccess(role, pathname, method) {
  if (role === 'admin') return true;
  if (role === 'device') return deviceRoute(pathname, method);
  if (role === 'viewer') return method === 'GET' && !['/api/export/db', '/api/audit'].includes(pathname);
  if (role === 'hr') {
    if (method === 'GET') return pathname !== '/api/export/db';
    return pathname.startsWith('/api/employees') || pathname.startsWith('/api/fingerprints') ||
      pathname.startsWith('/api/time-card') || pathname.startsWith('/api/timecard') ||
      pathname === '/api/attendance/review' || pathname === '/api/admin/emergency-attendance';
  }
  return false;
}

function consumeRateLimit(key, limit, windowMs) {
  const now = Date.now();
  const current = rateBuckets.get(key);
  if (!current || current.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  current.count += 1;
  return current.count <= limit;
}

function auditRequest(req, pathname, method, status) {
  if (!['POST', 'PATCH', 'DELETE'].includes(method) || pathname === '/api/auth/login') return;
  const record = {
    id: createId('audit'), at: nowIso(), method, pathname, status,
    actor: req.auth?.username || 'unauthenticated', role: req.auth?.role || '',
    ip: requestIp(req), userAgent: cleanDisplayText(getHeader(req, 'user-agent') || '', 160)
  };
  storage.writeAudit(record).then((stored) => {
    if (stored || CLOUD_MODE) return;
    fs.appendFile(AUDIT_FILE, `${JSON.stringify(record)}\n`, (error) => {
      if (error) console.error('Audit log write failed:', error.message);
    });
  }).catch((error) => console.error('Audit log write failed:', error.message));
}

async function handleAuditLog(res, url) {
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 100)));
  const databaseRecords = await storage.readAudit(limit);
  if (databaseRecords) {
    sendJson(res, 200, { audit: databaseRecords });
    return;
  }
  if (!fs.existsSync(AUDIT_FILE)) {
    sendJson(res, 200, { audit: [] });
    return;
  }
  const records = fs.readFileSync(AUDIT_FILE, 'utf8').trim().split(/\r?\n/).filter(Boolean).slice(-limit).reverse().map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
  sendJson(res, 200, { audit: records });
}

function parseFingerprintId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id < 1 || id > 1000) return null;
  return id;
}

function normalizeName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function clampNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function cleanDisplayText(value, maxLength = 24) {
  const text = String(value ?? '')
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLength ? text.slice(0, maxLength).trim() : text;
}

function upperDisplayText(value, maxLength = 24) {
  return cleanDisplayText(value, maxLength).toUpperCase();
}

function normalizeDeviceId(value) {
  return cleanDisplayText(value, 64);
}

function normalizeDisplayChoice(value, allowed, fallback) {
  const fallbackText = upperDisplayText(fallback, 24);
  const text = upperDisplayText(value || fallbackText, 24);
  if (allowed.includes(text)) return text;
  return allowed.includes(fallbackText) ? fallbackText : allowed[0];
}

function normalizeDeviceDisplay(input, defaults = {}) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    topStatus: upperDisplayText(source.topStatus ?? defaults.topStatus ?? 'ONLINE CONNECTED', 24),
    title: upperDisplayText(source.title ?? defaults.title ?? 'MESSAGE', 24),
    line1: cleanDisplayText(source.line1 ?? defaults.line1 ?? '', 24),
    line2: cleanDisplayText(source.line2 ?? defaults.line2 ?? '', 24),
    line3: cleanDisplayText(source.line3 ?? defaults.line3 ?? '', 24),
    color: normalizeDisplayChoice(source.color ?? defaults.color, DISPLAY_COLORS, defaults.color || 'BLUE'),
    beep: normalizeDisplayChoice(source.beep ?? defaults.beep, DISPLAY_BEEPS, defaults.beep || 'NONE'),
    durationMs: clampNumber(source.durationMs ?? defaults.durationMs, DEFAULT_DEVICE_DISPLAY_MS, 1000, 15000)
  };
}

function displayShortName(fullName) {
  const parts = normalizeName(fullName).toUpperCase().split(' ').filter(Boolean);
  if (!parts.length) return '';
  if (parts.length === 1) return cleanDisplayText(parts[0], 24);

  const first = parts[0];
  const last = parts[parts.length - 1];
  const middle = parts.length > 2 ? `${parts[1][0]}.` : '';
  const withMiddle = [first, middle, last].filter(Boolean).join(' ');
  if (withMiddle.length <= 24) return cleanDisplayText(withMiddle, 24);

  const firstInitial = `${first[0]}. ${last}`;
  if (firstInitial.length <= 24) return cleanDisplayText(firstInitial, 24);

  return cleanDisplayText(last, 24);
}

function isSupportedCommandTitle(title) {
  const normalized = upperDisplayText(title, 24);
  return DISPLAY_COMMAND_TITLES.includes(normalized) || /^PENDING LOGS: \d{1,4}$/.test(normalized);
}

function defaultCommandDisplay(command, fingerprintId = null) {
  if (command === 'START_ENROLLMENT') {
    return {
      title: 'ENROLLMENT READY',
      line1: 'PLACE FINGER',
      line2: '',
      line3: '',
      color: 'PURPLE',
      beep: 'NOTICE',
      durationMs: 5000
    };
  }

  if (command === 'SYNC_TIME') {
    return {
      title: 'SYNC COMPLETE',
      line1: 'Time updated',
      line2: '',
      line3: '',
      color: 'BLUE',
      beep: 'NOTICE',
      durationMs: 3000
    };
  }

  if (command === 'DELETE_FINGERPRINT') {
    return {
      title: 'REMOVE FINGER',
      line1: fingerprintId ? `ID ${fingerprintId}` : 'ID REQUIRED',
      line2: 'DELETE TEMPLATE',
      line3: '',
      color: 'YELLOW',
      beep: 'WARNING',
      durationMs: 5000
    };
  }

  return {
    title: 'SERVER MAINTENANCE',
    line1: 'Please wait...',
    line2: '',
    line3: '',
    color: 'PURPLE',
    beep: 'NONE',
    durationMs: DEFAULT_DEVICE_DISPLAY_MS
  };
}

function buildEnrollmentDisplay(fingerprintId) {
  return normalizeDeviceDisplay({
    title: 'FINGERPRINT SAVED',
    line1: `ID ${fingerprintId}`,
    line2: 'Open server',
    line3: 'Complete profile',
    color: 'GREEN',
    beep: 'SUCCESS',
    durationMs: 3000
  });
}

function localDateParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: DEVICE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date);
  const out = {};
  for (const part of parts) if (part.type !== 'literal') out[part.type] = part.value;
  let hour = Number(out.hour);
  if (hour === 24) hour = 0;
  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    hour,
    minute: Number(out.minute),
    second: Number(out.second)
  };
}

function localDateKey(date) {
  const p = localDateParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

function displayTime(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: DEVICE_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  }).format(date);
}

function displayDateTime(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: DEVICE_TIMEZONE,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  }).format(date);
}

function timeToMinutes(value, fallback = '00:00') {
  const text = validTimeText(value, fallback);
  const [h, m] = text.split(':').map(Number);
  return h * 60 + m;
}

function minutesSinceMidnight(date) {
  const p = localDateParts(date);
  return p.hour * 60 + p.minute;
}

function formatTimeText(value) {
  const text = validTimeText(value, '00:00');
  const [h, m] = text.split(':').map(Number);
  const date = new Date(Date.UTC(2000, 0, 1, h, m, 0));
  return new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'UTC' }).format(date);
}

function dateKeyToUtcDate(dateKey) {
  const match = String(dateKey || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function dateKeyFromUtcDate(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function addDaysUtc(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function dayKeyForDateKey(dateKey) {
  const date = dateKeyToUtcDate(dateKey);
  if (!date) return 'monday';
  return DAY_KEYS[date.getUTCDay()];
}

function getScheduleForDate(employee, dateKey) {
  const schedule = normalizeWeeklySchedule(employee.weeklySchedule, employee.shiftStart || '09:00', employee.shiftEnd || '18:00');
  const dayKey = dayKeyForDateKey(dateKey);
  return { dayKey, dayLabel: DAY_LABELS[DAY_KEYS.indexOf(dayKey)], ...schedule[dayKey] };
}

function computeTimeInStatus(employee, scanDate) {
  const dateKey = localDateKey(scanDate);
  const schedule = getScheduleForDate(employee, dateKey);

  if (schedule.dayOff) {
    return { punctuality: 'DAY_OFF', lateMinutes: 0, statusText: 'DAY OFF' };
  }

  const graceMinutes = Math.max(0, Number(employee.graceMinutes || 0));
  const scanMinutes = minutesSinceMidnight(scanDate);
  const allowedMinutes = timeToMinutes(schedule.timeIn, '09:00') + graceMinutes;
  const lateMinutes = Math.max(0, scanMinutes - allowedMinutes);

  if (lateMinutes > 0) {
    return { punctuality: 'LATE', lateMinutes, statusText: `LATE ${lateMinutes} MIN` };
  }

  return { punctuality: 'ON_TIME', lateMinutes: 0, statusText: 'ON TIME' };
}

function computeTimeOutStatus(employee, scanDate) {
  const dateKey = localDateKey(scanDate);
  const schedule = getScheduleForDate(employee, dateKey);

  if (schedule.dayOff) {
    return { punctuality: 'DAY_OFF', earlyOutMinutes: 0, statusText: 'DAY OFF' };
  }

  const scanMinutes = minutesSinceMidnight(scanDate);
  const requiredOut = timeToMinutes(schedule.timeOut, '18:00');
  const earlyOutMinutes = Math.max(0, requiredOut - scanMinutes);

  if (earlyOutMinutes > 0) {
    return { punctuality: 'EARLY_OUT', earlyOutMinutes, statusText: `EARLY OUT ${earlyOutMinutes} MIN` };
  }

  return { punctuality: 'COMPLETED', earlyOutMinutes: 0, statusText: 'COMPLETED' };
}

function overlapMinutes(startA, endA, startB, endB) {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

function calculateWorkSummary(timeInDate, timeOutDate, settings) {
  if (!timeInDate || !timeOutDate) {
    return {
      grossMinutes: 0,
      lunchDeductionMinutes: 0,
      paidMinutes: 0,
      overtimeMinutes: 0,
      paidHours: 0,
      grossHours: 0
    };
  }

  let startMinutes = minutesSinceMidnight(timeInDate);
  let endMinutes = minutesSinceMidnight(timeOutDate);
  if (endMinutes < startMinutes) endMinutes += 24 * 60;

  const grossMinutes = Math.max(0, endMinutes - startMinutes);
  const lunchStart = timeToMinutes(settings.lunchBreakStart, '12:00');
  const lunchEnd = timeToMinutes(settings.lunchBreakEnd, '13:00');
  const lunchDeductionMinutes = overlapMinutes(startMinutes, endMinutes, lunchStart, lunchEnd);
  const paidMinutes = Math.max(0, grossMinutes - lunchDeductionMinutes);
  const requiredMinutes = Math.round(Number(settings.requiredPaidHours || 8) * 60);
  const overtimeMinutes = Math.max(0, paidMinutes - requiredMinutes);

  return {
    grossMinutes,
    lunchDeductionMinutes,
    paidMinutes,
    overtimeMinutes,
    paidHours: Number((paidMinutes / 60).toFixed(2)),
    grossHours: Number((grossMinutes / 60).toFixed(2))
  };
}

function decimalHours(minutes) {
  return Number((Math.max(0, Number(minutes || 0)) / 60).toFixed(2));
}

function workDurationTextFromMinutes(minutes) {
  const totalMinutes = Math.max(0, Math.round(Number(minutes || 0)));
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  return `${hours}h ${mins}m`;
}

function todayRecordsForEmployee(db, employeeId, dateKey) {
  return db.attendance.filter((record) => record.employeeId === employeeId && record.dateKey === dateKey && record.accepted === true);
}

function findLastRecordForFingerprint(db, fingerprintId) {
  return db.attendance
    .filter((record) => Number(record.fingerprintId) === Number(fingerprintId) && isRecordedAttendanceLog(record))
    .sort((a, b) => new Date(b.scannedAt) - new Date(a.scannedAt))[0] || null;
}

function duplicateWindowSeconds(db) {
  return Math.max(1, Number(db.settings && db.settings.duplicateScanDelayMinutes ? db.settings.duplicateScanDelayMinutes : Math.round(DUPLICATE_SECONDS / 60))) * 60;
}

function isDuplicateScan(db, fingerprintId, scanDate) {
  const last = findLastRecordForFingerprint(db, fingerprintId);
  if (!last) return false;
  const diffSeconds = Math.abs(scanDate.getTime() - new Date(last.scannedAt).getTime()) / 1000;
  return diffSeconds <= duplicateWindowSeconds(db);
}

function upsertEnrollmentRequest(db, data) {
  const fingerprintId = parseFingerprintId(data.fingerprintId);
  if (!fingerprintId) return null;

  let existing = db.enrollmentRequests.find((request) => Number(request.fingerprintId) === fingerprintId && request.status === 'PENDING_EMPLOYEE_DETAILS');

  if (existing) {
    existing.updatedAt = nowIso();
    existing.lastDeviceId = data.deviceId || existing.lastDeviceId || '';
    existing.lastSeenAt = data.scannedAt || data.enrolledAt || nowIso();
    return existing;
  }

  existing = {
    id: createId('enroll'),
    fingerprintId,
    status: 'PENDING_EMPLOYEE_DETAILS',
    requestedAction: 'OPEN_ENROLLMENT_MODAL',
    deviceId: data.deviceId || '',
    source: data.source || 'ESP32-S3',
    enrolledAt: data.enrolledAt || data.scannedAt || nowIso(),
    createdAt: nowIso(),
    updatedAt: nowIso()
  };

  db.enrollmentRequests.unshift(existing);
  return existing;
}

function safePublicEmployee(employee) {
  const weeklySchedule = normalizeWeeklySchedule(employee.weeklySchedule, employee.shiftStart || '09:00', employee.shiftEnd || '18:00');
  return {
    id: employee.id,
    employeeCode: employee.employeeCode || String(employee.id || '').slice(-8),
    fullName: employee.fullName,
    photoUrl: employee.photoUrl || '',
    fingerprintId: employee.fingerprintId,
    fingerprints: activeEmployeeFingerprints(employee),
    shiftStart: employee.shiftStart || weeklySchedule.monday.timeIn,
    shiftEnd: employee.shiftEnd || weeklySchedule.monday.timeOut,
    graceMinutes: employee.graceMinutes,
    weeklySchedule,
    active: employee.active !== false,
    createdAt: employee.createdAt,
    updatedAt: employee.updatedAt
  };
}

async function handleEmployeePhotoUpload(res, employeeId, body) {
  const db = loadDb();
  const employee = db.employees.find((item) => item.id === employeeId);
  if (!employee) return sendJson(res, 404, { code: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found.' });
  if (!supabase) return sendJson(res, 503, {
    code: 'SUPABASE_STORAGE_NOT_CONFIGURED',
    message: 'Employee photo storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.'
  });

  const match = String(body.dataUrl || '').match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return sendJson(res, 400, { code: 'INVALID_EMPLOYEE_PHOTO', message: 'Use a JPG, PNG, or WebP employee photo.' });
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length || bytes.length > 750 * 1024) return sendJson(res, 413, { code: 'EMPLOYEE_PHOTO_TOO_LARGE', message: 'Employee photo must be 750 KB or smaller after resizing.' });

  const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[match[1]];
  const objectPath = `${employee.id}/profile-${Date.now()}.${extension}`;
  const bucket = supabase.storage.from(SUPABASE_EMPLOYEE_PHOTOS_BUCKET);
  const uploaded = await bucket.upload(objectPath, bytes, { contentType: match[1], cacheControl: '3600', upsert: false });
  if (uploaded.error) return sendJson(res, 502, { code: 'SUPABASE_PHOTO_UPLOAD_FAILED', message: uploaded.error.message });

  const publicUrl = bucket.getPublicUrl(objectPath).data.publicUrl;
  const previousPath = employee.photoStoragePath || '';
  employee.photoUrl = publicUrl;
  employee.photoStoragePath = objectPath;
  employee.updatedAt = nowIso();
  saveDb(db);
  if (previousPath) bucket.remove([previousPath]).catch(() => {});
  sendJson(res, 200, { employee: safePublicEmployee(employee), photoUrl: publicUrl });
}

function buildRecordDeviceDisplay(record, employee) {
  const name = displayShortName(employee ? employee.fullName : record.fullName);
  const displayTimeText = record.displayTime || '';
  const durationMs = record.displayDurationMs || DEFAULT_DEVICE_DISPLAY_MS;

  if (record.code === 'FINGERPRINT_NOT_REGISTERED') {
    return normalizeDeviceDisplay({
      title: 'NOT REGISTERED',
      line1: 'LINK FINGERPRINT',
      line2: 'ON SERVER',
      line3: '',
      color: 'YELLOW',
      beep: 'WARNING',
      durationMs: Math.max(durationMs, 4000)
    });
  }

  if (record.code === 'DUPLICATE_SCAN') {
    return normalizeDeviceDisplay({
      title: 'ALREADY RECORDED',
      line1: name,
      line2: displayTimeText,
      line3: 'PLEASE WAIT',
      color: 'YELLOW',
      beep: 'NOTICE',
      durationMs
    });
  }

  if (record.code === 'ATTENDANCE_ALREADY_COMPLETE') {
    return normalizeDeviceDisplay({
      title: 'ALREADY RECORDED',
      line1: name,
      line2: displayTimeText,
      line3: 'TODAY COMPLETE',
      color: 'BLUE',
      beep: 'NOTICE',
      durationMs
    });
  }

  if (record.code === 'TIME_OUT_NOT_ALLOWED') {
    return normalizeDeviceDisplay({
      title: 'TIME OUT DENIED',
      line1: 'COMPLETE 8 HOURS',
      line2: `REMAINING: ${record.remainingMinutes || 0} MIN`,
      line3: '',
      color: 'RED',
      beep: 'ERROR',
      durationMs: Math.max(durationMs, 5000)
    });
  }

  if (record.code === 'EMERGENCY_TIME_OUT' || record.code === 'EMERGENCY_TIME_IN') {
    return normalizeDeviceDisplay({
      title: 'EMERGENCY APPROVED',
      line1: name,
      line2: displayTimeText,
      line3: record.attendanceType === 'TIME_OUT' ? 'TIME OUT' : 'TIME IN',
      color: 'GREEN',
      beep: 'NOTICE',
      durationMs: Math.max(durationMs, 5000)
    });
  }

  if (record.code === 'TIME_OUT_RECORDED') {
    const isWarning = ['EARLY_OUT', 'DAY_OFF'].includes(record.punctuality);
    return normalizeDeviceDisplay({
      title: 'TIME OUT RECORDED',
      line1: name,
      line2: displayTimeText,
      line3: record.statusText || 'COMPLETED',
      color: isWarning ? 'YELLOW' : 'GREEN',
      beep: isWarning ? 'WARNING' : 'SUCCESS',
      durationMs
    });
  }

  if (record.code === 'TIME_IN_RECORDED') {
    return normalizeDeviceDisplay({
      title: 'TIME IN RECORDED',
      line1: name,
      line2: displayTimeText,
      line3: record.statusText || 'RECORDED',
      color: 'GREEN',
      beep: 'SUCCESS',
      durationMs
    });
  }

  return normalizeDeviceDisplay({
    title: record.statusText || record.code || 'RECORDED',
    line1: name,
    line2: displayTimeText,
    line3: '',
    color: record.accepted ? 'BLUE' : 'RED',
    beep: record.accepted ? 'NOTICE' : 'ERROR',
    durationMs
  });
}

function buildScanResponse(record, employee) {
  const deviceDisplay = buildRecordDeviceDisplay(record, employee);
  return {
    parsed: true,
    accepted: record.accepted,
    duplicateTap: record.duplicateTap || false,
    code: record.code,
    message: record.message,
    record: {
      accepted: record.accepted,
      employeeId: employee ? employee.id : '',
      fullName: employee ? employee.fullName : '',
      attendanceType: record.attendanceType || '',
      displayTime: record.displayTime || '',
      scannedAt: record.scannedAt,
      punctuality: record.punctuality || '',
      lateMinutes: record.lateMinutes || 0,
      earlyOutMinutes: record.earlyOutMinutes || 0,
      statusText: record.statusText || '',
      remainingMinutes: record.remainingMinutes || 0,
      paidHours: record.paidHours || 0,
      deviceDisplay
    },
    fullName: employee ? employee.fullName : '',
    attendanceType: record.attendanceType || '',
    displayTime: record.displayTime || '',
    punctuality: record.punctuality || '',
    lateMinutes: record.lateMinutes || 0,
    earlyOutMinutes: record.earlyOutMinutes || 0,
    statusText: record.statusText || '',
    remainingMinutes: record.remainingMinutes || 0,
    paidHours: record.paidHours || 0,
    deviceDisplay
  };
}

function createAttendanceRecord(body, scanDate, employee, extra) {
  return {
    id: createId('attendance'),
    eventId: body.eventId || '',
    fingerprintId: parseFingerprintId(body.fingerprintId),
    fingerprintConfidence: body.fingerprintConfidence ?? null,
    employeeId: employee ? employee.id : '',
    fullName: employee ? employee.fullName : '',
    displayTime: displayTime(scanDate),
    scannedAt: scanDate.toISOString(),
    originalScannedAt: body.scannedAt || scanDate.toISOString(),
    displayDateTime: displayDateTime(scanDate),
    dateKey: localDateKey(scanDate),
    deviceId: body.deviceId || '',
    location: body.location || '',
    source: body.source || '',
    firmwareVersion: body.firmwareVersion || '',
    deviceIp: body.deviceIp || '',
    wifiRssi: body.wifiRssi ?? null,
    createdAt: nowIso(),
    ...extra
  };
}

function scheduledEmployeesForDate(db, dateKey) {
  return db.employees
    .filter((employee) => employee.active !== false)
    .map((employee) => ({ employee, schedule: getScheduleForDate(employee, dateKey) }))
    .filter((item) => !item.schedule.dayOff);
}

function previousScheduledDateKey(db, dateKey) {
  const date = dateKeyToUtcDate(dateKey);
  if (!date) return '';

  for (let offset = 1; offset <= 7; offset += 1) {
    const candidate = dateKeyFromUtcDate(addDaysUtc(date, -offset));
    if (scheduledEmployeesForDate(db, candidate).length > 0) {
      return candidate;
    }
  }

  return dateKeyFromUtcDate(addDaysUtc(date, -1));
}

function buildCloseStatusForDate(db, dateKey, options = {}) {
  const nowMinutes = Number.isFinite(options.nowMinutes) ? options.nowMinutes : 24 * 60;
  const afterOutOnly = Boolean(options.afterOutOnly);
  const scheduled = scheduledEmployeesForDate(db, dateKey);
  const openTimeOuts = [];
  let monitoredEmployees = 0;
  let timedInCount = 0;
  let timedOutCount = 0;

  for (const item of scheduled) {
    const outMinutes = timeToMinutes(item.schedule.timeOut, db.settings.defaultShiftEnd || '18:00');
    if (afterOutOnly && nowMinutes < outMinutes) {
      continue;
    }

    monitoredEmployees += 1;

    const card = buildTimeCardRecord(
      item.employee,
      dateKey,
      db.attendance,
      db.manualStatuses,
      db.settings
    );

    if (card.timeIn) {
      timedInCount += 1;
    }

    if (card.timeIn && card.timeOut) {
      timedOutCount += 1;
    }

    if (card.timeIn && !card.timeOut) {
      openTimeOuts.push(card);
    }
  }

  if (monitoredEmployees === 0) {
    return {
      active: false,
      code: 'WORK_HOURS',
      color: 'BLUE',
      statusDate: dateKey,
      openTimeOutCount: 0,
      timedInCount,
      timedOutCount,
      monitoredEmployees,
      message: 'Normal work hours.'
    };
  }

  if (openTimeOuts.length > 0) {
    return {
      active: true,
      code: 'PENDING_TIME_OUT',
      color: 'WHITE',
      statusDate: dateKey,
      openTimeOutCount: openTimeOuts.length,
      timedInCount,
      timedOutCount,
      monitoredEmployees,
      names: openTimeOuts.slice(0, 5).map((card) => card.fullName),
      message: 'Some employees timed in but have not timed out.'
    };
  }

  return {
    active: true,
    code: 'ALL_TIMED_OUT',
    color: 'BLACK',
    statusDate: dateKey,
    openTimeOutCount: 0,
    timedInCount,
    timedOutCount,
    monitoredEmployees,
    message: 'All timed-in employees are timed out.'
  };
}

function buildAttendanceCloseStatus(db, now = new Date()) {
  const today = localDateKey(now);
  const nowMinutes = minutesSinceMidnight(now);
  const todayScheduled = scheduledEmployeesForDate(db, today);

  if (!todayScheduled.length) {
    const previousDate = previousScheduledDateKey(db, today);
    return previousDate
      ? buildCloseStatusForDate(db, previousDate)
      : {
          active: false,
          code: 'NO_SCHEDULE',
          color: 'BLUE',
          statusDate: today,
          openTimeOutCount: 0,
          timedInCount: 0,
          timedOutCount: 0,
          monitoredEmployees: 0,
          message: 'No schedule today.'
        };
  }

  const earliestTimeIn = Math.min(
    ...todayScheduled.map((item) => timeToMinutes(item.schedule.timeIn, db.settings.defaultShiftStart || '09:00'))
  );

  if (nowMinutes < earliestTimeIn) {
    const previousDate = previousScheduledDateKey(db, today);
    return previousDate
      ? buildCloseStatusForDate(db, previousDate)
      : buildCloseStatusForDate(db, today, { nowMinutes, afterOutOnly: true });
  }

  return buildCloseStatusForDate(db, today, { nowMinutes, afterOutOnly: true });
}

async function handleHeartbeat(req, res, body) {
  const db = loadDb();
  const deviceId = String(body.deviceId || 'UNKNOWN_DEVICE');
  let reader = db.readers.find((item) => item.deviceId === deviceId);

  if (!reader) {
    reader = { id: createId('reader'), deviceId, createdAt: nowIso() };
    db.readers.push(reader);
  }

  reader.lastSeenAt = nowIso();
  reader.source = body.source || reader.source || '';
  reader.location = body.location || reader.location || '';
  reader.firmwareVersion = body.firmwareVersion || reader.firmwareVersion || '';
  reader.identityMode = body.identityMode || reader.identityMode || '';
  reader.deviceIp = body.deviceIp || reader.deviceIp || req.socket.remoteAddress;
  reader.wifiRssi = body.wifiRssi ?? reader.wifiRssi ?? null;
  reader.pendingOfflineLogs = Math.max(0, Number(body.pendingOfflineLogs ?? body.pendingLogs ?? reader.pendingOfflineLogs ?? 0));
  if (body.capabilities && typeof body.capabilities === 'object' && !Array.isArray(body.capabilities)) {
    reader.capabilities = { ...(reader.capabilities || {}), ...body.capabilities };
  }
  reader.online = true;
  reader.attendanceCloseStatus = buildAttendanceCloseStatus(db);

  saveDb(db);
  sendJson(res, 200, {
    accepted: true,
    code: 'READER_ONLINE',
    message: 'Reader heartbeat received.',
    serverTime: nowIso(),
    attendanceCloseStatus: reader.attendanceCloseStatus
  });
}

function publicReader(reader) {
  const lastSeenMs = reader.lastSeenAt ? new Date(reader.lastSeenAt).getTime() : 0;
  const ageSeconds = lastSeenMs ? Math.round((Date.now() - lastSeenMs) / 1000) : null;
  const online = Boolean(lastSeenMs && ageSeconds <= 60);
  return {
    id: reader.id,
    deviceId: reader.deviceId,
    status: online ? 'ONLINE CONNECTED' : 'ONLINE DISCONNECTED',
    online,
    lastSeenAt: reader.lastSeenAt || '',
    ageSeconds,
    wifiRssi: reader.wifiRssi ?? null,
    deviceIp: reader.deviceIp || '',
    firmwareVersion: reader.firmwareVersion || '',
    pendingOfflineLogs: Number(reader.pendingOfflineLogs || 0),
    location: reader.location || '',
    source: reader.source || '',
    identityMode: reader.identityMode || '',
    capabilities: reader.capabilities || {},
    attendanceCloseStatus: reader.attendanceCloseStatus || null,
    fingerprintScanStatus: reader.fingerprintScanStatus || '',
    fingerprintScanStatusAt: reader.fingerprintScanStatusAt || null,
    fingerprintDetectedAt: reader.fingerprintDetectedAt || null
  };
}

function handleReaders(res) {
  const db = loadDb();
  sendJson(res, 200, { readers: db.readers.map(publicReader) });
}

async function handleFingerprintScanStatus(res, body) {
  const db = loadDb();
  const deviceId = normalizeDeviceId(body.deviceId || '');
  const status = upperDisplayText(body.status || '', 32);
  const allowed = ['WAITING_FOR_FINGER', 'FINGER_DETECTED', 'IMAGE_CAPTURED', 'MATCHING', 'VERIFIED', 'FAILED'];
  if (!deviceId || !allowed.includes(status)) {
    sendJson(res, 400, { accepted: false, code: 'INVALID_SCAN_STATUS', message: 'A valid deviceId and fingerprint scan status are required.' });
    return;
  }
  const reader = db.readers.find((item) => item.deviceId === deviceId);
  if (!reader) {
    sendJson(res, 404, { accepted: false, code: 'READER_NOT_FOUND', message: 'Reader was not found.' });
    return;
  }
  reader.fingerprintScanStatus = status;
  reader.fingerprintScanStatusAt = nowIso();
  if (status === 'FINGER_DETECTED') reader.fingerprintDetectedAt = reader.fingerprintScanStatusAt;
  saveDb(db);
  sendJson(res, 200, { accepted: true, deviceId, status, statusAt: reader.fingerprintScanStatusAt });
}

function handleGetSettings(res) {
  const db = loadDb();
  sendJson(res, 200, { settings: db.settings });
}

async function handleUpdateSettings(res, body) {
  const db = loadDb();
  db.settings = normalizeSettings({ ...db.settings, ...(body || {}) });
  saveDb(db);
  sendJson(res, 200, { settings: db.settings });
}

function findManualStatus(db, employeeId, dateKey) {
  return db.manualStatuses.find((item) => item.employeeId === employeeId && item.dateKey === dateKey) || null;
}

function buildDashboardSummary(db) {
  const today = localDateKey(new Date());
  const activeEmployees = db.employees.filter((employee) => employee.active !== false);
  let presentToday = 0;
  let lateToday = 0;
  let absentToday = 0;
  let excusedToday = 0;
  let emergencyLogs = 0;
  let missingTimeOutToday = 0;

  for (const employee of activeEmployees) {
    const card = buildTimeCardRecord(employee, today, db.attendance, db.manualStatuses, db.settings);
    if (card.status.includes('PRESENT') || card.status.includes('LATE') || card.timeIn) presentToday += 1;
    if (card.lateMinutes > 0 || card.status.includes('LATE')) lateToday += 1;
    if (card.status === 'ABSENT') absentToday += 1;
    if (['EXCUSED', 'SICK LEAVE', 'EMERGENCY LEAVE'].includes(card.status)) excusedToday += 1;
    if (card.emergency) emergencyLogs += 1;
    if (card.timeIn && !card.timeOut) missingTimeOutToday += 1;
  }

  const readers = db.readers.map(publicReader);
  return {
    dateKey: today,
    branchName: db.settings.branchName,
    totalEmployees: activeEmployees.length,
    presentToday,
    lateToday,
    absentToday,
    excusedToday,
    pendingOfflineSync: readers.reduce((sum, reader) => sum + Number(reader.pendingOfflineLogs || 0), 0),
    devicesOnline: readers.filter((reader) => reader.online).length,
    devicesOffline: readers.filter((reader) => !reader.online).length,
    pendingFingerprintRegistrations: db.enrollmentRequests.filter((request) => request.status === 'PENDING_EMPLOYEE_DETAILS').length,
    emergencyLogs,
    missingTimeOutToday
  };
}

function handleDashboardSummary(res) {
  const db = loadDb();
  sendJson(res, 200, { summary: buildDashboardSummary(db) });
}

async function handleStartEnrollment(res, body) {
  const db = loadDb();
  const deviceId = normalizeDeviceId(body.deviceId || body.readerId || 'ALL');
  const payload = createDisplayCommandPayload({
    deviceId,
    command: 'START_ENROLLMENT',
    deviceDisplay: {
      title: 'ENROLL MODE',
      line1: 'PLACE FINGER',
      line2: 'R503 READY',
      line3: '',
      color: 'PURPLE',
      beep: 'NOTICE',
      durationMs: db.settings.esp32DisplayDurationMs
    },
    expiresInMs: 10 * 60 * 1000
  });

  if (payload.error) {
    sendJson(res, payload.error.status, { accepted: false, code: payload.error.code, message: payload.error.message });
    return;
  }

  db.displayCommands.unshift(payload.commandRecord);
  saveDb(db);
  sendJson(res, 201, {
    accepted: true,
    code: 'START_ENROLLMENT_QUEUED',
    deviceId,
    commandId: payload.commandRecord.id,
    deviceDisplay: payload.commandRecord.deviceDisplay
  });
}

async function handleEnrollmentRequest(req, res, body) {
  const db = loadDb();
  const request = upsertEnrollmentRequest(db, body || {});

  if (!request) {
    sendJson(res, 400, { accepted: false, code: 'INVALID_FINGERPRINT_ID', message: 'fingerprintId must be 1 to 1000.' });
    return;
  }

  saveDb(db);
  sendJson(res, 200, {
    accepted: true,
    code: 'ENROLLMENT_REQUEST_CREATED',
    message: 'Fingerprint enrollment request is pending employee details.',
    request,
    deviceDisplay: buildEnrollmentDisplay(request.fingerprintId)
  });
}

async function handleScan(req, res, body) {
  const db = loadDb();
  const fingerprintId = parseFingerprintId(body.fingerprintId);

  if (!fingerprintId) {
    sendJson(res, 400, { accepted: false, code: 'INVALID_FINGERPRINT_ID', message: 'fingerprintId must be 1 to 1000.' });
    return;
  }

  const scanDate = body.scannedAt ? new Date(body.scannedAt) : new Date();
  if (Number.isNaN(scanDate.getTime())) {
    sendJson(res, 400, { accepted: false, code: 'INVALID_SCAN_TIME', message: 'scannedAt is invalid.' });
    return;
  }

  const employee = findEmployeeByFingerprint(db, fingerprintId);

  if (!employee) {
    upsertEnrollmentRequest(db, { fingerprintId, deviceId: body.deviceId, source: body.source, scannedAt: body.scannedAt });
    const record = createAttendanceRecord(body, scanDate, null, {
      accepted: false,
      code: 'FINGERPRINT_NOT_REGISTERED',
      message: 'Fingerprint is not linked to an employee. Complete registration on the server.',
      attendanceType: '',
      punctuality: '',
      lateMinutes: 0,
      earlyOutMinutes: 0,
      statusText: 'NOT REGISTERED',
      displayDurationMs: db.settings.esp32DisplayDurationMs
    });
    saveDb(db);
    sendJson(res, 200, buildScanResponse(record, null));
    return;
  }

  if (isDuplicateScan(db, fingerprintId, scanDate)) {
    const record = createAttendanceRecord(body, scanDate, employee, {
      accepted: true,
      duplicateTap: true,
      code: 'DUPLICATE_SCAN',
      message: 'Duplicate scan ignored.',
      attendanceType: '',
      punctuality: '',
      lateMinutes: 0,
      earlyOutMinutes: 0,
      statusText: 'ALREADY RECORDED',
      displayDurationMs: db.settings.esp32DisplayDurationMs
    });
    sendJson(res, 200, buildScanResponse(record, employee));
    return;
  }

  const dateKey = localDateKey(scanDate);
  const todayRecords = todayRecordsForEmployee(db, employee.id, dateKey).filter((record) => record.code !== 'DUPLICATE_SCAN');
  const hasTimeIn = todayRecords.some((record) => record.attendanceType === 'TIME_IN');
  const hasTimeOut = todayRecords.some((record) => record.attendanceType === 'TIME_OUT');
  const timeInRecord = todayRecords.find((record) => record.attendanceType === 'TIME_IN') || null;

  let attendanceType = 'TIME_IN';
  let code = 'TIME_IN_RECORDED';
  let message = 'Time in recorded.';
  let status = computeTimeInStatus(employee, scanDate);
  let extraRecordFields = {};

  if (hasTimeIn && !hasTimeOut) {
    attendanceType = 'TIME_OUT';
    code = 'TIME_OUT_RECORDED';
    message = 'Time out recorded.';
    status = computeTimeOutStatus(employee, scanDate);

    const work = calculateWorkSummary(timeInRecord ? new Date(timeInRecord.scannedAt) : null, scanDate, db.settings);
    const requiredMinutes = Math.round(Number(db.settings.requiredPaidHours || 8) * 60);
    const remainingMinutes = Math.max(0, requiredMinutes - work.paidMinutes);
    const emergencyTimeOut = Boolean(body.emergencyTimeOut || body.emergency);

    if (db.settings.earlyOutProtectionEnabled && remainingMinutes > 0 && !(emergencyTimeOut && db.settings.emergencyTimeOutEnabled)) {
      attendanceType = '';
      code = 'TIME_OUT_NOT_ALLOWED';
      message = 'Required work hours not completed.';
      status = {
        punctuality: 'EARLY_OUT',
        lateMinutes: 0,
        earlyOutMinutes: remainingMinutes,
        statusText: `REMAINING ${remainingMinutes} MIN`
      };
      extraRecordFields = {
        reason: 'Required work hours not completed',
        remainingMinutes,
        paidMinutes: work.paidMinutes,
        paidHours: work.paidHours
      };
    } else if (emergencyTimeOut && db.settings.emergencyTimeOutEnabled) {
      code = 'EMERGENCY_TIME_OUT';
      message = 'Emergency time out recorded.';
      status = { punctuality: 'EMERGENCY', lateMinutes: 0, earlyOutMinutes: 0, statusText: 'EMERGENCY' };
      extraRecordFields = {
        emergency: true,
        reason: cleanDisplayText(body.reason || 'Emergency Time Out', 120),
        approvedBy: cleanDisplayText(body.approvedBy || 'Admin', 80),
        paidMinutes: work.paidMinutes,
        paidHours: work.paidHours
      };
    } else {
      extraRecordFields = {
        paidMinutes: work.paidMinutes,
        paidHours: work.paidHours
      };
    }
  } else if (hasTimeIn && hasTimeOut) {
    attendanceType = '';
    code = 'ATTENDANCE_ALREADY_COMPLETE';
    message = 'Attendance for today is already complete.';
    status = { punctuality: '', lateMinutes: 0, earlyOutMinutes: 0, statusText: 'ALREADY COMPLETE' };
  }

  const accepted = !['ATTENDANCE_ALREADY_COMPLETE', 'TIME_OUT_NOT_ALLOWED'].includes(code);
  const record = createAttendanceRecord(body, scanDate, employee, {
    accepted,
    duplicateTap: false,
    code,
    message,
    attendanceType,
    punctuality: status.punctuality || '',
    lateMinutes: status.lateMinutes || 0,
    earlyOutMinutes: status.earlyOutMinutes || 0,
    statusText: status.statusText || '',
    displayDurationMs: db.settings.esp32DisplayDurationMs,
    ...extraRecordFields
  });

  if (isRecordedAttendanceLog(record)) {
    db.attendance.unshift(record);
    saveDb(db);
  }
  sendJson(res, 200, buildScanResponse(record, employee));
}

function commandMatchesDevice(command, deviceId) {
  const target = String(command.deviceId || '').trim();
  return target === deviceId || target === '*' || target.toUpperCase() === 'ALL';
}

function pruneExpiredDisplayCommands(db) {
  const before = db.displayCommands.length;
  const now = Date.now();
  db.displayCommands = db.displayCommands.filter((command) => {
    if (command.status === 'PENDING') {
      const expiresAt = command.expiresAt ? new Date(command.expiresAt).getTime() : null;
      return !expiresAt || expiresAt > now;
    }

    const deliveredAt = command.deliveredAt ? new Date(command.deliveredAt).getTime() : 0;
    return deliveredAt && now - deliveredAt < 24 * 60 * 60 * 1000;
  });
  return before !== db.displayCommands.length;
}

function createDisplayCommandPayload(body) {
  const deviceId = normalizeDeviceId(body.deviceId || '');
  if (!deviceId) {
    return { error: { status: 400, code: 'DEVICE_ID_REQUIRED', message: 'deviceId is required.' } };
  }

  const command = upperDisplayText(body.command || 'SHOW_MESSAGE', 32);
  if (!DISPLAY_COMMAND_TYPES.includes(command)) {
    return {
      error: {
        status: 400,
        code: 'INVALID_DISPLAY_COMMAND',
        message: `command must be one of: ${DISPLAY_COMMAND_TYPES.join(', ')}.`
      }
    };
  }

  const fingerprintId = parseFingerprintId(body.fingerprintId ?? (body.payload && body.payload.fingerprintId));
  if (command === 'DELETE_FINGERPRINT' && !fingerprintId) {
    return {
      error: {
        status: 400,
        code: 'INVALID_FINGERPRINT_ID',
        message: 'fingerprintId must be 1 to 1000 for DELETE_FINGERPRINT.'
      }
    };
  }

  const displayDefaults = defaultCommandDisplay(command, fingerprintId);
  const displaySource = body.deviceDisplay && typeof body.deviceDisplay === 'object' ? body.deviceDisplay : body;
  const deviceDisplay = normalizeDeviceDisplay(displaySource, displayDefaults);

  if (!isSupportedCommandTitle(deviceDisplay.title)) {
    return {
      error: {
        status: 400,
        code: 'UNSUPPORTED_DISPLAY_TITLE',
        message: 'Use one of the supported OLED command titles.',
        supportedTitles: [...DISPLAY_COMMAND_TITLES, 'PENDING LOGS: 5']
      }
    };
  }

  const now = nowIso();
  const expiresInMs = clampNumber(body.expiresInMs, 5 * 60 * 1000, 10 * 1000, 24 * 60 * 60 * 1000);
  return {
    commandRecord: {
      id: createId('display'),
      deviceId,
      command,
      fingerprintId: fingerprintId || null,
      payload: {
        ...(body.payload && typeof body.payload === 'object' ? body.payload : {}),
        ...(fingerprintId ? { fingerprintId } : {})
      },
      deviceDisplay,
      status: 'PENDING',
      createdAt: now,
      expiresAt: new Date(Date.now() + expiresInMs).toISOString()
    }
  };
}

async function handleQueueDisplayCommand(res, body) {
  const db = loadDb();
  pruneExpiredDisplayCommands(db);
  const payload = createDisplayCommandPayload(body || {});

  if (payload.error) {
    sendJson(res, payload.error.status, {
      accepted: false,
      code: payload.error.code,
      message: payload.error.message,
      ...(payload.error.supportedTitles ? { supportedTitles: payload.error.supportedTitles } : {})
    });
    return;
  }

  db.displayCommands.unshift(payload.commandRecord);
  saveDb(db);
  sendJson(res, 201, {
    accepted: true,
    code: 'DISPLAY_COMMAND_QUEUED',
    commandId: payload.commandRecord.id,
    command: payload.commandRecord.command,
    deviceId: payload.commandRecord.deviceId,
    deviceDisplay: payload.commandRecord.deviceDisplay,
    expiresAt: payload.commandRecord.expiresAt
  });
}

function queueFingerprintDeleteCommand(db, fingerprintId, deviceId, settings = defaultSettings()) {
  const targetDevice = normalizeDeviceId(deviceId || 'ALL') || 'ALL';
  const payload = createDisplayCommandPayload({
    deviceId: targetDevice,
    command: 'DELETE_FINGERPRINT',
    fingerprintId,
    deviceDisplay: {
      title: 'REMOVE FINGER',
      line1: `ID ${fingerprintId}`,
      line2: 'DELETE TEMPLATE',
      line3: '',
      color: 'YELLOW',
      beep: 'WARNING',
      durationMs: settings.esp32DisplayDurationMs
    },
    expiresInMs: 24 * 60 * 60 * 1000
  });

  if (payload.error) return null;
  db.displayCommands.unshift(payload.commandRecord);
  return payload.commandRecord;
}

function handleGetDisplayCommand(res, url) {
  const db = loadDb();
  const deviceId = normalizeDeviceId(url.searchParams.get('deviceId') || '');

  if (!deviceId) {
    sendJson(res, 400, { hasCommand: false, code: 'DEVICE_ID_REQUIRED', message: 'deviceId is required.' });
    return;
  }

  let changed = pruneExpiredDisplayCommands(db);
  const pending = db.displayCommands
    .filter((command) => command.status === 'PENDING' && commandMatchesDevice(command, deviceId))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))[0] || null;

  if (!pending) {
    if (changed) saveDb(db);
    sendJson(res, 200, { hasCommand: false, command: 'NONE', deviceId, serverTime: nowIso() });
    return;
  }

  pending.status = 'DELIVERED';
  pending.deliveredAt = nowIso();
  pending.deliveredTo = deviceId;
  changed = true;

  if (changed) saveDb(db);
  sendJson(res, 200, {
    hasCommand: true,
    command: pending.command,
    commandId: pending.id,
    deviceId,
    fingerprintId: pending.fingerprintId || (pending.payload && pending.payload.fingerprintId) || null,
    payload: pending.payload || {},
    deviceDisplay: pending.deviceDisplay,
    serverTime: nowIso()
  });
}

async function handleDisplayCommandAck(res, body) {
  const db = loadDb();
  const commandId = cleanDisplayText(body.commandId || body.id || '', 80);
  const deviceId = normalizeDeviceId(body.deviceId || '');

  if (!commandId) {
    sendJson(res, 400, { accepted: false, code: 'COMMAND_ID_REQUIRED', message: 'commandId is required.' });
    return;
  }

  const command = db.displayCommands.find((item) => item.id === commandId);
  if (!command) {
    sendJson(res, 404, { accepted: false, code: 'COMMAND_NOT_FOUND', message: 'Display command was not found.' });
    return;
  }

  command.status = 'ACKNOWLEDGED';
  command.acknowledgedAt = nowIso();
  command.acknowledgedBy = deviceId || command.deliveredTo || '';
  command.ackStatus = upperDisplayText(body.status || 'OK', 24);
  command.ackMessage = cleanDisplayText(body.message || '', 120);
  command.ackFingerprintId = parseFingerprintId(body.fingerprintId) || command.fingerprintId || null;

  saveDb(db);
  sendJson(res, 200, {
    accepted: true,
    code: 'DISPLAY_COMMAND_ACKNOWLEDGED',
    commandId: command.id,
    status: command.ackStatus
  });
}

function employeePayload(body, existing = null, settings = defaultSettings()) {
  const fullName = normalizeName(body.fullName);
  const rawFingerprintId = body.fingerprintId ?? (existing && existing.fingerprintId);
  const fingerprintId = parseFingerprintId(rawFingerprintId);
  const allowNoFingerprint = body.allowNoFingerprint === true;

  if (!fullName) return { error: { status: 400, code: 'FULL_NAME_REQUIRED', message: 'Full name is required.' } };
  if (!fingerprintId && !existing && !allowNoFingerprint) return { error: { status: 400, code: 'INVALID_FINGERPRINT_ID', message: 'fingerprintId must be 1 to 1000.' } };

  const graceMinutes = Math.max(0, Number(body.graceMinutes ?? settings.graceMinutes));
  const weeklySchedule = normalizeWeeklySchedule(body.weeklySchedule, body.shiftStart || settings.defaultShiftStart, body.shiftEnd || settings.defaultShiftEnd);

  return {
    fullName,
    photoUrl: cleanDisplayText(body.photoUrl ?? existing?.photoUrl ?? '', 1000),
    employeeCode: cleanDisplayText(body.employeeCode || existing?.employeeCode || '', 40),
    fingerprintId,
    allowNoFingerprint,
    graceMinutes,
    weeklySchedule,
    active: body.active !== undefined ? body.active !== false : existing?.active !== false,
    fingerprintLabel: cleanDisplayText(body.fingerprintLabel || 'Primary Finger', 32),
    deviceId: normalizeDeviceId(body.deviceId || '')
  };
}

async function handleCreateEmployee(res, body) {
  const db = loadDb();
  const payload = employeePayload(body, null, db.settings);
  if (payload.error) {
    sendJson(res, payload.error.status, { code: payload.error.code, message: payload.error.message });
    return;
  }

  const duplicate = payload.fingerprintId ? findFingerprintOwner(db, payload.fingerprintId) : null;
  if (duplicate) {
    sendJson(res, 409, { code: 'FINGERPRINT_ALREADY_LINKED', message: `Fingerprint ID ${payload.fingerprintId} is already linked to ${duplicate.fullName}.` });
    return;
  }

  const monday = payload.weeklySchedule.monday;
  const employeeId = createId('employee');
  const employee = {
    id: employeeId,
    employeeCode: payload.employeeCode || employeeId.slice(-8),
    fullName: payload.fullName,
    photoUrl: payload.photoUrl,
    fingerprintId: payload.fingerprintId || null,
    fingerprints: payload.fingerprintId
      ? [normalizeFingerprintRecord({ label: payload.fingerprintLabel, deviceId: payload.deviceId }, payload.fingerprintId, payload.deviceId)]
      : [],
    shiftStart: monday.timeIn,
    shiftEnd: monday.timeOut,
    graceMinutes: payload.graceMinutes,
    weeklySchedule: payload.weeklySchedule,
    active: payload.active,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };

  db.employees.unshift(employee);
  if (employee.fingerprintId) {
    completeEnrollmentRequest(db, employee.fingerprintId, employee.id);
  }

  saveDb(db);
  sendJson(res, 201, { employee: safePublicEmployee(employee) });
}

async function handleUpdateEmployee(res, employeeId, body) {
  const db = loadDb();
  const employee = db.employees.find((item) => item.id === employeeId);
  if (!employee) {
    sendJson(res, 404, { code: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found.' });
    return;
  }

  const payload = employeePayload(body, employee, db.settings);
  if (payload.error) {
    sendJson(res, payload.error.status, { code: payload.error.code, message: payload.error.message });
    return;
  }

  const duplicate = findFingerprintOwner(db, payload.fingerprintId, employee.id);
  if (duplicate) {
    sendJson(res, 409, { code: 'FINGERPRINT_ALREADY_LINKED', message: `Fingerprint ID ${payload.fingerprintId} is already linked to ${duplicate.fullName}.` });
    return;
  }

  const monday = payload.weeklySchedule.monday;
  employee.fullName = payload.fullName;
  employee.photoUrl = payload.photoUrl;
  employee.employeeCode = payload.employeeCode || employee.employeeCode;
  if (payload.fingerprintId) {
    employee.fingerprintId = payload.fingerprintId;
    if (!activeEmployeeFingerprints(employee).some((fingerprint) => Number(fingerprint.fingerprintId) === payload.fingerprintId)) {
      employee.fingerprints.unshift(normalizeFingerprintRecord({ label: payload.fingerprintLabel, deviceId: payload.deviceId }, payload.fingerprintId, payload.deviceId));
    }
  } else if (!activeEmployeeFingerprints(employee).length) {
    employee.fingerprintId = null;
  }
  employee.graceMinutes = payload.graceMinutes;
  employee.weeklySchedule = payload.weeklySchedule;
  employee.shiftStart = monday.timeIn;
  employee.shiftEnd = monday.timeOut;
  employee.active = payload.active;
  employee.updatedAt = nowIso();

  saveDb(db);
  sendJson(res, 200, { employee: safePublicEmployee(employee) });
}

async function handleAddEmployeeFingerprint(res, employeeId, body) {
  const db = loadDb();
  const employee = db.employees.find((item) => item.id === employeeId && item.active !== false);
  if (!employee) {
    sendJson(res, 404, { code: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found.' });
    return;
  }

  const fingerprintId = parseFingerprintId(body.fingerprintId);
  if (!fingerprintId) {
    sendJson(res, 400, { code: 'INVALID_FINGERPRINT_ID', message: 'fingerprintId must be 1 to 1000.' });
    return;
  }

  const ownMatch = activeEmployeeFingerprints(employee).find((fingerprint) => Number(fingerprint.fingerprintId) === fingerprintId);
  if (ownMatch) {
    sendJson(res, 409, { code: 'FINGERPRINT_ALREADY_ON_EMPLOYEE', message: `Fingerprint ID ${fingerprintId} is already linked to ${employee.fullName}.` });
    return;
  }

  const duplicate = findFingerprintOwner(db, fingerprintId, employee.id);
  if (duplicate) {
    sendJson(res, 409, { code: 'FINGERPRINT_ALREADY_LINKED', message: `Fingerprint ID ${fingerprintId} is already linked to ${duplicate.fullName}.` });
    return;
  }

  employee.fingerprints.unshift(normalizeFingerprintRecord({
    fingerprintId,
    label: body.label || 'Additional Finger',
    deviceId: body.deviceId || ''
  }, fingerprintId, body.deviceId || ''));
  employee.updatedAt = nowIso();
  completeEnrollmentRequest(db, fingerprintId, employee.id);

  saveDb(db);
  sendJson(res, 201, { employee: safePublicEmployee(employee) });
}

async function handleDeleteEmployeeFingerprint(res, employeeId, fingerprintIdText) {
  const db = loadDb();
  const employee = db.employees.find((item) => item.id === employeeId && item.active !== false);
  if (!employee) {
    sendJson(res, 404, { code: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found.' });
    return;
  }

  const fingerprintId = parseFingerprintId(fingerprintIdText);
  if (!fingerprintId) {
    sendJson(res, 400, { code: 'INVALID_FINGERPRINT_ID', message: 'fingerprintId must be 1 to 1000.' });
    return;
  }

  const targetFingerprint = activeEmployeeFingerprints(employee)
    .find((fingerprint) => Number(fingerprint.fingerprintId) === fingerprintId);

  if (!targetFingerprint) {
    sendJson(res, 404, { code: 'FINGERPRINT_NOT_FOUND', message: 'Fingerprint not found on employee.' });
    return;
  }

  const before = employee.fingerprints.length;
  employee.fingerprints = employee.fingerprints.filter((fingerprint) => Number(fingerprint.fingerprintId) !== fingerprintId);
  if (employee.fingerprints.length === before) {
    sendJson(res, 404, { code: 'FINGERPRINT_NOT_FOUND', message: 'Fingerprint not found on employee.' });
    return;
  }

  if (Number(employee.fingerprintId) === fingerprintId) {
    const remaining = activeEmployeeFingerprints(employee);
    employee.fingerprintId = remaining.length ? remaining[0].fingerprintId : null;
  }
  employee.updatedAt = nowIso();

  const deleteCommand = queueFingerprintDeleteCommand(
    db,
    fingerprintId,
    targetFingerprint.deviceId || 'ALL',
    db.settings
  );

  saveDb(db);
  sendJson(res, 200, {
    employee: safePublicEmployee(employee),
    commandQueued: Boolean(deleteCommand),
    commandId: deleteCommand ? deleteCommand.id : '',
    deviceId: deleteCommand ? deleteCommand.deviceId : '',
    message: deleteCommand
      ? `Fingerprint ID ${fingerprintId} removed from server and delete command queued for ${deleteCommand.deviceId}.`
      : `Fingerprint ID ${fingerprintId} removed from server. Device delete command was not queued.`
  });
}

async function handleDeletePendingEnrollment(res, requestId) {
  const db = loadDb();
  const request = db.enrollmentRequests.find((item) => item.id === requestId && item.status === 'PENDING_EMPLOYEE_DETAILS');

  if (!request) {
    sendJson(res, 404, { code: 'PENDING_ENROLLMENT_NOT_FOUND', message: 'Pending enrollment request was not found.' });
    return;
  }

  const fingerprintId = parseFingerprintId(request.fingerprintId);
  if (!fingerprintId) {
    sendJson(res, 400, { code: 'INVALID_FINGERPRINT_ID', message: 'Pending request has an invalid fingerprintId.' });
    return;
  }

  request.status = 'CANCELED';
  request.updatedAt = nowIso();
  request.canceledAt = nowIso();

  const deleteCommand = queueFingerprintDeleteCommand(
    db,
    fingerprintId,
    request.deviceId || request.lastDeviceId || 'ALL',
    db.settings
  );

  saveDb(db);
  sendJson(res, 200, {
    accepted: true,
    code: 'PENDING_ENROLLMENT_DELETED',
    fingerprintId,
    commandQueued: Boolean(deleteCommand),
    commandId: deleteCommand ? deleteCommand.id : '',
    deviceId: deleteCommand ? deleteCommand.deviceId : '',
    message: deleteCommand
      ? `Pending fingerprint ID ${fingerprintId} canceled and delete command queued for ${deleteCommand.deviceId}.`
      : `Pending fingerprint ID ${fingerprintId} canceled. Device delete command was not queued.`
  });
}

function workDurationText(timeInRecord, timeOutRecord) {
  if (!timeInRecord || !timeOutRecord) return '-';
  const ms = new Date(timeOutRecord.scannedAt).getTime() - new Date(timeInRecord.scannedAt).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

function buildTimeCardRecord(employee, dateKey, records, manualStatuses = [], settings = defaultSettings()) {
  const schedule = getScheduleForDate(employee, dateKey);
  const validRecords = records
    .filter((record) => record.employeeId === employee.id && record.dateKey === dateKey && record.accepted === true && record.code !== 'DUPLICATE_SCAN')
    .sort((a, b) => new Date(a.scannedAt) - new Date(b.scannedAt));

  const timeIn = validRecords.find((record) => record.attendanceType === 'TIME_IN') || null;
  const timeOut = validRecords.find((record) => record.attendanceType === 'TIME_OUT') || null;
  const manual = manualStatuses.find((item) => item.employeeId === employee.id && item.dateKey === dateKey) || null;
  const emergency = validRecords.some((record) => record.emergency || String(record.code || '').startsWith('EMERGENCY'));
  const work = calculateWorkSummary(
    timeIn ? new Date(timeIn.scannedAt) : null,
    timeOut ? new Date(timeOut.scannedAt) : null,
    settings
  );

  let status = 'ABSENT';
  let statusClass = 'bad';
  let lateMinutes = 0;
  let earlyOutMinutes = 0;
  let reason = '';

  if (manual) {
    status = manual.status.replaceAll('_', ' ');
    reason = manual.reason || status;
    statusClass = manual.status === 'ABSENT' ? 'bad' : 'good';
  } else if (schedule.dayOff && !timeIn && !timeOut) {
    status = 'DAY OFF';
    statusClass = 'muted';
  } else if (schedule.dayOff && (timeIn || timeOut)) {
    status = 'WORKED DAY OFF';
    statusClass = 'warn';
  } else if (timeIn && !timeOut) {
    lateMinutes = Number(timeIn.lateMinutes || 0);
    status = lateMinutes > 0 ? 'LATE / INCOMPLETE' : 'INCOMPLETE';
    statusClass = 'bad';
  } else if (timeIn && timeOut) {
    lateMinutes = Number(timeIn.lateMinutes || 0);
    earlyOutMinutes = Number(timeOut.earlyOutMinutes || 0);

    if (emergency) {
      status = 'EMERGENCY';
      statusClass = 'warn';
      reason = timeOut.reason || timeIn.reason || 'Emergency attendance';
    } else if (lateMinutes > 0 && earlyOutMinutes > 0) {
      status = 'LATE / EARLY OUT';
      statusClass = 'warn';
    } else if (lateMinutes > 0) {
      status = 'LATE';
      statusClass = 'warn';
    } else if (earlyOutMinutes > 0) {
      status = 'EARLY OUT';
      statusClass = 'warn';
    } else {
      status = 'PRESENT';
      statusClass = 'good';
    }
  }

  return {
    dateKey,
    dayLabel: schedule.dayLabel,
    employeeId: employee.id,
    fullName: employee.fullName,
    fingerprintId: employee.fingerprintId,
    branch: settings.branchName,
    location: employee.location || settings.branchName,
    scheduledTimeIn: schedule.dayOff ? '' : formatTimeText(schedule.timeIn),
    scheduledTimeOut: schedule.dayOff ? '' : formatTimeText(schedule.timeOut),
    schedule: schedule.dayOff ? 'Day Off' : `${formatTimeText(schedule.timeIn)} - ${formatTimeText(schedule.timeOut)}`,
    actualTimeIn: timeIn ? timeIn.displayTime : '',
    actualTimeOut: timeOut ? timeOut.displayTime : '',
    timeIn: timeIn ? timeIn.displayTime : '',
    timeOut: timeOut ? timeOut.displayTime : '',
    status,
    statusClass,
    reason,
    lateMinutes,
    earlyOutMinutes,
    grossHours: work.grossHours,
    lunchDeduction: decimalHours(work.lunchDeductionMinutes),
    lunchDeductionMinutes: work.lunchDeductionMinutes,
    paidHours: work.paidHours,
    totalHoursWorked: work.paidHours,
    overtimeMinutes: work.overtimeMinutes,
    workDuration: workDurationTextFromMinutes(work.paidMinutes),
    emergency,
    manualStatus: manual
  };
}

function handleTimeCard(res, url) {
  const db = loadDb();
  const today = localDateKey(new Date());
  const fromKey = url.searchParams.get('from') || today;
  const toKey = url.searchParams.get('to') || fromKey;
  const employeeId = url.searchParams.get('employeeId') || '';
  const branch = String(url.searchParams.get('branch') || '').trim().toLowerCase();
  const statusFilter = upperDisplayText(url.searchParams.get('status') || '', 32);

  let fromDate = dateKeyToUtcDate(fromKey);
  let toDate = dateKeyToUtcDate(toKey);
  if (!fromDate || !toDate) {
    sendJson(res, 400, { code: 'INVALID_DATE', message: 'Use YYYY-MM-DD for from and to.' });
    return;
  }
  if (fromDate > toDate) [fromDate, toDate] = [toDate, fromDate];

  const employees = db.employees
    .filter((employee) => employee.active !== false)
    .filter((employee) => !employeeId || employee.id === employeeId)
    .sort((a, b) => String(a.fullName).localeCompare(String(b.fullName)));

  const timeCards = [];
  for (let d = fromDate; d <= toDate; d = addDaysUtc(d, 1)) {
    const dateKey = dateKeyFromUtcDate(d);
    for (const employee of employees) {
      const card = buildTimeCardRecord(employee, dateKey, db.attendance, db.manualStatuses, db.settings);
      if (branch && !String(card.branch || card.location || '').toLowerCase().includes(branch)) continue;
      if (statusFilter && STATUS_FILTERS.includes(statusFilter) && !String(card.status || '').replaceAll(' ', '_').includes(statusFilter)) continue;
      timeCards.push(card);
    }
  }

  sendJson(res, 200, { timeCards, from: dateKeyFromUtcDate(fromDate), to: dateKeyFromUtcDate(toDate), settings: db.settings });
}

function csvEscape(value) {
  const text = String(value ?? '');
  if (/[",\n\r]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function timeCardRowsForUrl(url) {
  const db = loadDb();
  const today = localDateKey(new Date());
  const fromKey = url.searchParams.get('from') || today;
  const toKey = url.searchParams.get('to') || fromKey;
  const employeeId = url.searchParams.get('employeeId') || '';
  const branch = String(url.searchParams.get('branch') || '').trim().toLowerCase();
  const statusFilter = upperDisplayText(url.searchParams.get('status') || '', 32);
  let fromDate = dateKeyToUtcDate(fromKey);
  let toDate = dateKeyToUtcDate(toKey);
  if (!fromDate || !toDate) return { error: { code: 'INVALID_DATE', message: 'Use YYYY-MM-DD for from and to.' } };
  if (fromDate > toDate) [fromDate, toDate] = [toDate, fromDate];

  const employees = db.employees
    .filter((employee) => employee.active !== false)
    .filter((employee) => !employeeId || employee.id === employeeId)
    .sort((a, b) => String(a.fullName).localeCompare(String(b.fullName)));

  const rows = [];
  for (let d = fromDate; d <= toDate; d = addDaysUtc(d, 1)) {
    const dateKey = dateKeyFromUtcDate(d);
    for (const employee of employees) {
      const card = buildTimeCardRecord(employee, dateKey, db.attendance, db.manualStatuses, db.settings);
      if (branch && !String(card.branch || card.location || '').toLowerCase().includes(branch)) continue;
      if (statusFilter && STATUS_FILTERS.includes(statusFilter) && !String(card.status || '').replaceAll(' ', '_').includes(statusFilter)) continue;
      rows.push(card);
    }
  }
  return { rows, settings: db.settings, from: dateKeyFromUtcDate(fromDate), to: dateKeyFromUtcDate(toDate) };
}

function handleTimeCardCsv(res, url) {
  const result = timeCardRowsForUrl(url);
  if (result.error) {
    sendJson(res, 400, result.error);
    return;
  }

  const headers = [
    'Date',
    'Employee',
    'Branch',
    'Scheduled Time In',
    'Scheduled Time Out',
    'Actual Time In',
    'Actual Time Out',
    'Late Minutes',
    'Early Out Minutes',
    'Gross Hours',
    'Lunch Deduction',
    'Paid Hours',
    'Overtime Minutes',
    'Status',
    'Reason'
  ];
  const rows = result.rows.map((record) => [
    record.dateKey,
    record.fullName,
    record.branch,
    record.scheduledTimeIn,
    record.scheduledTimeOut,
    record.actualTimeIn,
    record.actualTimeOut,
    record.lateMinutes,
    record.earlyOutMinutes,
    record.grossHours,
    record.lunchDeduction,
    record.paidHours,
    record.overtimeMinutes,
    record.status,
    record.reason
  ]);
  const csv = [headers, ...rows].map((row) => row.map(csvEscape).join(',')).join('\r\n');
  send(res, 200, csv, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="gms-time-card.csv"'
  });
}

function handlePrintableTimeCard(res, url) {
  const result = timeCardRowsForUrl(url);
  if (result.error) {
    sendJson(res, 400, result.error);
    return;
  }

  const rows = result.rows.map((record) => `
    <tr>
      <td>${record.dateKey}</td>
      <td>${record.fullName}</td>
      <td>${record.scheduledTimeIn || '-'}</td>
      <td>${record.scheduledTimeOut || '-'}</td>
      <td>${record.actualTimeIn || '-'}</td>
      <td>${record.actualTimeOut || '-'}</td>
      <td>${record.lateMinutes || 0}</td>
      <td>${record.earlyOutMinutes || 0}</td>
      <td>${record.paidHours}</td>
      <td>${record.status}</td>
    </tr>
  `).join('');
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>GMS Time Card</title>
<style>body{font-family:Arial,sans-serif;padding:24px;color:#172033}h1{font-size:22px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #d7dde8;padding:8px;text-align:left;font-size:12px}th{background:#f2f5f9}</style>
</head><body><h1>${result.settings.branchName} Time Card</h1><p>${result.from} to ${result.to}</p><table><thead><tr><th>Date</th><th>Employee</th><th>Scheduled In</th><th>Scheduled Out</th><th>Actual In</th><th>Actual Out</th><th>Late</th><th>Early Out</th><th>Paid Hours</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table><script>window.print();</script></body></html>`;
  send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
}

async function handleManualStatus(res, body) {
  const db = loadDb();
  const normalized = normalizeManualStatus({
    id: body.id,
    employeeId: body.employeeId,
    dateKey: body.dateKey,
    status: body.status,
    reason: body.reason,
    remarks: body.remarks,
    approvedBy: body.approvedBy,
    createdAt: body.createdAt
  }, db);

  if (!normalized) {
    sendJson(res, 400, {
      code: 'INVALID_MANUAL_STATUS',
      message: `Use employeeId, dateKey, and one of: ${MANUAL_STATUSES.join(', ')}.`
    });
    return;
  }

  const existing = db.manualStatuses.find((item) => item.employeeId === normalized.employeeId && item.dateKey === normalized.dateKey);
  if (existing) {
    Object.assign(existing, normalized, { id: existing.id, createdAt: existing.createdAt, updatedAt: nowIso() });
  } else {
    db.manualStatuses.unshift(normalized);
  }

  saveDb(db);
  sendJson(res, 200, { manualStatus: existing || normalized });
}

async function handleEmergencyAttendance(res, body) {
  if (!EMERGENCY_ATTENDANCE_PASSWORD || !safeEqual(String(body.password || ''), EMERGENCY_ATTENDANCE_PASSWORD)) {
    sendJson(res, 403, { code: 'INVALID_EMERGENCY_PASSWORD', message: 'Incorrect emergency attendance password.' });
    return;
  }
  const db = loadDb();
  const employee = db.employees.find((item) => item.id === body.employeeId && item.active !== false);
  if (!employee) {
    sendJson(res, 404, { code: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found.' });
    return;
  }

  const type = upperDisplayText(body.attendanceType || body.type || '', 32);
  if (!['TIME_IN', 'TIME_OUT'].includes(type)) {
    sendJson(res, 400, { code: 'INVALID_ATTENDANCE_TYPE', message: 'attendanceType must be TIME_IN or TIME_OUT.' });
    return;
  }

  const scanDate = body.scannedAt ? new Date(body.scannedAt) : new Date();
  if (Number.isNaN(scanDate.getTime())) {
    sendJson(res, 400, { code: 'INVALID_SCAN_TIME', message: 'scannedAt is invalid.' });
    return;
  }

  const status = type === 'TIME_IN' ? computeTimeInStatus(employee, scanDate) : computeTimeOutStatus(employee, scanDate);
  const record = createAttendanceRecord({
    fingerprintId: employee.fingerprintId,
    scannedAt: scanDate.toISOString(),
    deviceId: 'SERVER_ADMIN',
    source: 'SERVER_ADMIN'
  }, scanDate, employee, {
    accepted: true,
    code: type === 'TIME_IN' ? 'EMERGENCY_TIME_IN' : 'EMERGENCY_TIME_OUT',
    message: type === 'TIME_IN' ? 'Emergency time in recorded.' : 'Emergency time out recorded.',
    attendanceType: type,
    punctuality: 'EMERGENCY',
    lateMinutes: status.lateMinutes || 0,
    earlyOutMinutes: status.earlyOutMinutes || 0,
    statusText: 'EMERGENCY',
    emergency: true,
    reason: cleanDisplayText(body.reason || 'Emergency Attendance', 120),
    approvedBy: cleanDisplayText(body.approvedBy || 'Admin', 80),
    remarks: cleanDisplayText(body.remarks || '', 160),
    displayDurationMs: db.settings.esp32DisplayDurationMs
  });

  db.attendance.unshift(record);
  saveDb(db);
  sendJson(res, 201, buildScanResponse(record, employee));
}

async function handleAttendanceReview(res, body) {
  const db = loadDb();
  const record = db.attendance.find((item) => item.id === String(body.id || ''));
  if (!record) {
    sendJson(res, 404, { code: 'ATTENDANCE_NOT_FOUND', message: 'Attendance record not found.' });
    return;
  }
  const decision = String(body.decision || '').toUpperCase();
  if (!['VERIFIED', 'CORRECTION_REQUESTED'].includes(decision)) {
    sendJson(res, 400, { code: 'INVALID_REVIEW_DECISION', message: 'Use VERIFIED or CORRECTION_REQUESTED.' });
    return;
  }
  record.reviewStatus = decision;
  record.reviewNotes = cleanDisplayText(body.notes || '', 300);
  record.reviewedBy = cleanDisplayText(body.reviewedBy || 'GWD Administrator', 80);
  record.reviewedAt = nowIso();
  saveDb(db);
  sendJson(res, 200, { attendance: record });
}

function routeStatic(req, res, pathname) {
  const pageRoutes = {
    '/': 'views/dashboard.html',
    '/dashboard': 'views/dashboard.html',
    '/timecard': 'views/timecard.html',
    '/enrollment': 'views/enrollment.html',
    '/employees': 'views/employees.html',
    '/devices': 'views/devices.html',
    '/settings': 'views/settings.html',
    '/logs': 'views/logs.html'
  };
  const requestedPage = pageRoutes[pathname];
  const relativePath = requestedPage && !validSession(req)
    ? 'index.html'
    : requestedPage || pathname.replace(/^\//, '');
  const filePath = path.join(PUBLIC_DIR, relativePath);
  const resolved = path.resolve(filePath);

  if (!resolved.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { code: 'FORBIDDEN', message: 'Forbidden.' });
    return true;
  }

  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    sendFile(req, res, resolved, getContentType(resolved));
    return true;
  }

  return false;
}

function isPublicApi(pathname, method) {
  return method === 'POST' && pathname === '/api/auth/login';
}

async function handleAuthLogin(req, res) {
  const ip = requestIp(req);
  if (!consumeRateLimit(`auth:${ip}`, AUTH_ATTEMPTS_PER_15_MINUTES, 15 * 60 * 1000)) {
    sendJson(res, 429, { code: 'TOO_MANY_ATTEMPTS', message: 'Too many login attempts. Try again later.' });
    return;
  }
  const body = await readBody(req);
  const provided = String(body.apiKey || '');
  const account = ROLE_CREDENTIALS.find((item) => safeEqual(body.username, item.username) && safeEqual(body.password, item.password));
  const apiKeyLogin = provided && safeEqual(provided, API_KEY);
  if (!account && !apiKeyLogin) {
    sendJson(res, 401, { code: 'INVALID_CREDENTIALS', message: 'Invalid username, password, or server key.' });
    return;
  }
  const role = account?.role || 'admin';
  const username = account?.username || 'server-admin';
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS, ip, role, username });
  const secure = String(getHeader(req, 'x-forwarded-proto') || '').toLowerCase() === 'https';
  res.setHeader('Set-Cookie', `gms_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`);
  sendJson(res, 200, { ok: true, role, username, expiresInHours: SESSION_TTL_MS / 3600000 });
}

function handleAuthMe(req, res) {
  const session = validSession(req);
  if (!session) {
    sendJson(res, 401, { code: 'AUTH_REQUIRED', message: 'Authentication is required.' });
    return;
  }
  sendJson(res, 200, { authenticated: true, role: session.role, username: session.username, expiresAt: new Date(session.expiresAt).toISOString() });
}

function handleAuthLogout(req, res) {
  const token = parseCookies(req).gms_session;
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'gms_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  sendJson(res, 200, { ok: true });
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const method = req.method.toUpperCase();
  const origin = String(getHeader(req, 'origin') || '');
  for (const [name, value] of Object.entries(securityHeaders(req))) res.setHeader(name, value);
  res.once('finish', () => auditRequest(req, pathname, method, res.statusCode));

  if (origin && !allowedOrigin(req)) {
    sendJson(res, 403, { code: 'ORIGIN_NOT_ALLOWED', message: 'Request origin is not allowed.' });
    return;
  }

  if (!consumeRateLimit(`request:${requestIp(req)}`, REQUESTS_PER_MINUTE, 60 * 1000)) {
    res.setHeader('Retry-After', '60');
    sendJson(res, 429, { code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' });
    return;
  }

  if (method === 'OPTIONS') {
    send(res, 204, '');
    return;
  }

  try {
    if (method === 'GET' && pathname === '/health') {
      const storageStatus = storage.getStatus();
      const primaryFailed = ['unavailable', 'write_failed'].includes(storageStatus.postgresql);
      const fallbackFailed = storageStatus.activePrimary !== 'postgresql' && ['failed', 'invalid'].includes(storageStatus.sqliteBackup);
      const degraded = primaryFailed || fallbackFailed;
      sendJson(res, degraded ? 503 : 200, { ok: !degraded, status: degraded ? 'degraded' : 'healthy', serverTime: nowIso(), timezone: DEVICE_TIMEZONE, schemaVersion: SCHEMA_VERSION, storage: storageStatus });
      return;
    }

    if (method === 'POST' && pathname === '/api/auth/login') {
      await handleAuthLogin(req, res);
      return;
    }

    if (method === 'POST' && pathname === '/api/auth/logout') {
      handleAuthLogout(req, res);
      return;
    }

    if (pathname.startsWith('/api/') && !isPublicApi(pathname, method)) {
      const authentication = authContext(req, url);
      if (!authentication) {
        sendJson(res, 401, { accepted: false, code: 'AUTH_REQUIRED', message: 'Authentication is required.' });
        return;
      }
      if (!roleCanAccess(authentication.role, pathname, method)) {
        sendJson(res, 403, { accepted: false, code: 'FORBIDDEN', message: 'Your role cannot access this operation.' });
        return;
      }
      req.auth = authentication;
    }

    if (method === 'GET' && pathname === '/api/auth/me') {
      handleAuthMe(req, res);
      return;
    }

    if (method === 'GET' && pathname === '/api/fingerprints/pending') {
      const db = loadDb();
      sendJson(res, 200, { pending: db.enrollmentRequests.filter((request) => request.status === 'PENDING_EMPLOYEE_DETAILS') });
      return;
    }

    if (method === 'GET' && pathname === '/api/settings') {
      handleGetSettings(res);
      return;
    }

    if (method === 'POST' && pathname === '/api/settings') {
      await handleUpdateSettings(res, await readBody(req));
      return;
    }

    if (method === 'GET' && pathname === '/api/dashboard/summary') {
      handleDashboardSummary(res);
      return;
    }

    if (method === 'GET' && pathname === '/api/readers') {
      handleReaders(res);
      return;
    }

    if (method === 'GET' && pathname === '/api/employees') {
      const db = loadDb();
      sendJson(res, 200, { employees: db.employees.map(safePublicEmployee) });
      return;
    }

    if (method === 'GET' && pathname === '/api/attendance') {
      const db = loadDb();
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 100)));
      sendJson(res, 200, { attendance: db.attendance.slice(0, limit) });
      return;
    }

    if (method === 'GET' && (pathname === '/api/time-card' || pathname === '/api/timecard')) {
      handleTimeCard(res, url);
      return;
    }

    if (method === 'GET' && (pathname === '/api/time-card/export/csv' || pathname === '/api/timecard/export/csv')) {
      handleTimeCardCsv(res, url);
      return;
    }

    if (method === 'GET' && (pathname === '/api/time-card/export/pdf' || pathname === '/api/timecard/export/pdf' || pathname === '/api/time-card/export/png' || pathname === '/api/timecard/export/png')) {
      handlePrintableTimeCard(res, url);
      return;
    }

    if (method === 'GET' && pathname === '/api/devices/display-command') {
      handleGetDisplayCommand(res, url);
      return;
    }

    if (method === 'GET' && pathname === '/api/export/db') {
      ensureDbFile();
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="gms-attendance-db.json"'
      });
      fs.createReadStream(DB_FILE).pipe(res);
      return;
    }

    if (method === 'GET' && pathname === '/api/audit') {
      await handleAuditLog(res, url);
      return;
    }

    if (method === 'POST' && pathname === '/api/readers/heartbeat') {
      await handleHeartbeat(req, res, await readBody(req));
      return;
    }

    if (method === 'POST' && pathname === '/api/fingerprints/scan-status') {
      await handleFingerprintScanStatus(res, await readBody(req));
      return;
    }

    if (method === 'POST' && pathname === '/api/devices/display-command') {
      await handleQueueDisplayCommand(res, await readBody(req));
      return;
    }

    if (method === 'POST' && pathname === '/api/devices/display-command/ack') {
      await handleDisplayCommandAck(res, await readBody(req));
      return;
    }

    if (method === 'POST' && pathname === '/api/fingerprints/start-enrollment') {
      await handleStartEnrollment(res, await readBody(req));
      return;
    }

    if (method === 'POST' && pathname === '/api/fingerprints/enrollment-request') {
      await handleEnrollmentRequest(req, res, await readBody(req));
      return;
    }

    if (method === 'POST' && pathname === '/api/attendance/scan') {
      await handleScan(req, res, await readBody(req));
      return;
    }

    if (method === 'POST' && pathname === '/api/employees') {
      await handleCreateEmployee(res, await readBody(req));
      return;
    }

    if (method === 'POST' && /^\/api\/employees\/[^/]+\/fingerprints$/.test(pathname)) {
      const employeeId = decodeURIComponent(pathname.split('/')[3]);
      await handleAddEmployeeFingerprint(res, employeeId, await readBody(req));
      return;
    }

    if (method === 'POST' && /^\/api\/employees\/[^/]+\/photo$/.test(pathname)) {
      const employeeId = decodeURIComponent(pathname.split('/')[3]);
      await handleEmployeePhotoUpload(res, employeeId, await readBody(req));
      return;
    }

    if (method === 'DELETE' && /^\/api\/employees\/[^/]+\/fingerprints\/[^/]+$/.test(pathname)) {
      const parts = pathname.split('/');
      const employeeId = decodeURIComponent(parts[3]);
      const fingerprintId = decodeURIComponent(parts[5]);
      await handleDeleteEmployeeFingerprint(res, employeeId, fingerprintId);
      return;
    }

    if (method === 'DELETE' && /^\/api\/fingerprints\/pending\/[^/]+$/.test(pathname)) {
      const requestId = decodeURIComponent(pathname.replace('/api/fingerprints/pending/', ''));
      await handleDeletePendingEnrollment(res, requestId);
      return;
    }

    if (method === 'POST' && (pathname === '/api/time-card/manual-status' || pathname === '/api/timecard/manual-status')) {
      await handleManualStatus(res, await readBody(req));
      return;
    }

    if (method === 'POST' && pathname === '/api/admin/emergency-attendance') {
      await handleEmergencyAttendance(res, await readBody(req));
      return;
    }

    if (method === 'POST' && pathname === '/api/attendance/review') {
      await handleAttendanceReview(res, await readBody(req));
      return;
    }

    if (method === 'PATCH' && pathname.startsWith('/api/employees/')) {
      const employeeId = decodeURIComponent(pathname.replace('/api/employees/', ''));
      await handleUpdateEmployee(res, employeeId, await readBody(req));
      return;
    }

    if (method === 'POST' && pathname === '/api/testing/clear-attendance') {
      if (!ENABLE_TEST_ENDPOINTS) {
        sendJson(res, 404, { code: 'NOT_FOUND', message: 'Route not found.' });
        return;
      }
      const db = loadDb();
      const deleted = db.attendance.length;
      db.attendance = [];
      saveDb(db);
      sendJson(res, 200, { ok: true, deleted });
      return;
    }

    if (method === 'POST' && pathname === '/api/testing/clear-pending') {
      if (!ENABLE_TEST_ENDPOINTS) {
        sendJson(res, 404, { code: 'NOT_FOUND', message: 'Route not found.' });
        return;
      }
      const db = loadDb();
      const deleted = db.enrollmentRequests.length;
      db.enrollmentRequests = [];
      saveDb(db);
      sendJson(res, 200, { ok: true, deleted });
      return;
    }

    if (method === 'GET' && routeStatic(req, res, pathname)) return;

    sendJson(res, 404, { code: 'NOT_FOUND', message: 'Route not found.' });
  } catch (error) {
    console.error(error);
    const statusCode = Number(error.statusCode || 500);
    sendJson(res, statusCode, {
      code: statusCode === 400 ? 'INVALID_JSON' : statusCode === 413 ? 'PAYLOAD_TOO_LARGE' : 'SERVER_ERROR',
      message: statusCode < 500 ? error.message : 'Server error.',
      ...(!IS_PRODUCTION && statusCode >= 500 ? { detail: error.message } : {})
    });
  }
}

const server = http.createServer(handleRequest);

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. The server may already be running at http://localhost:${PORT}.`);
    console.error('Close the existing server first, or start this one with a different PORT value.');
    process.exit(1);
  }

  throw error;
});

async function startServer() {
  if (!API_KEY || API_KEY.length < 16 || API_KEY === 'change-this-api-key') {
    throw new Error('API_KEY must be configured in .env with at least 16 characters.');
  }
  if (CLOUD_MODE && !process.env.DATABASE_URL) {
    throw new Error('CLOUD_MODE requires DATABASE_URL; ephemeral JSON/SQLite storage is not allowed.');
  }
  const localState = CLOUD_MODE
    ? migrateDb(emptyDb())
    : loadDb();
  const initialized = await storage.initialize(localState);
  if (initialized.state) saveDb(migrateDb(initialized.state));

  server.listen(PORT, '0.0.0.0', () => {
    const storageStatus = storage.getStatus();
    console.log('=========================================');
    console.log('GMS Attendance Server with Time Card');
    console.log(`Local:   http://localhost:${PORT}`);
    console.log(`Network: http://YOUR-PC-IP:${PORT}`);
    console.log('API key: configured (hidden)');
    console.log(`Timezone: ${DEVICE_TIMEZONE}`);
    console.log(`Primary storage: ${storageStatus.activePrimary}`);
    console.log(`PostgreSQL: ${storageStatus.postgresql}`);
    console.log(`SQLite backup: ${storageStatus.sqliteBackup}`);
    if (!EMERGENCY_ATTENDANCE_PASSWORD) console.warn('Emergency attendance is disabled until EMERGENCY_ATTENDANCE_PASSWORD is configured.');
    console.log('=========================================');
  });
}

async function shutdown() {
  await storage.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

if (require.main === module) {
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [token, session] of sessions) if (session.expiresAt <= now) sessions.delete(token);
    for (const [key, bucket] of rateBuckets) if (bucket.resetAt <= now) rateBuckets.delete(key);
  }, 10 * 60 * 1000);
  cleanupTimer.unref();

  startServer().catch((error) => {
    console.error('Server startup failed:', error.message);
    process.exit(1);
  });
}

module.exports = {
  safeEqual,
  cleanDisplayText,
  normalizeDeviceId,
  isPublicApi,
  deviceRoute,
  roleCanAccess,
  isRecordedAttendanceLog,
  normalizeSettings,
  consumeRateLimit,
  securityHeaders
};
