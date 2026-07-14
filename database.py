from __future__ import annotations

import json
import shutil
import sqlite3
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import Generator

ROOT = Path(__file__).resolve().parent
DB_PATH = ROOT / "attendance.db"
JSON_DB_PATH = ROOT / "data" / "db.json"


def get_connection() -> sqlite3.Connection:
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


@contextmanager
def db_cursor() -> Generator[sqlite3.Cursor, None, None]:
    connection = get_connection()
    try:
        cursor = connection.cursor()
        yield cursor
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def init_db(reset: bool = False) -> None:
    """Create the SQLite mirror schema used by the Node/ESP32 database."""
    with db_cursor() as cur:
        if reset:
            cur.execute("PRAGMA foreign_keys = OFF")
            for table in (
                "employee_fingerprints", "weekly_schedules", "attendance",
                "enrollment_requests", "readers", "display_commands",
                "manual_statuses", "employees", "settings", "metadata",
                "state_snapshots",
            ):
                cur.execute(f"DROP TABLE IF EXISTS {table}")
            cur.execute("PRAGMA foreign_keys = ON")

        cur.executescript("""
            CREATE TABLE IF NOT EXISTS employees (
                id TEXT PRIMARY KEY,
                full_name TEXT NOT NULL,
                fingerprint_id INTEGER,
                shift_start TEXT NOT NULL,
                shift_end TEXT NOT NULL,
                grace_minutes INTEGER NOT NULL DEFAULT 0,
                active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT,
                updated_at TEXT,
                raw_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS employee_fingerprints (
                employee_id TEXT NOT NULL,
                fingerprint_id INTEGER NOT NULL,
                label TEXT,
                device_id TEXT,
                active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT,
                raw_json TEXT NOT NULL,
                PRIMARY KEY (employee_id, fingerprint_id),
                FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS weekly_schedules (
                employee_id TEXT NOT NULL,
                day_name TEXT NOT NULL,
                day_off INTEGER NOT NULL DEFAULT 0,
                time_in TEXT,
                time_out TEXT,
                raw_json TEXT NOT NULL,
                PRIMARY KEY (employee_id, day_name),
                FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS attendance (
                id TEXT PRIMARY KEY,
                event_id TEXT,
                employee_id TEXT,
                full_name TEXT,
                fingerprint_id INTEGER,
                fingerprint_confidence REAL,
                attendance_type TEXT,
                accepted INTEGER,
                code TEXT,
                status_text TEXT,
                punctuality TEXT,
                late_minutes INTEGER,
                early_out_minutes INTEGER,
                paid_hours REAL,
                scanned_at TEXT,
                original_scanned_at TEXT,
                date_key TEXT,
                display_time TEXT,
                display_date_time TEXT,
                device_id TEXT,
                location TEXT,
                source TEXT,
                firmware_version TEXT,
                device_ip TEXT,
                wifi_rssi INTEGER,
                created_at TEXT,
                raw_json TEXT NOT NULL,
                FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS enrollment_requests (
                id TEXT PRIMARY KEY,
                employee_id TEXT,
                fingerprint_id INTEGER,
                status TEXT,
                requested_action TEXT,
                device_id TEXT,
                source TEXT,
                enrolled_at TEXT,
                created_at TEXT,
                updated_at TEXT,
                raw_json TEXT NOT NULL,
                FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS readers (
                id TEXT PRIMARY KEY,
                device_id TEXT,
                location TEXT,
                source TEXT,
                firmware_version TEXT,
                identity_mode TEXT,
                device_ip TEXT,
                wifi_rssi INTEGER,
                pending_offline_logs INTEGER,
                online INTEGER,
                last_seen_at TEXT,
                created_at TEXT,
                attendance_close_status_json TEXT,
                raw_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS display_commands (
                id TEXT PRIMARY KEY,
                device_id TEXT,
                command TEXT,
                fingerprint_id INTEGER,
                status TEXT,
                created_at TEXT,
                expires_at TEXT,
                delivered_at TEXT,
                acknowledged_at TEXT,
                payload_json TEXT,
                device_display_json TEXT,
                raw_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS manual_statuses (
                id TEXT PRIMARY KEY,
                employee_id TEXT,
                date_key TEXT,
                status TEXT,
                created_at TEXT,
                raw_json TEXT NOT NULL,
                FOREIGN KEY (employee_id) REFERENCES employees(id) ON DELETE SET NULL
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS state_snapshots (
                state_key TEXT PRIMARY KEY,
                schema_version INTEGER NOT NULL,
                state_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_attendance_employee_date
                ON attendance(employee_id, date_key);
            CREATE INDEX IF NOT EXISTS idx_attendance_fingerprint
                ON attendance(fingerprint_id);
        """)


def _json(value: object) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def backup_database() -> Path | None:
    if not DB_PATH.exists():
        return None
    timestamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup_path = DB_PATH.with_name(f"attendance.before-json-import-{timestamp}.db")
    shutil.copy2(DB_PATH, backup_path)
    return backup_path


