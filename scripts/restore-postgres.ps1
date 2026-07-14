param(
  [string]$BackupFile,
  [switch]$Apply
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'
if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
      [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
    }
  }
}

$pgRestore = (Get-Command pg_restore -ErrorAction SilentlyContinue).Source
if (-not $pgRestore) {
  $pgRestore = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\pg_restore.exe' -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $pgRestore) { throw 'pg_restore was not found. Add the PostgreSQL bin directory to PATH.' }
if (-not $BackupFile) {
  $BackupFile = Get-ChildItem (Join-Path $root 'backups\*.dump') -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $BackupFile -or -not (Test-Path -LiteralPath $BackupFile)) { throw 'No PostgreSQL backup file was found.' }

& $pgRestore --list $BackupFile | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Backup validation failed.' }
Write-Output "Backup is valid: $BackupFile"
if (-not $Apply) {
  Write-Output 'Validation only. Pass -Apply to perform a destructive database restore.'
  exit 0
}

& $pgRestore --clean --if-exists --no-owner --host=$env:PGHOST --port=$env:PGPORT --username=$env:PGUSER --dbname=$env:PGDATABASE $BackupFile
if ($LASTEXITCODE -ne 0) { throw "Restore failed with exit code $LASTEXITCODE" }
Write-Output 'PostgreSQL restore completed. Restart the attendance server before use.'
