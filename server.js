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
const APP_BASE_URL = String(process.env.APP_BASE_URL || '').replace(/\/$/, '');
const GOOGLE_OAUTH_CLIENT_ID = String(process.env.GOOGLE_OAUTH_CLIENT_ID || '').trim();
const GOOGLE_OAUTH_CLIENT_SECRET = String(process.env.GOOGLE_OAUTH_CLIENT_SECRET || '').trim();
const FACEBOOK_OAUTH_CLIENT_ID = String(process.env.FACEBOOK_OAUTH_CLIENT_ID || '').trim();
const FACEBOOK_OAUTH_CLIENT_SECRET = String(process.env.FACEBOOK_OAUTH_CLIENT_SECRET || '').trim();
const FIREBASE_WEB_API_KEY = String(process.env.FIREBASE_WEB_API_KEY || 'AIzaSyA10KnHTBE4pxZLK7nMHwSaRSWeiK4cegU').trim();
const FIREBASE_PROJECT_ID = String(process.env.FIREBASE_PROJECT_ID || 'cloud-attendance-3553a').trim();
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
const EMPLOYEE_ACCOUNTS = String(process.env.EMPLOYEE_ACCOUNTS || '').split(',').map((entry) => {
  const [username, password, employeeId] = entry.split('|').map((value) => String(value || '').trim());
  return username && password && employeeId ? { role: 'employee', username, password, employeeId } : null;
}).filter(Boolean);
const DEVICE_API_KEYS = new Map(String(process.env.DEVICE_API_KEYS || '').split(',').map((entry) => {
  const separator = entry.indexOf(':');
  return separator > 0 ? [entry.slice(0, separator).trim(), entry.slice(separator + 1).trim()] : ['', ''];
}).filter(([deviceId, key]) => deviceId && key));
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean);
const SCHEMA_VERSION = 8;
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

const sessions = new Map();
const rateBuckets = new Map();
const passwordResetTokens = new Map();
const facebookPhotoSyncAt = new Map();
let cloudDb = null;

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
    departments: [],
    designations: [],
    leaveRequests: [],
    correctionRequests: [],
    notifications: [],
    employeeAccounts: [],
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