def import_json_database(json_path: Path = JSON_DB_PATH, make_backup: bool = True) -> dict[str, int | str | None]:
    """Replace SQLite contents with an exact mirror of data/db.json."""
    source = json.loads(json_path.read_text(encoding="utf-8"))
    backup = backup_database() if make_backup else None
    init_db(reset=True)

    with db_cursor() as cur:
        for employee in source.get("employees", []):
            cur.execute("""
                INSERT INTO employees VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                employee["id"], employee.get("fullName", ""), employee.get("fingerprintId"),
                employee.get("shiftStart", ""), employee.get("shiftEnd", ""),
                employee.get("graceMinutes", 0), int(employee.get("active", True)),
                employee.get("createdAt"), employee.get("updatedAt"), _json(employee),
            ))
            for fingerprint in employee.get("fingerprints", []):
                cur.execute("""
                    INSERT INTO employee_fingerprints VALUES (?, ?, ?, ?, ?, ?, ?)
                """, (
                    employee["id"], fingerprint["fingerprintId"], fingerprint.get("label"),
                    fingerprint.get("deviceId"), int(fingerprint.get("active", True)),
                    fingerprint.get("createdAt"), _json(fingerprint),
                ))
            for day_name, schedule in employee.get("weeklySchedule", {}).items():
                cur.execute("""
                    INSERT INTO weekly_schedules VALUES (?, ?, ?, ?, ?, ?)
                """, (
                    employee["id"], day_name, int(schedule.get("dayOff", False)),
                    schedule.get("timeIn"), schedule.get("timeOut"), _json(schedule),
                ))

        for record in source.get("attendance", []):
            cur.execute("""
                INSERT INTO attendance (
                    id, event_id, employee_id, full_name, fingerprint_id,
                    fingerprint_confidence, attendance_type, accepted, code,
                    status_text, punctuality, late_minutes, early_out_minutes,
                    paid_hours, scanned_at, original_scanned_at, date_key,
                    display_time, display_date_time, device_id, location, source,
                    firmware_version, device_ip, wifi_rssi, created_at, raw_json
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """, (
                record["id"], record.get("eventId"), record.get("employeeId") or None,
                record.get("fullName"), record.get("fingerprintId"),
                record.get("fingerprintConfidence"), record.get("attendanceType"),
                int(record.get("accepted", False)), record.get("code"), record.get("statusText"),
                record.get("punctuality"), record.get("lateMinutes"), record.get("earlyOutMinutes"),
                record.get("paidHours"), record.get("scannedAt"), record.get("originalScannedAt"),
                record.get("dateKey"), record.get("displayTime"), record.get("displayDateTime"),
                record.get("deviceId"), record.get("location"), record.get("source"),
                record.get("firmwareVersion"), record.get("deviceIp"), record.get("wifiRssi"),
                record.get("createdAt"), _json(record),
            ))

        for request in source.get("enrollmentRequests", []):
            cur.execute("INSERT INTO enrollment_requests VALUES (?,?,?,?,?,?,?,?,?,?,?)", (
                request["id"], request.get("employeeId") or None, request.get("fingerprintId"),
                request.get("status"), request.get("requestedAction"), request.get("deviceId"),
                request.get("source"), request.get("enrolledAt"), request.get("createdAt"),
                request.get("updatedAt"), _json(request),
            ))

        for reader in source.get("readers", []):
            cur.execute("INSERT INTO readers VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)", (
                reader["id"], reader.get("deviceId"), reader.get("location"), reader.get("source"),
                reader.get("firmwareVersion"), reader.get("identityMode"), reader.get("deviceIp"),
                reader.get("wifiRssi"), reader.get("pendingOfflineLogs"),
                int(reader.get("online", False)), reader.get("lastSeenAt"), reader.get("createdAt"),
                _json(reader.get("attendanceCloseStatus")), _json(reader),
            ))

        for command in source.get("displayCommands", []):
            cur.execute("INSERT INTO display_commands VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", (
                command["id"], command.get("deviceId"), command.get("command"),
                command.get("fingerprintId"), command.get("status"), command.get("createdAt"),
                command.get("expiresAt"), command.get("deliveredAt"), command.get("acknowledgedAt"),
                _json(command.get("payload")), _json(command.get("deviceDisplay")), _json(command),
            ))

        for status in source.get("manualStatuses", []):
            cur.execute("INSERT INTO manual_statuses VALUES (?,?,?,?,?,?)", (
                status["id"], status.get("employeeId") or None,
                status.get("dateKey") or status.get("attendanceDate"),
                status.get("status"), status.get("createdAt"), _json(status),
            ))

        cur.executemany("INSERT INTO settings VALUES (?, ?)",
                        [(key, _json(value)) for key, value in source.get("settings", {}).items()])
        cur.executemany("INSERT INTO metadata VALUES (?, ?)",
                        [(key, _json(value)) for key, value in source.get("meta", {}).items()])
        cur.execute("INSERT INTO state_snapshots VALUES (?, ?, ?, ?)", (
            "primary", int(source.get("meta", {}).get("schemaVersion", 1)),
            _json(source), datetime.now().isoformat(timespec="seconds"),
        ))

    counts = {
        "employees": len(source.get("employees", [])),
        "attendance": len(source.get("attendance", [])),
        "enrollment_requests": len(source.get("enrollmentRequests", [])),
        "readers": len(source.get("readers", [])),
        "display_commands": len(source.get("displayCommands", [])),
        "manual_statuses": len(source.get("manualStatuses", [])),
        "backup": str(backup) if backup else None,
    }
    return counts


if __name__ == "__main__":
    print(json.dumps(import_json_database(), indent=2))
