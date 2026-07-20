# GMS Attendance Server - Fix Firewall for LAN Access
# Right-click -> "Run with PowerShell" (as Administrator)

$ErrorActionPreference = 'Stop'

function Write-Ok($text) {
    Write-Host "[OK] $text" -ForegroundColor Green
}

function Write-Warn($text) {
    Write-Host "[WARN] $text" -ForegroundColor Yellow
}

# Check admin
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host ""
    Write-Host "ERROR: This script must be run as Administrator." -ForegroundColor Red
    Write-Host "Right-click -> Run with PowerShell" -ForegroundColor Yellow
    Write-Host ""
    pause
    exit 1
}

Write-Host ""
Write-Host "=== GMS Attendance Server Firewall Fix ===" -ForegroundColor Cyan
Write-Host ""

# Detect current IPv4 addresses
$ips = @()
$profiles = Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias "Wi-Fi" -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -ne "127.0.0.1" }
foreach ($p in $profiles) { $ips += $p.IPAddress }
if (-not $ips) {
    $profiles = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -ne "127.0.0.1" -and $_.PrefixOrigin -ne "WellKnown" }
    foreach ($p in $profiles) { $ips += $p.IPAddress }
}

# Remove old rule if exists
$old = Get-NetFirewallRule -DisplayName "GMS Attendance Server Port 3000" -ErrorAction SilentlyContinue
if ($old) {
    Remove-NetFirewallRule -DisplayName "GMS Attendance Server Port 3000"
    Write-Host "Removed old rule." -ForegroundColor Yellow
}

# Check for conflicting block rules
$allRules = Get-NetFirewallRule -ErrorAction SilentlyContinue
foreach ($rule in $allRules) {
    $portFilter = $rule | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue
    if ($portFilter -and $portFilter.Protocol -eq "TCP" -and $portFilter.LocalPort -eq 3000 -and $rule.Action -eq "Block") {
        Write-Warn "Found conflicting block rule: $($rule.DisplayName). Removing it..."
        Remove-NetFirewallRule -AssociatedNetFirewallPortFilter $portFilter -ErrorAction SilentlyContinue
        Write-Ok "Removed block rule."
    }
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

# Verify rule
$verifyRule = Get-NetFirewallRule -DisplayName "GMS Attendance Server Port 3000" -ErrorAction SilentlyContinue
if ($verifyRule) {
    Write-Ok "Rule verified."
} else {
    Write-Fail "Rule verification failed. Try running PowerShell as Administrator."
}

# Show current WiFi network category
$profile = Get-NetConnectionProfile -InterfaceAlias "Wi-Fi" -ErrorAction SilentlyContinue
if ($profile) {
    Write-Host "Current WiFi: $($profile.Name)" -ForegroundColor White
    Write-Host "Network Category: $($profile.NetworkCategory)" -ForegroundColor White
}

Write-Host ""
if ($ips.Count -gt 0) {
    foreach ($ip in $ips) {
        Write-Host "PC IP: $ip" -ForegroundColor Green
        Write-Host "Test from phone: http://$ip`:3000/api/health" -ForegroundColor Green
        Write-Host "ESP32 URL:       http://$ip`:3000/api/attendance/scan" -ForegroundColor Green
        Write-Host ""
    }
} else {
    Write-Host "Could not detect local IP. Run ipconfig to find it." -ForegroundColor Yellow
}
Write-Host ""
pause
