# GMS Attendance Server - Firewall Diagnostic and Fix
# Right-click -> "Run with PowerShell" (as Administrator)

param()

$ErrorActionPreference = 'Stop'

function Write-Step($text) {
    Write-Host ""
    Write-Host ">>> $text" -ForegroundColor Cyan
}

function Write-Ok($text) {
    Write-Host "[OK] $text" -ForegroundColor Green
}

function Write-Fail($text) {
    Write-Host "[FAIL] $text" -ForegroundColor Red
}

function Write-Warn($text) {
    Write-Host "[WARN] $text" -ForegroundColor Yellow
}

# Check admin
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Fail "This script must be run as Administrator. Right-click -> Run with PowerShell."
    pause
    exit 1
}
Write-Ok "Running as Administrator"

# Detect IPs
Write-Step "Detecting local IPv4 addresses"
$ips = @()
$profiles = Get-NetIPAddress -AddressFamily IPv4 -InterfaceAlias "Wi-Fi" -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -ne "127.0.0.1" }
foreach ($p in $profiles) { $ips += $p.IPAddress }
if (-not $ips) {
    $profiles = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -ne "127.0.0.1" -and $_.PrefixOrigin -ne "WellKnown" }
    foreach ($p in $profiles) { $ips += $p.IPAddress }
}
if ($ips) {
    $ips | ForEach-Object { Write-Ok "PC IP: $_" }
} else {
    Write-Warn "Could not detect local IP. Run ipconfig to find it."
}

# Check network profile
Write-Step "Checking WiFi network profile"
$profile = Get-NetConnectionProfile -InterfaceAlias "Wi-Fi" -ErrorAction SilentlyContinue
if ($profile) {
    Write-Host "WiFi: $($profile.Name)" -ForegroundColor White
    Write-Host "Category: $($profile.NetworkCategory)" -ForegroundColor White
    if ($profile.NetworkCategory -eq "Public") {
        Write-Warn "Network is Public. Consider switching to Private for better firewall rule application."
    }
}

# Check if server is listening
Write-Step "Checking if server is listening on port 3000"
$listening = netstat -ano | Select-String ":3000.*LISTENING"
if ($listening) {
    Write-Ok "Server is listening on port 3000:"
    $listening | ForEach-Object { Write-Host "  $_" -ForegroundColor Green }
} else {
    Write-Fail "No process is listening on port 3000. Start the server first (start-server.bat)."
}

# Check existing rules
Write-Step "Checking existing firewall rules for port 3000"
$ruleNames = @("GMS Attendance Server Port 3000", "GMS Attendance Port 3000", "Allow Port 3000")
$foundRules = @()
foreach ($name in $ruleNames) {
    $rule = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
    if ($rule) {
        $foundRules += $name
        Write-Host "Found rule: $name" -ForegroundColor Yellow
        $rule | Format-Table DisplayName, Direction, Action, Profile, Enabled -AutoSize
    }
}

if (-not $foundRules) {
    Write-Warn "No GMS/Attendance/3000 allow rules found."
}

# Remove old rules
Write-Step "Removing old rules"
foreach ($name in $ruleNames) {
    $rule = Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
    if ($rule) {
        Remove-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue
        Write-Ok "Removed: $name"
    }
}

# Remove any block rules for port 3000
$allRules = Get-NetFirewallRule -ErrorAction SilentlyContinue
foreach ($rule in $allRules) {
    $portFilter = $rule | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue
    if ($portFilter -and $portFilter.Protocol -eq "TCP" -and $portFilter.LocalPort -eq 3000) {
        if ($rule.Action -eq "Block") {
            Write-Warn "Removing block rule: $($rule.DisplayName)"
            Remove-NetFirewallRule -AssociatedNetFirewallPortFilter $portFilter -ErrorAction SilentlyContinue
            Write-Ok "Removed block rule."
        }
    }
}

# Create new allow rule
Write-Step "Creating firewall allow rule for port 3000"
try {
    New-NetFirewallRule `
        -DisplayName "GMS Attendance Server Port 3000" `
        -Direction Inbound `
        -Protocol TCP `
        -LocalPort 3000 `
        -Action Allow `
        -Profile Any `
        -Description "Allows ESP32 and LAN devices to reach the GMS Attendance Node.js server on port 3000." `
        -ErrorAction Stop
    Write-Ok "Firewall rule created successfully."
} catch {
    Write-Fail "Failed to create firewall rule: $_"
}

# Verify rule
Write-Step "Verifying rule"
$verifyRule = Get-NetFirewallRule -DisplayName "GMS Attendance Server Port 3000" -ErrorAction SilentlyContinue
if ($verifyRule) {
    $verifyPort = $verifyRule | Get-NetFirewallPortFilter -ErrorAction SilentlyContinue
    $verifyProfile = $verifyRule | Get-NetFirewallAddressFilter -ErrorAction SilentlyContinue
    Write-Ok "Rule verified:"
    $verifyRule | Format-Table DisplayName, Direction, Action, Profile, Enabled -AutoSize
    if ($verifyPort) {
        Write-Host "  Port: $($verifyPort.Protocol) / $($verifyPort.LocalPort)" -ForegroundColor Green
    }
} else {
    Write-Fail "Rule verification failed."
}

# Summary
Write-Step "Summary"
Write-Host ""
if ($ips) {
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
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "1. Make sure the server is running (start-server.bat)" -ForegroundColor White
Write-Host "2. Test from phone: http://<PC-IP>:3000/api/health" -ForegroundColor White
Write-Host "3. If still blocked, check router AP/Client Isolation settings." -ForegroundColor White
Write-Host ""
pause
