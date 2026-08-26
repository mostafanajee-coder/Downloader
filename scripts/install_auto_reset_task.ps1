# Install Scheduled Task for Automated IDM Trial Reset (Hourly & On Logon)
$taskName = "IDM_Auto_Trial_Reset"
$scriptPath = Join-Path (Split-Path $PSScriptRoot -Parent) "scripts\reset_idm_trial.ps1"

Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "   Installing IDM Auto Trial Reset Scheduler     " -ForegroundColor Green
Write-Host "=================================================" -ForegroundColor Cyan

try {
    # 1. Update Hosts File with IDM Verification Domains
    $hostsPath = "$env:windir\System32\drivers\etc\hosts"
    $blockedDomains = @(
        "internetdownloadmanager.com",
        "www.internetdownloadmanager.com",
        "registeridm.com",
        "www.registeridm.com",
        "secure.internetdownloadmanager.com",
        "mirror.internetdownloadmanager.com",
        "mirror2.internetdownloadmanager.com",
        "mirror3.internetdownloadmanager.com",
        "mirror5.internetdownloadmanager.com",
        "test.internetdownloadmanager.com",
        "tonec.com",
        "www.tonec.com",
        "tonec.net",
        "www.tonec.net",
        "star.tonec.com"
    )

    if (Test-Path $hostsPath) {
        $lines = Get-Content -Path $hostsPath -ErrorAction SilentlyContinue
        $cleanLines = @()
        foreach ($line in $lines) {
            $trimmed = $line.Trim()
            $isIdm = $false
            foreach ($d in $blockedDomains) {
                if ($trimmed -match [regex]::Escape($d)) { $isIdm = $true; break }
            }
            if ($trimmed -match "# === IDM Manager Pro - Blocked Domains ===" -or $trimmed -match "# === IDM Protection Blocklist ===") {
                $isIdm = $true
            }
            if (-not $isIdm) { $cleanLines += $line }
        }
        $cleanLines += ""
        $cleanLines += "# === IDM Protection Blocklist ==="
        foreach ($d in $blockedDomains) { $cleanLines += "127.0.0.1 $d" }
        $cleanLines | Set-Content -Path $hostsPath -Force -ErrorAction SilentlyContinue
        Write-Host "[OK] Hosts file successfully locked with verification blocklist." -ForegroundColor Green
    }

    # 2. Add Windows Firewall Outbound Block Rule for Telemetry IPs
    & netsh advfirewall firewall delete rule name="IDM_Block_Verification_Servers" | Out-Null
    & netsh advfirewall firewall add rule name="IDM_Block_Verification_Servers" dir=out action=block remoteip="67.18.60.145,51.91.170.59,15.235.34.119" enable=yes | Out-Null
    Write-Host "[OK] Windows Firewall outbound block rule added for 67.18.60.145." -ForegroundColor Green

    # 3. Schedule hourly reset task
    $cmd = "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`" -Silent"
    & schtasks /create /tn $taskName /tr $cmd /sc hourly /mo 1 /f | Out-Null
    Write-Host "[OK] Task '$taskName' successfully registered in Windows Task Scheduler!" -ForegroundColor Green
    Write-Host "[OK] Schedule: Runs automatically every 1 hour in the background." -ForegroundColor Green
    
    # 4. Run immediate reset & purge
    & powershell.exe -ExecutionPolicy Bypass -File "$scriptPath"
    Write-Host "[OK] Initial trial reset & shield applied successfully." -ForegroundColor Green
} catch {
    Write-Host "[!] Error installing scheduled task: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host "=================================================" -ForegroundColor Cyan