function removeEmployeeFingerprintMapping(employee, fingerprintId) {
  const id = parseFingerprintId(fingerprintId);
  if (!id) return false;
  normalizeEmployeeFingerprints(employee);
  const before = employee.fingerprints.length;
  employee.fingerprints = employee.fingerprints.filter((fingerprint) => Number(fingerprint.fingerprintId) !== id);
  if (employee.fingerprints.length === before) return false;
  if (Number(employee.fingerprintId) === id) employee.fingerprintId = null;
  const remaining = employee.fingerprints.filter((fingerprint) => fingerprint.active !== false);
  employee.fingerprintId = remaining.length ? remaining[0].fingerprintId : null;
  return true;
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
  db.departments = Array.isArray(db.departments) ? db.departments : [];
  db.designations = Array.isArray(db.designations) ? db.designations : [];
  db.leaveRequests = Array.isArray(db.leaveRequests) ? db.leaveRequests : [];
  db.correctionRequests = Array.isArray(db.correctionRequests) ? db.correctionRequests : [];
  db.notifications = Array.isArray(db.notifications) ? db.notifications : [];
  db.employeeAccounts = Array.isArray(db.employeeAccounts) ? db.employeeAccounts : [];
  db.employeeAccounts = db.employeeAccounts.filter((account) => account && account.username && account.passwordHash && account.passwordSalt).map((account) => ({
    id: account.id || createId('account'),
    role: ['admin', 'hr', 'employee'].includes(String(account.role || 'employee').toLowerCase()) ? String(account.role || 'employee').toLowerCase() : 'employee',
    employeeId: String(account.employeeId || ''),
    username: String(account.username).trim().toLowerCase(),
    phone: normalizeAccountPhone(account.phone || db.employees.find((employee) => employee.id === account.employeeId)?.phone || ''),
    passwordHash: String(account.passwordHash),
    passwordSalt: String(account.passwordSalt),
    socialIdentities: account.socialIdentities && typeof account.socialIdentities === 'object' ? account.socialIdentities : {},
    active: account.active !== false,
    createdAt: account.createdAt || nowIso(),
    updatedAt: account.updatedAt || nowIso()
  }));
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
  if (CLOUD_MODE && cloudDb) {
    return migrateDb(JSON.parse(JSON.stringify(cloudDb)));
  }

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
  if (CLOUD_MODE) {
    cloudDb = JSON.parse(JSON.stringify(db));
  } else {
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
  const socialImageSources = 'https://lh3.googleusercontent.com https://platform-lookaside.fbsbx.com https://graph.facebook.com https://*.fbcdn.net';
  return {
    ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
    'Content-Security-Policy': `default-src 'self'; img-src ${imageSources} ${socialImageSources}; media-src 'self'; frame-src 'self' https://cloud-attendance-3553a.firebaseapp.com https://apis.google.com https://accounts.google.com https://www.google.com https://www.recaptcha.net; style-src 'self' 'unsafe-inline'; script-src 'self' https://www.gstatic.com https://apis.google.com https://www.google.com https://www.recaptcha.net; connect-src 'self' https://www.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://cloud-attendance-3553a.firebaseapp.com https://apis.google.com https://accounts.google.com https://www.google.com https://www.recaptcha.net`,
    'Referrer-Policy': 'strict-origin-when-cross-origin',
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

const staticFileCache = new Map();

function sendFile(req, res, filePath, contentType) {
  const serve = (data) => {
    const etag = `"${crypto.createHash('sha256').update(data).digest('base64url').slice(0, 24)}"`;
    const isHtml = contentType.startsWith('text/html');
    const cacheControl = isHtml
      ? 'private, max-age=300, must-revalidate'
      : 'public, max-age=3600, must-revalidate';
    if (String(getHeader(req, 'if-none-match') || '') === etag) {
      res.writeHead(304, { ...securityHeaders(req), 'Cache-Control': cacheControl, ETag: etag });
      res.end();
      return;
    }
    const headers = {
      ...securityHeaders(req),
      'Cache-Control': cacheControl,
      ETag: etag,
      'Content-Type': contentType
    };
    let body = data;
    if (isHtml) {
      const nonce = crypto.randomBytes(18).toString('base64');
      body = Buffer.from(data.toString('utf8').replace(/<script(?![^>]*\bnonce=)/gi, `<script nonce="${nonce}"`));
      const imageSources = `'self' data:${SUPABASE_IMAGE_ORIGIN ? ` ${SUPABASE_IMAGE_ORIGIN}` : ''}`;
      const socialImageSources = 'https://lh3.googleusercontent.com https://platform-lookaside.fbsbx.com https://graph.facebook.com https://*.fbcdn.net';
      headers['Content-Security-Policy'] = `default-src 'self'; img-src ${imageSources} ${socialImageSources}; media-src 'self'; frame-src 'self' https://cloud-attendance-3553a.firebaseapp.com https://apis.google.com https://accounts.google.com https://www.google.com https://www.recaptcha.net; style-src 'self' 'unsafe-inline'; script-src 'self' 'nonce-${nonce}' https://www.gstatic.com https://apis.google.com https://www.google.com https://www.recaptcha.net; connect-src 'self' https://www.googleapis.com https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://cloud-attendance-3553a.firebaseapp.com https://apis.google.com https://accounts.google.com https://www.google.com https://www.recaptcha.net`;
    }
    res.writeHead(200, headers);
    res.end(body);
  };

  const cached = staticFileCache.get(filePath);
  if (cached) {
    serve(cached);
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendJson(res, 404, { code: 'NOT_FOUND', message: 'File not found.' });
      return;
    }
    staticFileCache.set(filePath, data);
    serve(data);
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

function createOauthState(provider, values, secret, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    provider,
    accountId: values?.accountId || '',
    mode: values?.mode === 'reset' ? 'reset' : 'login',
    expiresAt: now + 10 * 60 * 1000,
    nonce: crypto.randomBytes(16).toString('base64url')
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', String(secret || '')).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function readOauthState(state, provider, secret, now = Date.now()) {
  const [payload, signature, extra] = String(state || '').split('.');
  if (!payload || !signature || extra || !secret) return null;
  const expected = crypto.createHmac('sha256', String(secret)).update(payload).digest('base64url');
  if (!safeEqual(signature, expected)) return null;
  try {
    const saved = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (saved.version !== 1 || saved.provider !== provider || saved.expiresAt < now) return null;
    if (!['login', 'reset'].includes(saved.mode)) return null;
    return saved;
  } catch {
    return null;
  }
}

function hashAccountPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { passwordSalt: salt, passwordHash: crypto.scryptSync(String(password), salt, 64).toString('hex') };
}

function verifyAccountPassword(password, account) {
  if (!account?.passwordHash || !account?.passwordSalt) return false;
  return safeEqual(crypto.scryptSync(String(password), account.passwordSalt, 64).toString('hex'), account.passwordHash);
}

function hasActiveLoginUsername(username) {
  const normalized = String(username || '').trim().toLowerCase();
  if (!normalized) return false;
  const configuredAccount = [...ROLE_CREDENTIALS, ...EMPLOYEE_ACCOUNTS].some((item) => safeEqual(normalized, String(item.username).toLowerCase()));
  if (configuredAccount) return true;
  return loadDb().employeeAccounts.some((item) => item.active !== false && safeEqual(normalized, String(item.username || '').toLowerCase()));
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
  if (pathname === '/api/auth/phone' && method === 'PATCH') return ['admin', 'hr', 'employee'].includes(role);
  if (role === 'admin') return true;
  if (pathname.startsWith('/api/employee-accounts')) return false;
  if (role === 'device') return deviceRoute(pathname, method);
  if (role === 'viewer') return method === 'GET' && !['/api/export/db', '/api/audit'].includes(pathname);
  if (role === 'employee') return pathname.startsWith('/api/employee/') && ['GET', 'POST', 'PATCH'].includes(method);
  if (role === 'hr') {
    if (method === 'GET') return pathname !== '/api/export/db';
    return pathname.startsWith('/api/employees') || pathname.startsWith('/api/fingerprints') ||
      pathname.startsWith('/api/time-card') || pathname.startsWith('/api/timecard') ||
      pathname === '/api/attendance/review' || pathname === '/api/admin/emergency-attendance' ||
      pathname.startsWith('/api/departments') || pathname.startsWith('/api/designations') ||
      pathname.startsWith('/api/leave-requests') || pathname.startsWith('/api/correction-requests') ||
      pathname.startsWith('/api/notifications');
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
    email: employee.email || '',
    phone: employee.phone || '',
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

function normalizeAccountPhone(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let digits = raw.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return '';
  if (digits.length === 11 && digits.startsWith('09')) digits = `63${digits.slice(1)}`;
  else if (digits.length === 10 && digits.startsWith('9')) digits = `63${digits}`;
  return `+${digits}`;
}

function shouldRateLimitRequest(pathname, method) {
  return String(pathname || '').startsWith('/api/') && String(method || '').toUpperCase() !== 'OPTIONS';
}

function roleHomePath(role) {
  if (role === 'employee') return '/employee';
  if (role === 'hr') return '/hr';
  return '/dashboard';
}

function createBrowserSession(req, res, account) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS, ip: requestIp(req), role: account.role, username: account.username, employeeId: account.employeeId || '' });
  const secure = String(getHeader(req, 'x-forwarded-proto') || '').toLowerCase() === 'https';
  res.setHeader('Set-Cookie', `gms_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`);
}

async function handlePasswordResetRequest(res, body) {
  const loginId = cleanDisplayText(body.username || '', 120);
  const username = loginId.toLowerCase();
  const phone = normalizeAccountPhone(loginId);
  if (!username) return sendJson(res, 400, { code: 'USERNAME_REQUIRED', message: 'Enter the username or bound phone number for the account.' });
  const db = loadDb();
  const account = db.employeeAccounts.find((item) => item.active !== false && (item.username === username || (phone && normalizeAccountPhone(item.phone) === phone)));
  if (account) {
    const employee = requireEmployee(db, account.employeeId);
    createNotification(db, { employeeId: account.employeeId, type: 'SECURITY', title: 'Password reset requested', message: `${employee?.fullName || username} requested a password reset for ${username}. HR or an administrator must update the account credentials.` });
    saveDb(db);
  }
  sendJson(res, 200, { ok: true, message: 'If the account exists, HR or an administrator has been notified.' });
}

function verifyActorPassword(actor, password, db = loadDb()) {
  const username = String(actor?.username || '').trim().toLowerCase();
  const candidate = String(password || '');
  if (!username || !candidate) return false;
  const configured = [...ROLE_CREDENTIALS, ...EMPLOYEE_ACCOUNTS]
    .find((item) => safeEqual(username, String(item.username || '').trim().toLowerCase()));
  if (configured && safeEqual(candidate, String(configured.password || ''))) return true;
  const account = db.employeeAccounts.find((item) => item.active !== false && safeEqual(username, item.username));
  return Boolean(account && verifyAccountPassword(candidate, account));
}

async function handleVerifiedPasswordReset(res, body) {
  const idToken = String(body.idToken || '');
  const resetToken = String(body.resetToken || '');
  const newPassword = String(body.newPassword || '');
  if (!idToken && !resetToken) return sendJson(res, 400, { code: 'VERIFICATION_REQUIRED', message: 'Phone, Google, or Facebook verification is required.' });
  if (newPassword.length < 8) return sendJson(res, 400, { code: 'WEAK_PASSWORD', message: 'New password must contain at least 8 characters.' });
  try {
    const db = loadDb();
    let account;
    let verifiedWith = 'phone';
    if (resetToken) {
      const saved = passwordResetTokens.get(resetToken); passwordResetTokens.delete(resetToken);
      if (!saved || saved.expiresAt < Date.now()) throw new Error('Social verification expired. Verify the account again.');
      account = db.employeeAccounts.find((item) => item.active !== false && item.id === saved.accountId);
      verifiedWith = saved.provider;
    } else {
      const verification = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(FIREBASE_WEB_API_KEY)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) });
      const verified = await verification.json(); const user = verified.users?.[0]; const verifiedPhone = normalizeAccountPhone(user?.phoneNumber || '');
      if (!verification.ok || !user || !verifiedPhone) throw new Error('Firebase phone verification is invalid or expired.');
      account = db.employeeAccounts.find((item) => item.active !== false && safeEqual(normalizeAccountPhone(item.phone), verifiedPhone));
    }
    if (!account) return sendJson(res, 404, { code: 'ACCOUNT_NOT_LINKED', message: `This verified ${verifiedWith} account is not bound to an active account.` });
    Object.assign(account, hashAccountPassword(newPassword), { updatedAt: nowIso() });
    const employee = requireEmployee(db, account.employeeId);
    createNotification(db, { employeeId: account.employeeId, type: 'SECURITY', title: 'Password changed', message: `${employee?.fullName || account.username} changed the account password after ${verifiedWith} verification.` });
    saveDb(db);
    sendJson(res, 200, { ok: true, message: 'Password changed successfully. You can now sign in.' });
  } catch (error) {
    sendJson(res, 401, { code: 'VERIFICATION_INVALID', message: error.message || 'Phone verification failed.' });
  }
}

