# Free cloud test deployment

This project is prepared for a Render Free web service backed by a Supabase
Free PostgreSQL database. PostgreSQL is the only persistent source of truth in
cloud mode. The cloud process refuses to start without `DATABASE_URL` instead
of silently writing records to Render's ephemeral filesystem.

## 1. Create the Supabase database

1. Create a free Supabase project in the Singapore region when available.
2. Open **Project Settings > Database > Connect**.
3. Copy the **Session pooler** PostgreSQL URI. The pooler is preferred when the
   deployment host requires IPv4.
4. Replace the password placeholder in that URI with the database password.
5. Keep the complete URI private. It becomes Render's `DATABASE_URL`.
6. Open **Storage**, create a public bucket named `employee-photos`, then copy
   the project URL and service-role key from **Project Settings > API**. The
   service-role key belongs only on the server and is required for photo uploads.

Tables are created automatically during the first successful server startup.
If `app_state` is empty, the tracked `data/db.json` is imported once. Later
deployments always load the existing Supabase state and do not overwrite it
with the bundled JSON file.

## 2. Put the project in a private GitHub repository

Do not commit `.env`, `.pgpass`, logs, backups, or database files. The existing
`.gitignore` excludes the secret `.env`. Use a private repository because the
ESP32 sketch can contain Wi-Fi and device credentials.

## 3. Create the Render service

1. In Render, create a **Blueprint** from the private GitHub repository.
2. Render reads `render.yaml` and asks for each `sync: false` value.
3. Enter these required secrets:
   - `DATABASE_URL`: Supabase Session pooler URI
   - `SUPABASE_URL`: project URL such as `https://PROJECT-REF.supabase.co`
   - `SUPABASE_SERVICE_ROLE_KEY`: server-only key used for Storage uploads
   - `API_KEY`: the same device/server key used by the ESP32, at least 16 chars
   - `ADMIN_PASSWORD`: dashboard administrator password
   - `EMERGENCY_ATTENDANCE_PASSWORD`: separate emergency-operation password
   The Blueprint already sets `SUPABASE_EMPLOYEE_PHOTOS_BUCKET` to
   `employee-photos`.
4. Optional credentials may be left blank if those roles are not needed.
5. Wait until `/health` reports `storage.activePrimary: postgresql` and
   `storage.postgresql: connected`.

Never put Supabase's service-role key or database password in the ESP32. The
ESP32 communicates only with the Render HTTPS API.

## 4. Verify before changing firmware

Open these from a phone using mobile data or another internet connection:

```text
https://YOUR-SERVICE.onrender.com/health
https://YOUR-SERVICE.onrender.com/
```

Confirm the dashboard records match the local records. Then stop the local
Node server and repeat the test. Only after this succeeds should the ESP32 API
URL be changed to:

```cpp
const char* API_URL =
    "https://YOUR-SERVICE.onrender.com/api/attendance/scan";
```

Reflash the ESP32 and make one controlled attendance scan. Free Render services
can take roughly a minute to wake after being idle, so the firmware's offline
queue and retry path must remain enabled.

## Rollback

Keep the current local `.env`, `data/db.json`, and ESP32 firmware until the
cloud test is complete. To roll back, restore the local API URL in the sketch
and start the local Node server; the cloud database remains untouched.
