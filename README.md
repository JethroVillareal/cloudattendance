# GMS Attendance Server with Time Card

This is a Windows-friendly Node.js server for the ESP32-S3 R503 attendance device.
Run `npm install` once to install the PostgreSQL client dependency.

## Run

1. Install Node.js LTS.
2. Extract this folder.
3. Double-click `start-server.bat`.
4. Open `http://localhost:3000`.

## Security and production operation

- Configure a unique `API_KEY` with at least 16 characters. The server refuses to start with a missing or placeholder key.
- The browser exchanges the key for an HttpOnly, SameSite session cookie. ESP32 readers continue to use the `X-API-Key` header.
- URL query-string keys are rejected and startup logs never print the secret.
- Every `/api/*` endpoint requires authentication except `POST /api/auth/login`; `/health` remains public for monitoring.
- Configure exact dashboard origins with `ALLOWED_ORIGINS` when using a hostname or reverse proxy.
- Configure a separate `EMERGENCY_ATTENDANCE_PASSWORD`; emergency attendance is disabled when it is missing.
- Destructive `/api/testing/*` routes are disabled unless `ENABLE_TEST_ENDPOINTS=true`.
- Security audit-trail persistence is disabled to prevent continuous audit-data growth. Attendance logs remain available in the normal Logs module.
- PostgreSQL retains the latest 100 point-in-time snapshots in `app_state_history`.
- Use HTTPS before exposing the server outside a trusted LAN.
- Optional named accounts are configured with `ADMIN_*`, `HR_*`, and `VIEWER_*`. Admin has full access, HR can manage employees and attendance, and Viewer is read-only.
- Optional `DEVICE_API_KEYS` assigns separate keys per `X-Device-ID`; the global key remains available during firmware migration.
- `deploy/Caddyfile.example` is a production HTTPS reverse-proxy template. Set `TRUST_PROXY=true` and the real HTTPS origin in `ALLOWED_ORIGINS` when deploying it.

Validate changes with `npm.cmd run check` and `npm.cmd test`.

For a free Render + Supabase test deployment, follow
[`CLOUD_DEPLOYMENT.md`](CLOUD_DEPLOYMENT.md). Cloud mode requires PostgreSQL,
disables SQLite synchronization, stores audit records in PostgreSQL, and
refuses an unsafe ephemeral-storage fallback.

For Google Cloud Run backed by the same Supabase database, follow
[`CLOUD_RUN_DEPLOYMENT.md`](CLOUD_RUN_DEPLOYMENT.md). The included `Dockerfile`
runs as a non-root user, respects Cloud Run's injected `PORT`, and never copies
`.env` into the container image.

Create a PostgreSQL and JSON backup with `npm.cmd run db:postgres:backup`. Validate the newest dump with `npm.cmd run db:postgres:restore:validate`. Installing `scripts/install-backup-task.ps1` from an elevated PowerShell schedules a daily 2:00 AM backup.

## SQLite database mirror

The Python SQLite database is stored in `attendance.db` and mirrors the real
employees, fingerprints, weekly schedules, attendance, readers, commands, and
settings from `data/db.json`. Synchronize it by running:

```powershell
python seed.py
```

The command backs up the previous SQLite file before replacing its records.
The live Node.js/ESP32 server still writes to `data/db.json`; run the command
again whenever you want to refresh the SQLite mirror.

## LAN Access and Dual-Band WiFi Setup

The ESP32-S3 only supports **2.4 GHz WiFi**. Your computer/server may be connected to a **5 GHz** WiFi network. As long as both devices are connected to the **same dual-band router** and **client isolation is disabled**, they can communicate freely over the LAN regardless of which frequency band each device uses.

### Server configuration (already done)

The Node.js server binds to `0.0.0.0` and exposes:

- `GET /api/health` - public health check
- `POST /api/attendance/scan` - ESP32 scan endpoint
- Other authenticated `/api/*` endpoints

Start the server with `start-server.bat` or `npm start`. The console will print your PC's local IPv4 addresses.

### Router settings

1. **Disable AP Isolation / Client Isolation / Guest Network Isolation / Device Isolation** in your router admin panel. This is the most common cause of "same WiFi but cannot communicate" issues.
2. Ensure both the ESP32 and your PC are on the same LAN subnet (e.g., `192.168.1.x` or `192.168.100.x`).
3. If your router has separate SSIDs for 2.4 GHz and 5 GHz, make sure both are bridged to the same LAN (most consumer routers do this by default).

### Windows Firewall

Allow inbound TCP port 3000 for Domain, Private, and Public profiles. Run the included script as Administrator:

```powershell
.\allow-port-3000.ps1
```

Or manually:

```powershell
New-NetFirewallRule -DisplayName "GMS Attendance Port 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Any
```

### ESP32 firmware configuration

Edit `arduino/gms_attendance_esp32s3/secrets.h`:

```cpp
// Connect to the 2.4 GHz SSID only
const char* WIFI_SSID = "YOUR-2.4G-SSID";
const char* WIFI_PASSWORD = "YOUR-2.4G-PASSWORD";

// Use your PC's local IPv4 address (not localhost, not 127.0.0.1)
const char* SERVER_URL = "http://192.168.1.10:3000";
```

**Avoid hardcoding a dynamic IP if possible.** Use one of these instead:

- **DHCP reservation** in your router: assign a fixed IP to your PC's MAC address.
- **Static local IP** on your PC's WiFi adapter.
- **mDNS hostname** (if your router and ESP32 core support it): `http://gms-pc.local:3000`

