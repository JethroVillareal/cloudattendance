$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $PSScriptRoot 'backup-postgres.ps1'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$script`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Daily -At '2:00 AM'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName 'GMS Attendance PostgreSQL Backup' -Action $action -Trigger $trigger -Settings $settings -Description 'Daily GMS attendance PostgreSQL and JSON backup' -Force
Write-Output 'Daily 2:00 AM backup task installed.'
