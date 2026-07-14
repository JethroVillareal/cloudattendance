# Hybrid database setup

The server uses PostgreSQL as the primary store when PostgreSQL connection
variables are configured. Every saved state is also written atomically to
`data/db.json` and synchronized to `attendance.db`. If PostgreSQL cannot be
reached during startup, the newest local state is loaded from SQLite or JSON.

## Enable PostgreSQL primary storage

1. Install PostgreSQL and create a database named `gms_attendance`.
2. Copy `.env.example` to `.env`.
3. Set `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and `PGPASSWORD` in `.env`.
   `DATABASE_URL` can be used instead of the separate `PG*` variables.
4. Start the app with `npm start`.
5. Open `http://localhost:3000/health` and confirm:
   `storage.activePrimary` is `postgresql`, `postgresql` is `connected`, and
   `sqliteBackup` is `synced` or `ready`.

The PostgreSQL table is created automatically from `postgres-schema.sql`. On
the first connection, the current local database is imported. On later starts,
the PostgreSQL state is loaded as authoritative.

## Maintenance

- `npm run db:sqlite:sync` rebuilds SQLite without creating another backup.
- `npm run db:sqlite:backup` backs up the existing SQLite file, then rebuilds it.
- `npm run check` validates the Node.js server and storage code.
- PostgreSQL automatically retains the latest 100 `app_state_history` snapshots.
- `employee_records`, `attendance_records`, and `reader_records` provide indexed relational reporting projections while `app_state` remains the compatibility source for the existing dashboard and ESP32 workflow.
- Keep scheduled `pg_dump` copies on another disk or machine; synchronized SQLite is a fallback, not off-machine disaster recovery.

Do not commit `.env`; it may contain the PostgreSQL password and API key.
