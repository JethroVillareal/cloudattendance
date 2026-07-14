'use strict';

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const { Pool } = require('pg');

const ROOT = __dirname;
const POSTGRES_ENABLED = Boolean(process.env.DATABASE_URL || process.env.PGHOST);
const CLOUD_MODE = process.env.CLOUD_MODE === 'true' || process.env.RENDER === 'true';
const SQLITE_BACKUP_ENABLED = process.env.SQLITE_BACKUP_ENABLED
  ? process.env.SQLITE_BACKUP_ENABLED !== 'false'
  : !CLOUD_MODE;
const SQLITE_SYNC_DELAY_MS = Math.max(250, Number(process.env.SQLITE_SYNC_DELAY_MS || 1500));

let pool = null;
let sqliteTimer = null;
let postgresWrite = Promise.resolve();
let latestState = null;
const status = {
  requestedPrimary: POSTGRES_ENABLED ? 'postgresql' : 'sqlite',
  activePrimary: 'json',
  postgresql: POSTGRES_ENABLED ? 'connecting' : 'not_configured',
  sqliteBackup: SQLITE_BACKUP_ENABLED ? 'pending' : 'disabled',
  lastPostgresSyncAt: null,
  lastSqliteSyncAt: null,
  lastError: null
};

function postgresConfig() {
  if (process.env.DATABASE_URL) {
    const pgSsl = process.env.PGSSL
      ? process.env.PGSSL === 'true'
      : CLOUD_MODE || /(?:^|\.)supabase\.(?:com|co)(?::\d+)?(?:\/|$)/i.test(process.env.DATABASE_URL);
    return {
      connectionString: process.env.DATABASE_URL,
      ssl: pgSsl ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 3000)
    };
  }
  const config = {
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || 'gms_attendance',
    user: process.env.PGUSER || 'postgres',
    connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 3000)
  };
  if (process.env.PGPASSWORD) config.password = process.env.PGPASSWORD;
  return config;
}