function oauthConfig(provider) {
  if (provider === 'google') return GOOGLE_OAUTH_CLIENT_ID && GOOGLE_OAUTH_CLIENT_SECRET ? { clientId: GOOGLE_OAUTH_CLIENT_ID, secret: GOOGLE_OAUTH_CLIENT_SECRET, authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', profile: 'https://openidconnect.googleapis.com/v1/userinfo', scope: 'openid email profile' } : null;
  if (provider === 'facebook') return FACEBOOK_OAUTH_CLIENT_ID && FACEBOOK_OAUTH_CLIENT_SECRET ? { clientId: FACEBOOK_OAUTH_CLIENT_ID, secret: FACEBOOK_OAUTH_CLIENT_SECRET, authorize: 'https://www.facebook.com/v23.0/dialog/oauth', token: 'https://graph.facebook.com/v23.0/oauth/access_token', profile: 'https://graph.facebook.com/me?fields=id,name,email,picture.width(512).height(512)', scope: 'email,public_profile' } : null;
  return null;
}

function socialProfilePhotoUrl(provider, profile) {
  if (provider !== 'facebook') return '';
  const candidate = String(profile?.picture?.data?.url || profile?.photoUrl || '').trim();
  if (!candidate) return '';
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' ? url.toString() : '';
  } catch { return ''; }
}

function syncFacebookEmployeePhoto(db, account, photoUrl) {
  if (!photoUrl || !account?.employeeId) return false;
  const employee = db.employees.find((item) => item.id === account.employeeId);
  if (!employee || employee.photoUrl === photoUrl) return false;
  employee.photoUrl = photoUrl;
  employee.updatedAt = nowIso();
  return true;
}

async function refreshBoundFacebookPhoto(employeeId) {
  if (!FACEBOOK_OAUTH_CLIENT_ID || !FACEBOOK_OAUTH_CLIENT_SECRET || !employeeId) return false;
  const db = loadDb();
  const account = db.employeeAccounts.find((item) => item.active !== false && item.employeeId === employeeId && item.socialIdentities?.facebook?.id);
  if (!account) return false;
  const cacheKey = account.id || employeeId;
  if (Number(facebookPhotoSyncAt.get(cacheKey) || 0) > Date.now()) return false;
  facebookPhotoSyncAt.set(cacheKey, Date.now() + 15 * 60 * 1000);
  try {
    const profileUrl = new URL(`https://graph.facebook.com/v23.0/${encodeURIComponent(account.socialIdentities.facebook.id)}`);
    profileUrl.searchParams.set('fields', 'picture.width(512).height(512)');
    profileUrl.searchParams.set('access_token', `${FACEBOOK_OAUTH_CLIENT_ID}|${FACEBOOK_OAUTH_CLIENT_SECRET}`);
    const response = await fetch(profileUrl, { headers: { Accept: 'application/json' } });
    const profile = await response.json();
    if (!response.ok) throw new Error('Facebook profile refresh failed.');
    const photoUrl = socialProfilePhotoUrl('facebook', profile);
    if (!photoUrl) return false;
    const freshDb = loadDb();
    const freshAccount = freshDb.employeeAccounts.find((item) => item.id === account.id);
    if (!freshAccount) return false;
    freshAccount.socialIdentities = freshAccount.socialIdentities || {};
    freshAccount.socialIdentities.facebook = { ...(freshAccount.socialIdentities.facebook || {}), photoUrl, photoSyncedAt: nowIso() };
    const changed = syncFacebookEmployeePhoto(freshDb, freshAccount, photoUrl);
    if (changed || freshAccount.socialIdentities.facebook.photoUrl === photoUrl) saveDb(freshDb);
    return changed;
  } catch {
    facebookPhotoSyncAt.set(cacheKey, Date.now() + 2 * 60 * 1000);
    return false;
  }
}

async function refreshAllBoundFacebookPhotos() {
  const db = loadDb();
  const employeeIds = db.employeeAccounts
    .filter((item) => item.active !== false && item.employeeId && item.socialIdentities?.facebook?.id)
    .map((item) => item.employeeId);
  await Promise.all(employeeIds.map((employeeId) => refreshBoundFacebookPhoto(employeeId)));
}

function oauthCallbackUrl(req, provider) {
  const origin = APP_BASE_URL || `${String(getHeader(req, 'x-forwarded-proto') || 'http').split(',')[0]}://${req.headers.host}`;
  return `${origin}/api/auth/oauth/${provider}/callback`;
}

function handleOauthStart(req, res, url, provider) {
  const config = oauthConfig(provider);
  if (!config) {
    const session = validSession(req);
    const destination = session ? roleHomePath(session.role || 'employee') : '/';
    const message = `${provider[0].toUpperCase() + provider.slice(1)} sign-in is not configured. Add its OAuth client ID and secret, then restart the server.`;
    return send(res, 302, '', { Location: `${destination}?authError=${encodeURIComponent(message)}` });
  }
  const session = validSession(req);
  const db = loadDb();
  const account = session
    ? db.employeeAccounts.find((item) => item.active !== false && item.username === session.username)
    : null;
  const state = createOauthState(provider, {
    accountId: account?.id || '',
    mode: url.searchParams.get('mode') === 'reset' ? 'reset' : 'login'
  }, config.secret);
  const target = new URL(config.authorize);
  target.searchParams.set('client_id', config.clientId); target.searchParams.set('redirect_uri', oauthCallbackUrl(req, provider));
  target.searchParams.set('response_type', 'code'); target.searchParams.set('scope', config.scope); target.searchParams.set('state', state);
  send(res, 302, '', { Location: target.toString() });
}

