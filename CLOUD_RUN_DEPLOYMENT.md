# Google Cloud Run deployment

Cloud Run hosts the Node.js server and dashboard. Supabase PostgreSQL remains
the permanent database. The service is configured to scale to zero and to use
at most one instance because this application persists a complete state
snapshot; multiple writers could otherwise overwrite each other's changes.

## Requirements

- A Google Cloud project with billing enabled. Cloud Run has a monthly free
  tier, but Google Cloud still requires a billing account.
- The Supabase `DATABASE_URL` already verified by the local migration.
- Never upload `.env`; `.dockerignore` excludes it from the container build.
- Local `data/db.json` is also excluded. Cloud Run loads the already-migrated
  state only from Supabase.

## Recommended console deployment

1. Open Google Cloud Console and select or create a project.
2. Enable **Cloud Run Admin API** and **Cloud Build API**.
3. Open **Cloud Run > Deploy container > Service > Continuously deploy from a
   repository** or use the inline source deployment workflow.
4. Use service name `gms-attendance-server` and region
   `asia-southeast1` (Singapore).
5. Allow unauthenticated access. Application API routes still require the
   server's own login/session or device key.
6. Container settings:
   - Memory: `512 MiB`
   - CPU: `1`
   - Request timeout: `300 seconds`
   - Minimum instances: `0`
   - Maximum instances: `1`
   - Concurrency: `20`
7. Add non-secret environment variables:

```text
NODE_ENV=production
CLOUD_MODE=true
SQLITE_BACKUP_ENABLED=false
PGSSL=true
TRUST_PROXY=true
DEVICE_TIMEZONE=Asia/Manila
SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
SUPABASE_EMPLOYEE_PHOTOS_BUCKET=employee-photos
```

8. Add these as Secret Manager-backed environment variables:

```text
DATABASE_URL
API_KEY
ADMIN_PASSWORD
EMERGENCY_ATTENDANCE_PASSWORD
SUPABASE_SERVICE_ROLE_KEY
```

Add `ADMIN_USERNAME=admin` as a normal environment variable. Add HR, Viewer,
and per-device credentials only when needed.

## CLI deployment after installing Google Cloud CLI

Authenticate and select the project:

```powershell
gcloud auth login
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
```

Create the four secrets in Secret Manager through the Google Cloud Console.
Then deploy from the project root:

```powershell
gcloud run deploy gms-attendance-server --source . --region asia-southeast1 --allow-unauthenticated --memory 512Mi --cpu 1 --min 0 --max 1 --concurrency 20 --timeout 300 --set-env-vars "NODE_ENV=production,CLOUD_MODE=true,SQLITE_BACKUP_ENABLED=false,PGSSL=true,TRUST_PROXY=true,DEVICE_TIMEZONE=Asia/Manila,ADMIN_USERNAME=admin" --set-secrets "DATABASE_URL=gms-database-url:latest,API_KEY=gms-api-key:latest,ADMIN_PASSWORD=gms-admin-password:latest,EMERGENCY_ATTENDANCE_PASSWORD=gms-emergency-password:latest"
```

The Cloud Run service account must have **Secret Manager Secret Accessor** for
those secrets.

## Verification

After deployment, Cloud Run provides an HTTPS service URL. Verify:

```text
https://YOUR-CLOUD-RUN-URL/health
https://YOUR-CLOUD-RUN-URL/
```

`/health` must report `activePrimary: postgresql` and
`postgresql: connected`. Log in and confirm 10 employees and the existing
attendance records. Test again from mobile data with the local Node process
stopped. Only then replace the ESP32 `API_URL` with the Cloud Run HTTPS scan
endpoint and reflash the device.
