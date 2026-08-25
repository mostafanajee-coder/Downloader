# Install Scheduled Task for Automated IDM Trial Reset (Hourly & On Logon)
$taskName = "IDM_Auto_Trial_Reset"
$scriptPath = Join-Path (Split-Path $PSScriptRoot -Parent) "scripts\reset_idm_trial.ps1"

Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "   Installing IDM Auto Trial Reset Scheduler     " -ForegroundColor Green
Write-Host "=================================================" -ForegroundColor Cyan

try {
    # Check if PowerShell ScheduledTask module is available and has permissions
    $cmd = "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`" -Silent"
    & schtasks /create /tn $taskName /tr $cmd /sc hourly /mo 1 /f | Out-Null

    Write-Host "[OK] Task '$taskName' successfully registered in Windows Task Scheduler!" -ForegroundColor Green
    Write-Host "[OK] Schedule: Runs automatically every 1 hour in the background." -ForegroundColor Green
    Write-Host "[OK] Updates Shield: Enabled." -ForegroundColor Green
} catch {
    Write-Host "[!] Error installing scheduled task: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host "=================================================" -ForegroundColor Cyan