function stateTimestamp(state) {
  const value = state?.meta?.updatedAt || state?.meta?.lastUpdatedAt || '';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function loadSqliteFallback(localState) {
  if (!SQLITE_BACKUP_ENABLED) return { state: localState, source: 'json' };
  const result = spawnSync(process.env.PYTHON_COMMAND || 'python', ['sqlite_state.py'], {
    cwd: ROOT,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024
  });
  if (result.status !== 0 || !result.stdout) {
    status.sqliteBackup = 'unavailable';
    return { state: localState, source: 'json' };
  }
  try {
    const sqliteState = JSON.parse(result.stdout);
    status.sqliteBackup = 'ready';
    return stateTimestamp(sqliteState) >= stateTimestamp(localState)
      ? { state: sqliteState, source: 'sqlite' }
      : { state: localState, source: 'json' };
  } catch (error) {
    status.sqliteBackup = 'invalid';
    status.lastError = error.message;
    return { state: localState, source: 'json' };
  }
}

async function initialize(localState) {
  latestState = localState;
  if (!POSTGRES_ENABLED) {
    const fallback = loadSqliteFallback(localState);
    latestState = fallback.state;
    status.activePrimary = fallback.source;
    return fallback;
  }

  try {
    pool = new Pool(postgresConfig());
    await pool.query(`CREATE TABLE IF NOT EXISTS app_state (
      state_key TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      state_json JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query(`CREATE TABLE IF NOT EXISTS app_state_history (
      snapshot_id BIGSERIAL PRIMARY KEY,
      state_key TEXT NOT NULL,
      schema_version INTEGER NOT NULL,
      state_json JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_app_state_history_created_at ON app_state_history(created_at DESC)');
    await pool.query(`CREATE TABLE IF NOT EXISTS employee_records (
      employee_id TEXT PRIMARY KEY, full_name TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT TRUE,
      fingerprint_id INTEGER, payload JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS attendance_records (
      attendance_id TEXT PRIMARY KEY, employee_id TEXT NOT NULL, attendance_type TEXT NOT NULL,
      scanned_at TIMESTAMPTZ NOT NULL, device_id TEXT, payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_attendance_employee_scanned_at ON attendance_records(employee_id, scanned_at DESC)');
    await pool.query(`CREATE TABLE IF NOT EXISTS reader_records (
      device_id TEXT PRIMARY KEY, firmware_version TEXT, last_seen_at TIMESTAMPTZ,
      payload JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await pool.query(`CREATE TABLE IF NOT EXISTS audit_records (
      audit_id TEXT PRIMARY KEY, occurred_at TIMESTAMPTZ NOT NULL, method TEXT NOT NULL,
      pathname TEXT NOT NULL, response_status INTEGER NOT NULL, actor TEXT NOT NULL,
      role TEXT, ip_address TEXT, user_agent TEXT, payload JSONB NOT NULL)`);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_audit_records_occurred_at ON audit_records(occurred_at DESC)');
    const result = await pool.query("SELECT state_json FROM app_state WHERE state_key = 'primary'");
    if (result.rows[0]?.state_json) {
      latestState = result.rows[0].state_json;
    } else {
      await writePostgres(localState);
    }
    status.postgresql = 'connected';
    status.activePrimary = 'postgresql';
    status.sqliteBackup = SQLITE_BACKUP_ENABLED ? 'ready' : 'disabled';
    status.lastError = null;
    return { state: latestState, source: 'postgresql' };
  } catch (error) {
    status.postgresql = 'unavailable';
    if (CLOUD_MODE) {
      status.activePrimary = 'unavailable';
      status.lastError = error.message;
      if (pool) await pool.end().catch(() => {});
      pool = null;
      throw new Error(`Cloud database connection failed: ${error.message}`);
    }
    const fallback = loadSqliteFallback(localState);
    latestState = fallback.state;
    status.activePrimary = fallback.source;
    status.lastError = error.message;
    if (pool) await pool.end().catch(() => {});
    pool = null;
    return { state: fallback.state, source: fallback.source, error };
  }
}

async function writeAudit(record) {
  if (!pool) return false;
  await pool.query(`INSERT INTO audit_records
    (audit_id, occurred_at, method, pathname, response_status, actor, role, ip_address, user_agent, payload)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)`, [
    record.id, record.at, record.method, record.pathname, record.status,
    record.actor, record.role, record.ip, record.userAgent, JSON.stringify(record)
  ]);
  return true;
}

async function readAudit(limit) {
  if (!pool) return null;
  const result = await pool.query(
    'SELECT payload FROM audit_records ORDER BY occurred_at DESC LIMIT $1',
    [Math.min(500, Math.max(1, Number(limit || 100)))]
  );
  return result.rows.map((row) => row.payload);
}

async function writePostgres(state) {
  if (!pool) return;
  const client = await pool.connect();
  try {
    const schemaVersion = Number(state?.meta?.schemaVersion || 1);
    const stateJson = JSON.stringify(state);
    await client.query('BEGIN');
    await client.query(`INSERT INTO app_state (state_key, schema_version, state_json, updated_at)
      VALUES ('primary', $1, $2::jsonb, NOW())
      ON CONFLICT (state_key) DO UPDATE SET schema_version = EXCLUDED.schema_version,
        state_json = EXCLUDED.state_json, updated_at = NOW()`, [schemaVersion, stateJson]);
    await client.query(`INSERT INTO app_state_history (state_key, schema_version, state_json)
      VALUES ('primary', $1, $2::jsonb)`, [schemaVersion, stateJson]);
    await client.query(`DELETE FROM app_state_history WHERE snapshot_id IN (
      SELECT snapshot_id FROM app_state_history ORDER BY created_at DESC OFFSET 100
    )`);
    await client.query('DELETE FROM employee_records');
    for (const employee of state?.employees || []) {
      const fingerprintId = employee.fingerprintId ?? employee.fingerprints?.[0]?.fingerprintId ?? null;
      await client.query(`INSERT INTO employee_records (employee_id, full_name, active, fingerprint_id, payload)
        VALUES ($1, $2, $3, $4, $5::jsonb)`, [employee.id, employee.fullName || employee.name || 'Unknown', employee.active !== false, fingerprintId, JSON.stringify(employee)]);
    }
    await client.query('DELETE FROM attendance_records');
    for (const attendance of state?.attendance || []) {
      await client.query(`INSERT INTO attendance_records (attendance_id, employee_id, attendance_type, scanned_at, device_id, payload)
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)`, [attendance.id, attendance.employeeId, attendance.attendanceType, attendance.timestamp || attendance.scannedAt, attendance.deviceId || '', JSON.stringify(attendance)]);
    }
    await client.query('DELETE FROM reader_records');
    for (const reader of state?.readers || []) {
      await client.query(`INSERT INTO reader_records (device_id, firmware_version, last_seen_at, payload)
        VALUES ($1, $2, $3, $4::jsonb)`, [reader.deviceId, reader.firmwareVersion || '', reader.lastSeenAt || null, JSON.stringify(reader)]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
  status.lastPostgresSyncAt = new Date().toISOString();
  status.postgresql = 'connected';
  status.lastError = null;
}

function syncSqlite() {
  if (!SQLITE_BACKUP_ENABLED) return;
  clearTimeout(sqliteTimer);
  sqliteTimer = setTimeout(() => {
    const child = spawn(process.env.PYTHON_COMMAND || 'python', ['seed.py', '--no-backup'], {
      cwd: ROOT,
      windowsHide: true,
      stdio: 'ignore'
    });
    child.once('exit', (code) => {
      status.sqliteBackup = code === 0 ? 'synced' : 'failed';
      if (code === 0) status.lastSqliteSyncAt = new Date().toISOString();
      else status.lastError = `SQLite backup process exited with code ${code}`;
    });
    child.once('error', (error) => {
      status.sqliteBackup = 'failed';
      status.lastError = error.message;
    });
  }, SQLITE_SYNC_DELAY_MS);
}

function scheduleSnapshot(state) {
  latestState = JSON.parse(JSON.stringify(state));
  if (pool) {
    postgresWrite = postgresWrite
      .then(() => writePostgres(latestState))
      .catch((error) => {
        status.postgresql = 'write_failed';
        status.activePrimary = SQLITE_BACKUP_ENABLED ? 'sqlite' : 'json';
        status.lastError = error.message;
      });
  }
  syncSqlite();
}

function getStatus() {
  return { ...status };
}

async function close() {
  clearTimeout(sqliteTimer);
  await postgresWrite.catch(() => {});
  if (pool) await pool.end().catch(() => {});
}

module.exports = { initialize, scheduleSnapshot, writeAudit, readAudit, getStatus, close };
