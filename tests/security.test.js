'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
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
} = require('../server');

test('constant-time key comparison accepts only exact keys', () => {
  assert.equal(safeEqual('correct-key', 'correct-key'), true);
  assert.equal(safeEqual('correct-key', 'wrong-key'), false);
  assert.equal(safeEqual('short', 'longer'), false);
});

test('OAuth state survives process-local memory loss while rejecting tampering and expiry', () => {
  const now = 1_700_000_000_000;
  const state = createOauthState('google', { accountId: 'account-1', mode: 'login' }, 'test-client-secret', now);
  assert.deepEqual(
    { ...readOauthState(state, 'google', 'test-client-secret', now + 1000), nonce: '<random>' },
    { version: 1, provider: 'google', accountId: 'account-1', mode: 'login', expiresAt: now + 600_000, nonce: '<random>' }
  );
  assert.equal(readOauthState(`${state}x`, 'google', 'test-client-secret', now + 1000), null);
  assert.equal(readOauthState(state, 'facebook', 'test-client-secret', now + 1000), null);
  assert.equal(readOauthState(state, 'google', 'test-client-secret', now + 600_001), null);
});

test('fingerprint-only removal does not restore the deleted legacy primary ID', () => {
  const employee = {
    fingerprintId: 11,
    fingerprints: [
      { fingerprintId: 11, label: 'Primary Finger', active: true },
      { fingerprintId: 12, label: 'Second Finger', active: true }
    ]
  };
  assert.equal(removeEmployeeFingerprintMapping(employee, 11), true);
  assert.equal(employee.fingerprintId, 12);
  assert.deepEqual(employee.fingerprints.map((item) => item.fingerprintId), [12]);
  assert.equal(removeEmployeeFingerprintMapping(employee, 12), true);
  assert.equal(employee.fingerprintId, null);
  assert.deepEqual(employee.fingerprints, []);
});

test('account phone binding normalizes common formats safely', () => {
  assert.equal(normalizeAccountPhone('+63 917-123-4567'), '+639171234567');
  assert.equal(normalizeAccountPhone('0917 123 4567'), '+639171234567');
  assert.equal(normalizeAccountPhone('9171234567'), '+639171234567');
  assert.equal(normalizeAccountPhone('(02) 8123 4567'), '+0281234567');
  assert.equal(normalizeAccountPhone('123'), '');
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
  assert.equal(roleCanAccess('employee', '/api/auth/phone', 'PATCH'), true);
  assert.equal(roleCanAccess('hr', '/api/auth/phone', 'PATCH'), true);
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

test('only authentication entry points are public', () => {
  assert.equal(isPublicApi('/api/auth/login', 'POST'), true);
  assert.equal(isPublicApi('/api/auth/password-reset-request', 'POST'), true);
  assert.equal(isPublicApi('/api/auth/password-reset', 'POST'), true);
  assert.equal(isPublicApi('/api/auth/firebase', 'POST'), true);
  assert.equal(isPublicApi('/api/auth/firebase-config', 'GET'), true);
  assert.equal(isPublicApi('/api/auth/oauth/google', 'GET'), true);
  assert.equal(isPublicApi('/api/auth/oauth/facebook/callback', 'GET'), true);
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

test('global request limiter counts APIs but not dashboard assets or health checks', () => {
  assert.equal(shouldRateLimitRequest('/api/employees', 'GET'), true);
  assert.equal(shouldRateLimitRequest('/api/auth/login', 'POST'), true);
  assert.equal(shouldRateLimitRequest('/dashboard', 'GET'), false);
  assert.equal(shouldRateLimitRequest('/icons/accounts.svg', 'GET'), false);
  assert.equal(shouldRateLimitRequest('/health', 'GET'), false);
  assert.equal(shouldRateLimitRequest('/api/employees', 'OPTIONS'), false);
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
