# Install Scheduled Task for Automated IDM Trial Reset (At Logon + Hourly in 100% Silent Background)
$taskName = "IDM_Auto_Trial_Reset"
$scriptPath = Join-Path (Split-Path $PSScriptRoot -Parent) "scripts\reset_idm_trial.ps1"

Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "   Installing IDM Auto Trial Reset Scheduler     " -ForegroundColor Green
Write-Host "=================================================" -ForegroundColor Cyan

# 1. Try Updating Hosts File with IDM Verification Domains (if elevated)
try {
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
        $lines = Get-Content -Path $hostsPath -ErrorAction Stop
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
        $cleanLines | Set-Content -Path $hostsPath -Force -ErrorAction Stop
        Write-Host "[OK] Hosts file successfully locked with verification blocklist." -ForegroundColor Green
    }
} catch {
    # Non-fatal if not elevated
}

# 2. Try Adding Windows Firewall Outbound Block Rule (if elevated)
try {
    & netsh advfirewall firewall delete rule name="IDM_Block_Verification_Servers" | Out-Null
    & netsh advfirewall firewall add rule name="IDM_Block_Verification_Servers" dir=out action=block remoteip="67.18.60.145,51.91.170.59,15.235.34.119" enable=yes | Out-Null
    Write-Host "[OK] Windows Firewall outbound block rule active." -ForegroundColor Green
} catch {}

# 3. Register Scheduled Task with Startup (AtLogOn) + Hourly triggers and 100% Hidden window
try {
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-WindowStyle Hidden -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$scriptPath`" -Silent"
    $triggerLogon = New-ScheduledTaskTrigger -AtLogOn
    $triggerHourly = New-ScheduledTaskTrigger -Once -At (Get-Date).Date -RepetitionInterval (New-TimeSpan -Hours 1)
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -Hidden

    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($triggerLogon, $triggerHourly) -Settings $settings -Force -ErrorAction Stop | Out-Null

    Write-Host "[OK] Task '$taskName' registered to run on Computer Startup (Logon) + Every 1 Hour!" -ForegroundColor Green
    Write-Host "[OK] Execution Mode: 100% Silent Background (No Command Prompt Window)." -ForegroundColor Green
} catch {
    # Fallback to schtasks
    $cmd = "powershell.exe -WindowStyle Hidden -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$scriptPath`" -Silent"
    & schtasks /create /tn $taskName /tr $cmd /sc onlogon /f | Out-Null
    Write-Host "[OK] Task registered via schtasks (OnLogon)." -ForegroundColor Green
}

# 4. Run immediate reset & purge
try {
    & powershell.exe -WindowStyle Hidden -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$scriptPath" -Silent
    Write-Host "[OK] Initial trial reset & shield applied successfully." -ForegroundColor Green
} catch {}

Write-Host "=================================================" -ForegroundColor Cyan