async function handleOauthCallback(req, res, url, provider) {
  const config = oauthConfig(provider); const code = url.searchParams.get('code');
  const saved = readOauthState(url.searchParams.get('state'), provider, config?.secret);
  if (!saved) return send(res, 302, '', { Location: '/?authError=OAuth%20request%20expired' });
  if (!config || !code) return send(res, 302, '', { Location: '/?authError=OAuth%20authorization%20was%20cancelled' });
  try {
    const tokenUrl = new URL(config.token); const params = new URLSearchParams({ client_id: config.clientId, client_secret: config.secret, redirect_uri: oauthCallbackUrl(req, provider), code, grant_type: 'authorization_code' });
    const tokenResponse = provider === 'google' ? await fetch(tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params }) : await fetch(`${tokenUrl}?${params}`);
    const token = await tokenResponse.json();
    if (!tokenResponse.ok || !token.access_token) {
      const reason = cleanDisplayText(token.error_description || token.error?.message || token.error || `HTTP ${tokenResponse.status}`, 180);
      throw new Error(`Token exchange rejected: ${reason}`);
    }
    const profileUrl = new URL(config.profile); if (provider === 'facebook') profileUrl.searchParams.set('access_token', token.access_token);
    const profileResponse = await fetch(profileUrl, provider === 'google' ? { headers: { Authorization: `Bearer ${token.access_token}` } } : {}); const profile = await profileResponse.json();
    if (!profileResponse.ok || !(profile.sub || profile.id)) {
      const reason = cleanDisplayText(profile.error?.message || profile.error || `HTTP ${profileResponse.status}`, 180);
      throw new Error(`Profile request rejected: ${reason}`);
    }
    const email = String(profile.email || '').trim().toLowerCase(); const providerId = String(profile.sub || profile.id || ''); const db = loadDb();
    let dbAccount = saved.accountId
      ? db.employeeAccounts.find((item) => item.active !== false && item.id === saved.accountId)
      : db.employeeAccounts.find((item) => item.active !== false && item.socialIdentities?.[provider]?.id === providerId);
    if (!dbAccount) return send(res, 302, '', { Location: '/?authError=No%20linked%20managed%20account%20was%20found' });
    if (saved.mode === 'reset') {
      const resetToken = crypto.randomBytes(32).toString('base64url');
      passwordResetTokens.set(resetToken, { accountId: dbAccount.id, provider, expiresAt: Date.now() + 10 * 60 * 1000 });
      return send(res, 302, '', { Location: `/?resetToken=${encodeURIComponent(resetToken)}&resetProvider=${encodeURIComponent(provider)}` });
    }
    if (saved.accountId) {
      const duplicate = db.employeeAccounts.find((item) => item.id !== dbAccount.id && item.socialIdentities?.[provider]?.id === providerId);
      if (duplicate) return send(res, 302, '', { Location: `${roleHomePath(dbAccount.role)}?authError=${encodeURIComponent(`This ${provider} account is already connected to another managed account`)}` });
      dbAccount.socialIdentities = dbAccount.socialIdentities || {};
      const photoUrl = socialProfilePhotoUrl(provider, profile);
      dbAccount.socialIdentities[provider] = { id: providerId, email, name: cleanDisplayText(profile.name || '', 100), photoUrl, linkedAt: nowIso() };
      dbAccount.updatedAt = nowIso(); saveDb(db);
    }
    const facebookPhotoUrl = socialProfilePhotoUrl(provider, profile);
    if (syncFacebookEmployeePhoto(db, dbAccount, facebookPhotoUrl)) saveDb(db);
    createBrowserSession(req, res, { role: dbAccount.role || 'employee', username: dbAccount.username, employeeId: dbAccount.employeeId || '' });
    return send(res, 302, '', { Location: `${roleHomePath(dbAccount.role || 'employee')}?authSuccess=${encodeURIComponent(`${provider[0].toUpperCase() + provider.slice(1)} account connected`)}` });
  } catch (error) {
    const detail = cleanDisplayText(error?.message || 'Provider request failed', 200);
    console.error(`[OAUTH] ${provider} sign-in failed: ${detail}`);
    return send(res, 302, '', { Location: `/?authError=${encodeURIComponent(`${provider[0].toUpperCase() + provider.slice(1)} sign-in failed: ${detail}`)}` });
  }
}

function normalizeWorkflowStatus(value, allowed, fallback = 'PENDING') {
  const status = upperDisplayText(value || fallback, 24);
  return allowed.includes(status) ? status : fallback;
}

function requireEmployee(db, employeeId) {
  return db.employees.find((employee) => employee.id === String(employeeId || '')) || null;
}

function createNotification(db, input) {
  const notification = {
    id: createId('notification'), employeeId: String(input.employeeId || ''),
    title: cleanDisplayText(input.title || 'Attendance update', 80),
    message: cleanDisplayText(input.message || '', 240),
    type: upperDisplayText(input.type || 'INFO', 24), readAt: null, createdAt: nowIso()
  };
  db.notifications.unshift(notification);
  return notification;
}

async function handleCreateDirectoryRecord(res, collection, body) {
  const db = loadDb();
  const name = normalizeName(body.name);
  if (!name) return sendJson(res, 400, { code: 'NAME_REQUIRED', message: 'Name is required.' });
  if (db[collection].some((item) => item.name.toLowerCase() === name.toLowerCase())) return sendJson(res, 409, { code: 'DUPLICATE_NAME', message: `${name} already exists.` });
  const prefix = collection === 'departments' ? 'department' : 'designation';
  const record = { id: createId(prefix), name, description: cleanDisplayText(body.description || '', 160), active: body.active !== false, createdAt: nowIso(), updatedAt: nowIso() };
  db[collection].push(record); saveDb(db);
  sendJson(res, 201, { [prefix]: record });
}

async function handleCreateLeaveRequest(res, body, actor) {
  const db = loadDb(); const employee = requireEmployee(db, body.employeeId);
  const fromDate = String(body.fromDate || ''); const toDate = String(body.toDate || '');
  if (!employee) return sendJson(res, 404, { code: 'EMPLOYEE_NOT_FOUND', message: 'Employee was not found.' });
  if (!dateKeyToUtcDate(fromDate) || !dateKeyToUtcDate(toDate) || fromDate > toDate) return sendJson(res, 400, { code: 'INVALID_DATE_RANGE', message: 'Enter a valid leave date range.' });
  const request = { id: createId('leave'), employeeId: employee.id, employeeName: employee.fullName, leaveType: upperDisplayText(body.leaveType || 'VACATION', 32), fromDate, toDate, reason: cleanDisplayText(body.reason || '', 240), status: 'PENDING', requestedBy: actor.username, reviewedBy: '', reviewedAt: null, createdAt: nowIso(), updatedAt: nowIso() };
  db.leaveRequests.unshift(request); createNotification(db, { employeeId: employee.id, type: 'LEAVE', title: 'Leave request submitted', message: `${fromDate} to ${toDate} is pending review.` }); saveDb(db);
  sendJson(res, 201, { leaveRequest: request });
}

async function handleCreateCorrectionRequest(res, body, actor) {
  const db = loadDb(); const employee = requireEmployee(db, body.employeeId); const dateKey = String(body.dateKey || '');
  if (!employee) return sendJson(res, 404, { code: 'EMPLOYEE_NOT_FOUND', message: 'Employee was not found.' });
  if (!dateKeyToUtcDate(dateKey)) return sendJson(res, 400, { code: 'INVALID_DATE', message: 'Enter a valid attendance date.' });
  const request = { id: createId('correction'), employeeId: employee.id, employeeName: employee.fullName, dateKey, requestedTimeIn: validTimeText(body.requestedTimeIn, ''), requestedTimeOut: validTimeText(body.requestedTimeOut, ''), reason: cleanDisplayText(body.reason || '', 240), status: 'PENDING', requestedBy: actor.username, reviewedBy: '', reviewedAt: null, createdAt: nowIso(), updatedAt: nowIso() };
  db.correctionRequests.unshift(request); createNotification(db, { employeeId: employee.id, type: 'CORRECTION', title: 'Correction request submitted', message: `${dateKey} is pending review.` }); saveDb(db);
  sendJson(res, 201, { correctionRequest: request });
}

