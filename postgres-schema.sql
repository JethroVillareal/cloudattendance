CREATE TABLE IF NOT EXISTS app_state (
  state_key TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  state_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_state_updated_at ON app_state(updated_at DESC);

-- Recent point-in-time snapshots make accidental edits recoverable without
-- replacing the current JSON-compatible state model.
CREATE TABLE IF NOT EXISTS app_state_history (
  snapshot_id BIGSERIAL PRIMARY KEY,
  state_key TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  state_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_state_history_created_at
  ON app_state_history(created_at DESC);

CREATE TABLE IF NOT EXISTS employee_records (
  employee_id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  fingerprint_id INTEGER,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS attendance_records (
  attendance_id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL,
  attendance_type TEXT NOT NULL CHECK (attendance_type IN ('TIME_IN', 'TIME_OUT')),
  scanned_at TIMESTAMPTZ NOT NULL,
  device_id TEXT,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_attendance_employee_scanned_at ON attendance_records(employee_id, scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_scanned_at ON attendance_records(scanned_at DESC);

CREATE TABLE IF NOT EXISTS reader_records (
  device_id TEXT PRIMARY KEY,
  firmware_version TEXT,
  last_seen_at TIMESTAMPTZ,
  payload JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_records (
  audit_id TEXT PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL,
  method TEXT NOT NULL,
  pathname TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  actor TEXT NOT NULL,
  role TEXT,
  ip_address TEXT,
  user_agent TEXT,
  payload JSONB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_records_occurred_at
  ON audit_records(occurred_at DESC);
