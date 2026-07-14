$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$backupDir = Join-Path $root 'backups'
$envFile = Join-Path $root '.env'

if (Test-Path $envFile) {
  Get-Content $envFile | ForEach-Object {
    if ($_ -match '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
      [Environment]::SetEnvironmentVariable($matches[1], $matches[2], 'Process')
    }
  }
}

New-Item -ItemType Directory -Path $backupDir -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dumpPath = Join-Path $backupDir "gms-attendance-$stamp.dump"
$jsonPath = Join-Path $backupDir "db-$stamp.json"
$pgDump = (Get-Command pg_dump -ErrorAction SilentlyContinue).Source
if (-not $pgDump) {
  $pgDump = Get-ChildItem 'C:\Program Files\PostgreSQL\*\bin\pg_dump.exe' -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $pgDump) { throw 'pg_dump was not found. Add the PostgreSQL bin directory to PATH.' }

& $pgDump --format=custom --file=$dumpPath --host=$env:PGHOST --port=$env:PGPORT --username=$env:PGUSER $env:PGDATABASE
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit code $LASTEXITCODE" }
Copy-Item -LiteralPath (Join-Path $root 'data\db.json') -Destination $jsonPath

Get-ChildItem -LiteralPath $backupDir -File | Where-Object LastWriteTime -lt (Get-Date).AddDays(-30) | Remove-Item -Force
Write-Output "Backup created: $dumpPath"
Write-Output "JSON safety copy: $jsonPath"