async function handleReviewWorkflow(res, collection, requestId, body, actor) {
  const db = loadDb(); const request = db[collection].find((item) => item.id === requestId);
  if (!request) return sendJson(res, 404, { code: 'REQUEST_NOT_FOUND', message: 'Request was not found.' });
  const status = normalizeWorkflowStatus(body.status, ['APPROVED', 'REJECTED'], '');
  if (!status) return sendJson(res, 400, { code: 'INVALID_STATUS', message: 'Status must be APPROVED or REJECTED.' });
  request.status = status; request.reviewRemarks = cleanDisplayText(body.remarks || '', 240); request.reviewedBy = actor.username; request.reviewedAt = nowIso(); request.updatedAt = request.reviewedAt;
  const label = collection === 'leaveRequests' ? 'Leave' : 'Correction';
  createNotification(db, { employeeId: request.employeeId, type: label.toUpperCase(), title: `${label} request ${status.toLowerCase()}`, message: request.reviewRemarks || `Your request is now ${status.toLowerCase()}.` }); saveDb(db);
  sendJson(res, 200, { request });
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
  const email = String(body.email ?? existing?.email ?? '').trim().toLowerCase();
  const phone = String(body.phone ?? existing?.phone ?? '').trim().replace(/\s+/g, ' ');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: { status: 400, code: 'INVALID_EMAIL', message: 'Enter a valid employee email address.' } };
  if (phone && !/^\+?[0-9 ()-]{7,20}$/.test(phone)) return { error: { status: 400, code: 'INVALID_PHONE', message: 'Enter a valid phone number.' } };

  const graceMinutes = Math.max(0, Number(body.graceMinutes ?? settings.graceMinutes));
  const weeklySchedule = normalizeWeeklySchedule(body.weeklySchedule, body.shiftStart || settings.defaultShiftStart, body.shiftEnd || settings.defaultShiftEnd);

  return {
    fullName,
    email,
    phone,
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
    email: payload.email,
    phone: payload.phone,
    photoUrl: '',
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
  employee.email = payload.email;
  employee.phone = payload.phone;
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

  if (!removeEmployeeFingerprintMapping(employee, fingerprintId)) {
    sendJson(res, 404, { code: 'FINGERPRINT_NOT_FOUND', message: 'Fingerprint not found on employee.' });
    return;
  }
  employee.updatedAt = nowIso();

  for (const request of db.enrollmentRequests) {
    if (Number(request.fingerprintId) === fingerprintId && request.status === 'PENDING_EMPLOYEE_DETAILS') {
      request.status = 'CANCELED';
      request.canceledAt = nowIso();
      request.message = 'Fingerprint removed from employee and device.';
    }
  }

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

function buildPortalPayload(session, url) {
  const db = loadDb();
  const employee = requireEmployee(db, session.employeeId);
  if (!employee || employee.active === false) return null;
  const today = localDateKey(new Date());
  const fromKey = url.searchParams.get('from') || dateKeyFromUtcDate(addDaysUtc(dateKeyToUtcDate(today), -30));
  const toKey = url.searchParams.get('to') || today;
  let fromDate = dateKeyToUtcDate(fromKey); let toDate = dateKeyToUtcDate(toKey);
  if (!fromDate || !toDate) { fromDate = dateKeyToUtcDate(today); toDate = fromDate; }
  if (fromDate > toDate) [fromDate, toDate] = [toDate, fromDate];
  const timeCards = [];
  for (let d = fromDate; d <= toDate; d = addDaysUtc(d, 1)) timeCards.push(buildTimeCardRecord(employee, dateKeyFromUtcDate(d), db.attendance, db.manualStatuses, db.settings));
  const summary = timeCards.reduce((out, row) => {
    out.present += /PRESENT|LATE/.test(row.status || '') ? 1 : 0; out.lateMinutes += Number(row.lateMinutes || 0); out.undertimeMinutes += Number(row.earlyOutMinutes || 0); out.overtimeMinutes += Number(row.overtimeMinutes || 0); return out;
  }, { present: 0, lateMinutes: 0, undertimeMinutes: 0, overtimeMinutes: 0 });
  const account = db.employeeAccounts.find((item) => item.employeeId === employee.id);
  return { employee: safePublicEmployee(employee), timeCards: timeCards.reverse(), summary, leaveRequests: db.leaveRequests.filter((item) => item.employeeId === employee.id), correctionRequests: db.correctionRequests.filter((item) => item.employeeId === employee.id), notifications: db.notifications.filter((item) => !item.employeeId || item.employeeId === employee.id).slice(0, 100), accountPhone: account?.phone || '', socialConnections: { phone: Boolean(account?.phone), google: Boolean(account?.socialIdentities?.google?.id), facebook: Boolean(account?.socialIdentities?.facebook?.id) }, settings: { branchName: db.settings.branchName } };
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

async function handleEditAttendanceRecord(res, recordId, body, actor) {
  if (!EMERGENCY_ATTENDANCE_PASSWORD || !safeEqual(String(body.password || ''), EMERGENCY_ATTENDANCE_PASSWORD)) {
    sendJson(res, 403, { code: 'INVALID_EMERGENCY_PASSWORD', message: 'Incorrect emergency attendance password.' });
    return;
  }
  const db = loadDb();
  const record = db.attendance.find((item) => item.id === recordId);
  if (!record) return sendJson(res, 404, { code: 'ATTENDANCE_NOT_FOUND', message: 'Attendance record not found.' });
  const employee = db.employees.find((item) => item.id === record.employeeId && item.active !== false);
  if (!employee) return sendJson(res, 404, { code: 'EMPLOYEE_NOT_FOUND', message: 'Employee not found.' });
  const type = upperDisplayText(body.attendanceType || record.attendanceType || record.type || '', 32);
  if (!['TIME_IN', 'TIME_OUT'].includes(type)) return sendJson(res, 400, { code: 'INVALID_ATTENDANCE_TYPE', message: 'Attendance type must be TIME_IN or TIME_OUT.' });
  const scanDate = new Date(body.scannedAt || record.scannedAt);
  if (Number.isNaN(scanDate.getTime())) return sendJson(res, 400, { code: 'INVALID_SCAN_TIME', message: 'Enter a valid attendance date and time.' });
  const status = type === 'TIME_IN' ? computeTimeInStatus(employee, scanDate) : computeTimeOutStatus(employee, scanDate);
  Object.assign(record, {
    attendanceType: type,
    type,
    scannedAt: scanDate.toISOString(),
    punctuality: status.punctuality,
    lateMinutes: status.lateMinutes || 0,
    earlyOutMinutes: status.earlyOutMinutes || 0,
    statusText: status.statusText,
    accepted: true,
    source: 'SERVER_ADMIN_EDIT',
    reason: cleanDisplayText(body.reason || record.reason || 'Attendance correction', 120),
    reviewStatus: 'VERIFIED',
    reviewedBy: cleanDisplayText(actor?.username || 'Administrator', 80),
    reviewedAt: nowIso(),
    updatedAt: nowIso()
  });
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
    '/accounts': 'views/accounts.html',
    '/devices': 'views/devices.html',
    '/settings': 'views/settings.html',
    '/logs': 'views/logs.html',
    '/hr': 'hr/index.html',
    '/employee': 'employee/index.html'
  };
  const requestedPage = pageRoutes[pathname];
  const session = validSession(req);
  if (requestedPage && session?.role === 'employee' && pathname !== '/employee') {
    send(res, 302, '', { Location: '/employee' });
    return true;
  }
  if (requestedPage && session?.role !== 'employee' && pathname === '/employee') {
    send(res, 302, '', { Location: roleHomePath(session?.role) });
    return true;
  }
  if (requestedPage && session?.role === 'hr' && pathname === '/accounts') {
    send(res, 302, '', { Location: '/hr' });
    return true;
  }
  const relativePath = requestedPage && !session
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
  return (method === 'POST' && [
    '/api/auth/login',
    '/api/auth/check-username',
    '/api/auth/password-reset-request',
    '/api/auth/password-reset',
    '/api/auth/firebase'
  ].includes(pathname)) || (method === 'GET' && (pathname === '/api/auth/firebase-config' || /^\/api\/auth\/oauth\/(google|facebook)(\/callback)?$/.test(pathname)));
}

async function handleFirebaseAuth(req, res, body) {
  if (!FIREBASE_WEB_API_KEY || !FIREBASE_PROJECT_ID) return sendJson(res, 503, { code: 'FIREBASE_NOT_CONFIGURED', message: 'Firebase Authentication is not configured.' });
  const idToken = String(body.idToken || ''); const requestedProvider = String(body.provider || '').toLowerCase(); const mode = body.mode === 'link' ? 'link' : 'login';
  if (!idToken || !['google', 'facebook', 'phone'].includes(requestedProvider)) return sendJson(res, 400, { code: 'INVALID_FIREBASE_AUTH', message: 'A Firebase ID token and supported provider are required.' });
  try {
    const verification = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(FIREBASE_WEB_API_KEY)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ idToken }) });
    const verified = await verification.json(); const user = verified.users?.[0];
    if (!verification.ok || !user || user.validSince === undefined) throw new Error('Firebase rejected the identity token.');
    const providerName = requestedProvider === 'phone' ? 'phone' : `${requestedProvider}.com`; const identity = (user.providerUserInfo || []).find((item) => item.providerId === providerName);
    const verifiedPhone = requestedProvider === 'phone' ? normalizeAccountPhone(user.phoneNumber || identity?.phoneNumber || identity?.rawId || '') : '';
    if (requestedProvider === 'phone' && !verifiedPhone) return sendJson(res, 400, { code: 'PROVIDER_MISMATCH', message: 'Firebase did not return a verified phone number.' });
    if (requestedProvider !== 'phone' && !identity?.rawId) return sendJson(res, 400, { code: 'PROVIDER_MISMATCH', message: `The Firebase account is not authenticated with ${requestedProvider}.` });
    const db = loadDb(); let account;
    if (mode === 'link') {
      if (requestedProvider === 'phone') return sendJson(res, 400, { code: 'PHONE_LINK_NOT_SUPPORTED', message: 'Bind the phone number from Account & Security before using phone verification login.' });
      const session = validSession(req);
      if (!session || !['employee', 'hr', 'admin'].includes(session.role)) return sendJson(res, 401, { code: 'ACCOUNT_AUTH_REQUIRED', message: 'Sign in before linking an account.' });
      const currentAccount = db.employeeAccounts.find((item) => item.active !== false && item.username === session.username);
      const alreadyLinked = db.employeeAccounts.find((item) => item.id !== currentAccount?.id && item.socialIdentities?.[requestedProvider]?.id === identity.rawId);
      if (alreadyLinked) return sendJson(res, 409, { code: 'SOCIAL_ACCOUNT_IN_USE', message: `That ${requestedProvider} account is already linked to another employee.` });
      account = currentAccount;
      if (!account) return sendJson(res, 404, { code: 'ACCOUNT_NOT_FOUND', message: 'This sign-in is configured through environment credentials. Create a managed account with the same username before linking social login.' });
      account.socialIdentities = account.socialIdentities || {};
      const photoUrl = socialProfilePhotoUrl(requestedProvider, { photoUrl: identity.photoUrl || user.photoUrl });
      account.socialIdentities[requestedProvider] = { id: identity.rawId, firebaseUid: user.localId, email: String(identity.email || user.email || '').toLowerCase(), name: cleanDisplayText(identity.displayName || user.displayName || '', 100), photoUrl, linkedAt: nowIso() };
      account.updatedAt = nowIso(); saveDb(db);
    } else {
      account = requestedProvider === 'phone'
        ? db.employeeAccounts.find((item) => item.active !== false && safeEqual(normalizeAccountPhone(item.phone), verifiedPhone))
        : db.employeeAccounts.find((item) => item.active !== false && item.socialIdentities?.[requestedProvider]?.id === identity.rawId);
      if (!account) return sendJson(res, 404, { code: 'SOCIAL_ACCOUNT_NOT_LINKED', message: requestedProvider === 'phone' ? 'This verified phone number is not bound to an active account.' : `This ${requestedProvider} account is not linked yet. Sign in with your username first, then connect it in Account & Security.` });
    }
    const firebaseFacebookPhoto = socialProfilePhotoUrl(requestedProvider, { photoUrl: identity?.photoUrl || user.photoUrl });
    if (syncFacebookEmployeePhoto(db, account, firebaseFacebookPhoto)) saveDb(db);
    // Firebase does not always include Facebook's picture URL in providerUserInfo.
    // Refresh it from Graph immediately after binding/sign-in so attendance
    // surfaces do not keep showing an older uploaded employee photo.
    if (requestedProvider === 'facebook' && account.employeeId) {
      facebookPhotoSyncAt.delete(account.id || account.employeeId);
      await refreshBoundFacebookPhoto(account.employeeId);
    }
    createBrowserSession(req, res, { role: account.role || 'employee', username: account.username, employeeId: account.employeeId });
    sendJson(res, 200, { ok: true, provider: requestedProvider, mode, redirectTo: roleHomePath(account.role || 'employee') });
  } catch (error) { sendJson(res, 401, { code: 'FIREBASE_TOKEN_INVALID', message: error.message || 'Firebase identity verification failed.' }); }
}

