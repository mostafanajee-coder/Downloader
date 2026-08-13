# Install Scheduled Task for Automated IDM Trial Reset (Every 2 Days & On Logon)
$taskName = "IDM_Auto_Trial_Reset"
$scriptPath = Join-Path (Split-Path $PSScriptRoot -Parent) "scripts\reset_idm_trial.ps1"

Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "   Installing IDM Auto Trial Reset Scheduler     " -ForegroundColor Green
Write-Host "=================================================" -ForegroundColor Cyan

try {
    # Check if PowerShell ScheduledTask module is available
    if (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue) {
        $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`" -Silent"
        $triggerDays = New-ScheduledTaskTrigger -Daily -At "12:00PM" -DaysInterval 2
        $triggerLogon = New-ScheduledTaskTrigger -AtLogOn
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
        
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($triggerDays, $triggerLogon) -Settings $settings -Force | Out-Null
    } else {
        # Fallback to schtasks command line
        $cmd = "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`" -Silent"
        & schtasks /create /tn $taskName /tr $cmd /sc daily /mo 2 /st 12:00 /f | Out-Null
    }

    Write-Host "[OK] Task '$taskName' successfully registered in Windows Task Scheduler!" -ForegroundColor Green
    Write-Host "[OK] Schedule: Runs automatically every 2 days and on user logon in the background." -ForegroundColor Green
    Write-Host "[OK] Updates Shield: Enabled." -ForegroundColor Green
} catch {
    Write-Host "[!] Error installing scheduled task: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host "=================================================" -ForegroundColor Cyan