### Test from another phone

On a phone connected to the same WiFi (2.4 GHz or 5 GHz), open:

```
http://192.168.1.10:3000/api/health
```

Expected response:

```json
{"status":"online"}
```

If this works but the ESP32 cannot connect, check:
1. ESP32 is connected to the 2.4 GHz SSID (not 5 GHz).
2. Client isolation is disabled.
3. Windows Firewall allows port 3000.
4. `SERVER_URL` in `secrets.h` matches the server IP shown by `start-server.bat`.

## ESP32 MicroSD Offline Storage

The firmware uses a MicroSD Module over SPI as the primary offline queue
storage. If the SD card is missing or cannot mount, it falls back to LittleFS.

Default wiring in `arduino/gms_attendance_esp32s3/gms_attendance_esp32s3.ino`:

```text
MicroSD VCC  -> ESP32-S3 3.3V
MicroSD GND  -> ESP32-S3 GND
MicroSD SCK  -> GPIO12
MicroSD MISO -> GPIO13
MicroSD MOSI -> GPIO11
MicroSD CS   -> GPIO14
```

Use a FAT32-formatted card. Offline attendance is saved to
`/pending.ndjson`; pending enrollment notifications are saved to
`/enroll_pending.ndjson`.

## New features

- Pending fingerprint registration modal.
- Employee weekly schedule like Sunday to Saturday.
- Day off per day.
- Time In and Time Out schedule per day.
- Grace minutes.
- Time Card page/table.
- Server computes Time In, Time Out, Late, Early Out, Present, Absent, Day Off.
- ESP32 can save offline scans to MicroSD and sync them later.
- ESP32 OLED responses include a `deviceDisplay` object for title, lines, LED color, beep, and duration.
- ESP32 can poll queued server display commands.
- Multiple fingerprints per employee with per-fingerprint delete.
- Device heartbeat monitoring with online/offline status, RSSI, IP, firmware, and pending offline logs.
- Dashboard cards for present, late, absent, excused, pending sync, devices, registrations, and emergency logs.
- Settings page for branch, shifts, duplicate delay, paid hours, breaks, early-out protection, alarms, display duration, and API key.
- Time Card filters, CSV export, printable PDF flow, and client-side PNG image export.
- Manual absence/excuse/leave/day-off/no-schedule statuses.
- Early-out protection using required paid hours excluding lunch.
- Auto-cleanup for not-recorded attendance logs so rejected/duplicate scans do not fill storage.

## Server logic

The ESP32 sends `fingerprintId`, `scannedAt`, and confidence.
The server decides the attendance result using the employee weekly schedule.

If server is offline, the ESP32 should save the original scan time offline.
When the server comes back, it will compute late/on-time using that original `scannedAt`, not the sync time.

Not-recorded logs such as unregistered fingerprints, duplicates, denied time-outs, and already-complete scans are kept only for recent troubleshooting. By default the server keeps them for 24 hours and caps them at 50 records. You can adjust this with `UNRECORDED_LOG_RETENTION_HOURS` and `MAX_UNRECORDED_ATTENDANCE_LOGS`.

## Dashboard APIs

- `GET /api/settings`
- `POST /api/settings`
- `GET /api/dashboard/summary`
- `GET /api/readers`
- `POST /api/fingerprints/start-enrollment`
- `POST /api/employees/:employeeId/fingerprints`
- `DELETE /api/employees/:employeeId/fingerprints/:fingerprintId`
- `POST /api/timecard/manual-status`
- `POST /api/admin/emergency-attendance`
- `GET /api/timecard`
- `GET /api/timecard/export/csv`
- `GET /api/timecard/export/pdf`
- `GET /api/timecard/export/png`

## ESP32 OLED display commands

Attendance scan and enrollment responses now include:

```json
{
  "deviceDisplay": {
    "topStatus": "ONLINE CONNECTED",
    "title": "TIME IN RECORDED",
    "line1": "AIRINE R. SOSA",
    "line2": "09:03 AM",
    "line3": "LATE 3 MIN",
    "color": "GREEN",
    "beep": "SUCCESS",
    "durationMs": 3000
  }
}
```

Queue a server-to-device OLED command:

```http
POST /api/devices/display-command
X-API-Key: YOUR_DEVICE_API_KEY
Content-Type: application/json
```

```json
{
  "deviceId": "ATTENDANCE-DEVICE-01",
  "command": "SHOW_MESSAGE",
  "deviceDisplay": {
    "title": "LUNCH BREAK",
    "line1": "12:00 PM - 1:00 PM",
    "line2": "Break started",
    "line3": "",
    "color": "BLUE",
    "beep": "NOTICE",
    "durationMs": 5000
  }
}
```

ESP32 polls for the next command:

```http
GET /api/devices/display-command?deviceId=ATTENDANCE-DEVICE-01
X-API-Key: YOUR_DEVICE_API_KEY
```

The server returns one pending command once. If there is no command, it returns `hasCommand: false`, so the ESP32 should keep the simple idle screen:

```text
ONLINE CONNECTED
09:03 AM
SCAN FINGERPRINT
```

Supported colors are `BLUE`, `GREEN`, `PURPLE`, `YELLOW`, and `RED`. Supported beep types are `NONE`, `SUCCESS`, `ERROR`, `NOTICE`, and `WARNING`.