function publicEmployeeAccount(account, db) {
  const employee = db.employees.find((item) => item.id === account.employeeId);
  return { id: account.id, role: account.role || 'employee', employeeId: account.employeeId, employeeName: employee?.fullName || (account.role === 'employee' ? 'Employee not found' : 'Not applicable'), employeeCode: employee?.employeeCode || '', username: account.username, phone: account.phone || '', active: account.active !== false, socialConnections: { phone: Boolean(account.phone), google: Boolean(account.socialIdentities?.google?.id), facebook: Boolean(account.socialIdentities?.facebook?.id) }, createdAt: account.createdAt, updatedAt: account.updatedAt };
}

function handleGetEmployeeAccounts(res) {
  const db = loadDb();
  sendJson(res, 200, { accounts: db.employeeAccounts.map((account) => publicEmployeeAccount(account, db)) });
}

async function handleSaveEmployeeAccount(res, body, accountId = '') {
  const db = loadDb();
  const existing = accountId ? db.employeeAccounts.find((item) => item.id === accountId) : null;
  if (accountId && !existing) return sendJson(res, 404, { code: 'ACCOUNT_NOT_FOUND', message: 'Employee account not found.' });
  const role = String(body.role || existing?.role || 'employee').toLowerCase();
  const employeeId = role === 'employee' ? String(body.employeeId || existing?.employeeId || '') : '';
  const username = String(body.username || existing?.username || '').trim().toLowerCase();
  const requestedPhone = String(body.phone ?? existing?.phone ?? '').trim();
  const phone = normalizeAccountPhone(requestedPhone);
  const password = String(body.password || '');
  if (!['admin', 'hr', 'employee'].includes(role)) return sendJson(res, 400, { code: 'INVALID_ROLE', message: 'Role must be Employee, HR, or Admin.' });
  if (role === 'employee' && !db.employees.some((item) => item.id === employeeId)) return sendJson(res, 400, { code: 'EMPLOYEE_NOT_FOUND', message: 'Select a valid employee for an Employee account.' });
  if (!/^[a-z0-9._-]{3,40}$/i.test(username)) return sendJson(res, 400, { code: 'INVALID_USERNAME', message: 'Username must be 3-40 letters, numbers, dots, underscores, or dashes.' });
  if (requestedPhone && !phone) return sendJson(res, 400, { code: 'INVALID_ACCOUNT_PHONE', message: 'Phone number must contain 7-15 digits and include the country code.' });
  if ((!existing || password) && password.length < 8) return sendJson(res, 400, { code: 'WEAK_PASSWORD', message: 'Password must contain at least 8 characters.' });
  if (db.employeeAccounts.some((item) => item.id !== accountId && item.username === username)) return sendJson(res, 409, { code: 'USERNAME_EXISTS', message: 'That username is already in use.' });
  if (phone && db.employeeAccounts.some((item) => item.id !== accountId && normalizeAccountPhone(item.phone) === phone)) return sendJson(res, 409, { code: 'PHONE_EXISTS', message: 'That phone number is already bound to another account.' });
  if (role === 'employee' && db.employeeAccounts.some((item) => item.id !== accountId && item.role === 'employee' && item.employeeId === employeeId)) return sendJson(res, 409, { code: 'EMPLOYEE_ACCOUNT_EXISTS', message: 'This employee already has an account.' });
  const timestamp = nowIso();
  const account = existing || { id: createId('account'), createdAt: timestamp };
  Object.assign(account, { role, employeeId, username, phone, active: body.active !== false, updatedAt: timestamp });
  if (password) Object.assign(account, hashAccountPassword(password));
  if (!existing) db.employeeAccounts.unshift(account);
  saveDb(db);
  sendJson(res, existing ? 200 : 201, { account: publicEmployeeAccount(account, db) });
}

