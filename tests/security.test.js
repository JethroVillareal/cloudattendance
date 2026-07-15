'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  safeEqual,
  cleanDisplayText,
  normalizeDeviceId,
  isPublicApi,
  deviceRoute,
  roleCanAccess,
  roleHomePath,
  isRecordedAttendanceLog,
  normalizeSettings,
  consumeRateLimit,
  securityHeaders
} = require('../server');

test('constant-time key comparison accepts only exact keys', () => {
  assert.equal(safeEqual('correct-key', 'correct-key'), true);
  assert.equal(safeEqual('correct-key', 'wrong-key'), false);
  assert.equal(safeEqual('short', 'longer'), false);
});

test('role permissions keep devices and viewers away from administration', () => {
  assert.equal(deviceRoute('/api/attendance/scan', 'POST'), true);
  assert.equal(deviceRoute('/api/settings', 'POST'), false);
  assert.equal(roleCanAccess('device', '/api/attendance/scan', 'POST'), true);
  assert.equal(roleCanAccess('device', '/api/employees', 'GET'), false);
  assert.equal(roleCanAccess('viewer', '/api/employees', 'GET'), true);
  assert.equal(roleCanAccess('viewer', '/api/employees', 'POST'), false);
  assert.equal(roleCanAccess('hr', '/api/attendance/review', 'POST'), true);
  assert.equal(roleCanAccess('hr', '/api/settings', 'POST'), false);
  assert.equal(roleCanAccess('admin', '/api/settings', 'POST'), true);
  assert.equal(roleCanAccess('admin', '/api/employee-accounts', 'POST'), true);
  assert.equal(roleCanAccess('hr', '/api/employee-accounts', 'GET'), false);
  assert.equal(roleCanAccess('viewer', '/api/employee-accounts', 'GET'), false);
});

test('employee role is restricted to its own employee API surface', () => {
  assert.equal(roleCanAccess('employee', '/api/employee/home', 'GET'), true);
  assert.equal(roleCanAccess('employee', '/api/employee/leave-requests', 'POST'), true);
  assert.equal(roleCanAccess('employee', '/api/employees', 'GET'), false);
  assert.equal(roleCanAccess('employee', '/api/timecard', 'GET'), false);
  assert.equal(roleCanAccess('employee', '/api/employee/home', 'DELETE'), false);
});

test('each account role opens the correct workspace', () => {
  assert.equal(roleHomePath('employee'), '/employee');
  assert.equal(roleHomePath('hr'), '/hr');
  assert.equal(roleHomePath('admin'), '/dashboard');
  assert.equal(roleHomePath('viewer'), '/dashboard');
});

test('only accepted time in and time out rows count as attendance', () => {
  assert.equal(isRecordedAttendanceLog({ accepted: true, attendanceType: 'TIME_IN' }), true);
  assert.equal(isRecordedAttendanceLog({ accepted: true, attendanceType: 'TIME_OUT' }), true);
  assert.equal(isRecordedAttendanceLog({ accepted: false, attendanceType: 'TIME_IN' }), false);
  assert.equal(isRecordedAttendanceLog({ accepted: true, attendanceType: 'DUPLICATE_SCAN' }), false);
});

test('settings clamp unsafe operational values', () => {
  const settings = normalizeSettings({ graceMinutes: 999, duplicateScanDelayMinutes: 0, esp32DisplayDurationMs: 999999 });
  assert.equal(settings.graceMinutes, 120);
  assert.equal(settings.duplicateScanDelayMinutes, 1);
  assert.equal(settings.esp32DisplayDurationMs, 15000);
});

test('only the login API is public', () => {
  assert.equal(isPublicApi('/api/auth/login', 'POST'), true);
  assert.equal(isPublicApi('/api/employees', 'GET'), false);
  assert.equal(isPublicApi('/api/settings', 'POST'), false);
  assert.equal(isPublicApi('/api/testing/clear-attendance', 'POST'), false);
});

test('rate limiter blocks requests beyond the configured window limit', () => {
  const key = `test-${Date.now()}`;
  assert.equal(consumeRateLimit(key, 2, 60000), true);
  assert.equal(consumeRateLimit(key, 2, 60000), true);
  assert.equal(consumeRateLimit(key, 2, 60000), false);
});

test('security headers deny framing and MIME sniffing', () => {
  const headers = securityHeaders({ headers: {}, socket: {} });
  assert.equal(headers['X-Frame-Options'], 'DENY');
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.match(headers['Content-Security-Policy'], /default-src 'self'/);
});

test('device and display input normalizers trim and remove control characters', () => {
  assert.equal(normalizeDeviceId(' READER 01/MAIN '), 'READER 01/MAIN');
  assert.equal(cleanDisplayText('Hello\n<script>', 24), 'Hello<script>');
});
