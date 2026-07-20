# GMS Attendance Server - Fix Firewall for LAN Access
# Right-click -> "Run with PowerShell" (as Administrator)

Write-Host ""
Write-Host "=== GMS Attendance Server Firewall Fix ===" -ForegroundColor Cyan
Write-Host ""

# Remove old rule if exists
$old = Get-NetFirewallRule -DisplayName "GMS Attendance Server Port 3000" -ErrorAction SilentlyContinue
if ($old) {
    Remove-NetFirewallRule -DisplayName "GMS Attendance Server Port 3000"
    Write-Host "Removed old rule." -ForegroundColor Yellow
}

# Add new rule covering ALL profiles (Domain, Private, Public)
New-NetFirewallRule `
    -DisplayName "GMS Attendance Server Port 3000" `
    -Direction Inbound `
    -Protocol TCP `
    -LocalPort 3000 `
    -Action Allow `
    -Profile Any `
    -Description "Allows ESP32 and LAN devices to reach the GMS Attendance Node.js server on port 3000."

Write-Host ""
Write-Host "Firewall rule added for ALL profiles (Domain, Private, Public)." -ForegroundColor Green
Write-Host ""

# Show current WiFi network category
$profile = Get-NetConnectionProfile -InterfaceAlias "Wi-Fi" -ErrorAction SilentlyContinue
if ($profile) {
    Write-Host "Current WiFi: $($profile.Name)" -ForegroundColor White
    Write-Host "Network Category: $($profile.NetworkCategory)" -ForegroundColor White
}

Write-Host ""
Write-Host "PC IP: 192.168.100.61" -ForegroundColor Green
Write-Host "Test from phone: http://192.168.100.61:3000/api/health" -ForegroundColor Green
Write-Host "ESP32 URL:       http://192.168.100.61:3000/api/attendance/scan" -ForegroundColor Green
Write-Host ""
pause