function handleDeleteEmployeeAccount(res, accountId) {
  const db = loadDb();
  const index = db.employeeAccounts.findIndex((item) => item.id === accountId);
  if (index < 0) return sendJson(res, 404, { code: 'ACCOUNT_NOT_FOUND', message: 'Employee account not found.' });
  db.employeeAccounts.splice(index, 1);
  saveDb(db);
  sendJson(res, 200, { ok: true });
}

async function handleAuthLogin(req, res) {
  const ip = requestIp(req);
  if (!consumeRateLimit(`auth:${ip}`, AUTH_ATTEMPTS_PER_15_MINUTES, 15 * 60 * 1000)) {
    sendJson(res, 429, { code: 'TOO_MANY_ATTEMPTS', message: 'Too many login attempts. Try again later.' });
    return;
  }
  const body = await readBody(req);
  const loginId = String(body.username || '').trim();
  const username = loginId.toLowerCase();
  const phone = normalizeAccountPhone(loginId);
  const password = String(body.password || '');
  const configuredAccount = [...ROLE_CREDENTIALS, ...EMPLOYEE_ACCOUNTS].find((item) => safeEqual(username, String(item.username).toLowerCase()) && safeEqual(password, item.password));
  const dbAccount = loadDb().employeeAccounts.find((item) => item.active !== false && (safeEqual(username, item.username) || (phone && safeEqual(phone, normalizeAccountPhone(item.phone)))) && verifyAccountPassword(password, item));
  const account = configuredAccount || (dbAccount ? { role: dbAccount.role || 'employee', username: dbAccount.username, employeeId: dbAccount.employeeId } : null);
  if (!account) {
    sendJson(res, 401, { code: 'INVALID_CREDENTIALS', message: 'Invalid username, phone number, or password.' });
    return;
  }
  const role = account.role;
  createBrowserSession(req, res, { role, username, employeeId: account?.employeeId || '' });
  const redirectTo = roleHomePath(role);
  sendJson(res, 200, { ok: true, role, username, employeeId: account?.employeeId || '', redirectTo, expiresInHours: SESSION_TTL_MS / 3600000 });
}

async function handleAuthUsernameCheck(req, res) {
  const ip = requestIp(req);
  if (!consumeRateLimit(`auth-username:${ip}`, Math.max(10, AUTH_ATTEMPTS_PER_15_MINUTES * 3), 15 * 60 * 1000)) {
    sendJson(res, 429, { code: 'TOO_MANY_ATTEMPTS', message: 'Too many username checks. Try again later.' });
    return;
  }
  const body = await readBody(req);
  const username = String(body.username || '').trim().toLowerCase();
  sendJson(res, 200, { exists: hasActiveLoginUsername(username) });
}

function handleAuthMe(req, res) {
  const session = validSession(req);
  if (!session) {
    sendJson(res, 401, { code: 'AUTH_REQUIRED', message: 'Authentication is required.' });
    return;
  }
  const managed = loadDb().employeeAccounts.find((item) => item.active !== false && item.username === session.username);
  sendJson(res, 200, { authenticated: true, role: session.role, username: session.username, employeeId: session.employeeId || '', managedAccount: Boolean(managed), phone: managed?.phone || '', socialConnections: { phone: Boolean(managed?.phone), google: Boolean(managed?.socialIdentities?.google?.id), facebook: Boolean(managed?.socialIdentities?.facebook?.id) }, expiresAt: new Date(session.expiresAt).toISOString() });
}

async function handleBindOwnPhone(req, res) {
  const body = await readBody(req);
  const requestedPhone = String(body.phone || '').trim();
  const phone = normalizeAccountPhone(requestedPhone);
  if (!phone) return sendJson(res, 400, { code: 'INVALID_ACCOUNT_PHONE', message: 'Enter a valid phone number with 7-15 digits.' });
  const db = loadDb();
  const account = db.employeeAccounts.find((item) => item.active !== false && item.username === req.auth?.username);
  if (!account) return sendJson(res, 404, { code: 'MANAGED_ACCOUNT_REQUIRED', message: 'This session is not linked to a managed account.' });
  if (db.employeeAccounts.some((item) => item.id !== account.id && normalizeAccountPhone(item.phone) === phone)) return sendJson(res, 409, { code: 'PHONE_EXISTS', message: 'That phone number is already bound to another account.' });
  account.phone = phone;
  account.updatedAt = nowIso();
  saveDb(db);
  sendJson(res, 200, { ok: true, phone });
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

  if (origin && !allowedOrigin(req)) {
    sendJson(res, 403, { code: 'ORIGIN_NOT_ALLOWED', message: 'Request origin is not allowed.' });
    return;
  }

  const rateLimitedApiRequest = shouldRateLimitRequest(pathname, method);
  if (rateLimitedApiRequest && !consumeRateLimit(`request:${requestIp(req)}`, REQUESTS_PER_MINUTE, 60 * 1000)) {
    res.setHeader('Retry-After', '60');
    sendJson(res, 429, { code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' });
    return;
  }

  if (method === 'OPTIONS') {
    send(res, 204, '');
    return;
  }

  try {
    if (method === 'GET' && (pathname === '/health' || pathname === '/api/health')) {
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

    if (method === 'POST' && pathname === '/api/auth/check-username') {
      await handleAuthUsernameCheck(req, res);
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
    if (method === 'PATCH' && pathname === '/api/auth/phone') {
      await handleBindOwnPhone(req, res);
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
      await refreshAllBoundFacebookPhotos();
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

    if (method === 'POST' && pathname === '/api/auth/password-reset-request') { await handlePasswordResetRequest(res, await readBody(req)); return; }
    if (method === 'POST' && pathname === '/api/auth/password-reset') { await handleVerifiedPasswordReset(res, await readBody(req)); return; }
    if (method === 'POST' && pathname === '/api/auth/firebase') { await handleFirebaseAuth(req, res, await readBody(req)); return; }
    if (method === 'GET' && pathname === '/api/auth/firebase-config') {
      sendJson(res, 200, { apiKey: FIREBASE_WEB_API_KEY, authDomain: `${FIREBASE_PROJECT_ID}.firebaseapp.com`, projectId: FIREBASE_PROJECT_ID });
      return;
    }
    const oauthMatch = pathname.match(/^\/api\/auth\/oauth\/(google|facebook)(\/callback)?$/);
    if (method === 'GET' && oauthMatch) { if (oauthMatch[2]) await handleOauthCallback(req, res, url, oauthMatch[1]); else handleOauthStart(req, res, url, oauthMatch[1]); return; }

    if (method === 'GET' && pathname === '/api/employee-accounts') return handleGetEmployeeAccounts(res);
    if (method === 'POST' && pathname === '/api/employee-accounts') return handleSaveEmployeeAccount(res, await readBody(req));
    const accountMatch = pathname.match(/^\/api\/employee-accounts\/([^/]+)$/);
    if (accountMatch && method === 'PATCH') return handleSaveEmployeeAccount(res, await readBody(req), decodeURIComponent(accountMatch[1]));
    if (accountMatch && method === 'DELETE') return handleDeleteEmployeeAccount(res, decodeURIComponent(accountMatch[1]));

    if (method === 'GET' && pathname === '/api/employee/home') {
      await refreshBoundFacebookPhoto(req.auth.employeeId);
      const payload = buildPortalPayload(req.auth, url);
      return payload ? sendJson(res, 200, payload) : sendJson(res, 404, { code: 'EMPLOYEE_NOT_FOUND', message: 'This account is not linked to an active employee.' });
    }
    if (method === 'POST' && pathname === '/api/employee/profile-photo') {
      return handleEmployeePhotoUpload(res, req.auth.employeeId, await readBody(req));
    }
    if (method === 'POST' && pathname === '/api/employee/leave-requests') {
      const body = await readBody(req); body.employeeId = req.auth.employeeId;
      return handleCreateLeaveRequest(res, body, req.auth);
    }
    if (method === 'POST' && pathname === '/api/employee/correction-requests') {
      const body = await readBody(req); body.employeeId = req.auth.employeeId;
      return handleCreateCorrectionRequest(res, body, req.auth);
    }

    if (method === 'GET' && pathname === '/api/departments') return sendJson(res, 200, { departments: loadDb().departments });
    if (method === 'GET' && pathname === '/api/designations') return sendJson(res, 200, { designations: loadDb().designations });
    if (method === 'GET' && pathname === '/api/leave-requests') return sendJson(res, 200, { leaveRequests: loadDb().leaveRequests });
    if (method === 'GET' && pathname === '/api/correction-requests') return sendJson(res, 200, { correctionRequests: loadDb().correctionRequests });
    if (method === 'GET' && pathname === '/api/notifications') return sendJson(res, 200, { notifications: loadDb().notifications.slice(0, 200) });

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

    if (method === 'POST' && pathname === '/api/departments') return handleCreateDirectoryRecord(res, 'departments', await readBody(req));
    if (method === 'POST' && pathname === '/api/designations') return handleCreateDirectoryRecord(res, 'designations', await readBody(req));
    if (method === 'POST' && pathname === '/api/leave-requests') return handleCreateLeaveRequest(res, await readBody(req), req.auth);
    if (method === 'POST' && pathname === '/api/correction-requests') return handleCreateCorrectionRequest(res, await readBody(req), req.auth);

    const leaveReviewMatch = pathname.match(/^\/api\/leave-requests\/([^/]+)\/review$/);
    if (method === 'PATCH' && leaveReviewMatch) return handleReviewWorkflow(res, 'leaveRequests', decodeURIComponent(leaveReviewMatch[1]), await readBody(req), req.auth);
    const correctionReviewMatch = pathname.match(/^\/api\/correction-requests\/([^/]+)\/review$/);
    if (method === 'PATCH' && correctionReviewMatch) return handleReviewWorkflow(res, 'correctionRequests', decodeURIComponent(correctionReviewMatch[1]), await readBody(req), req.auth);

    if (method === 'POST' && /^\/api\/employees\/[^/]+\/fingerprints$/.test(pathname)) {
      const employeeId = decodeURIComponent(pathname.split('/')[3]);
      await handleAddEmployeeFingerprint(res, employeeId, await readBody(req));
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

    const attendanceEditMatch = pathname.match(/^\/api\/admin\/attendance\/([^/]+)$/);
    if (method === 'PATCH' && attendanceEditMatch) {
      await handleEditAttendanceRecord(res, decodeURIComponent(attendanceEditMatch[1]), await readBody(req), req.auth);
      return;
    }

    if (method === 'POST' && pathname === '/api/admin/clear-attendance') {
      const body = await readBody(req);
      const db = loadDb();
      if (!verifyActorPassword(req.auth, body.password, db)) {
        sendJson(res, 403, { code: 'INVALID_PASSWORD', message: 'Incorrect administrator password.' });
        return;
      }
      const deleted = db.attendance.length;
      db.attendance = [];
      saveDb(db);
      sendJson(res, 200, { ok: true, deleted });
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
  normalizeAccountPhone,
  normalizeDeviceId,
  isPublicApi,
  deviceRoute,
  roleCanAccess,
  roleHomePath,
  isRecordedAttendanceLog,
  normalizeSettings,
  consumeRateLimit,
  shouldRateLimitRequest,
  securityHeaders,
  createOauthState,
  readOauthState,
  removeEmployeeFingerprintMapping
};
