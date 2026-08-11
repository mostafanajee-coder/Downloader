# Automated IDM Trial Reset & 2099 Extension Script
# Automatically cleans trial expiration metadata and sets trial reset timestamp to Year 2099

Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "       IDM Automatic Trial Reset Engine          " -ForegroundColor Green
Write-Host "=================================================" -ForegroundColor Cyan

# Terminate any running IDM processes
Get-Process -Name IDMan, IEMonitor -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

$regPath = "HKCU:\Software\DownloadManager"

if (Test-Path $regPath) {
    # Lock Trial Mode without serial prompts
    Set-ItemProperty -Path $regPath -Name "RegistrationStatus" -Value 0 -Type DWord -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $regPath -Name "reg_status" -Value 0 -Type DWord -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $regPath -Name "auto_reset_trial" -Value "2099/12/31" -Type String -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $regPath -Name "LstCheck" -Value "12/31/99" -Type String -ErrorAction SilentlyContinue

    # Remove conflicting serial entries
    Remove-ItemProperty -Path $regPath -Name "Serial" -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path $regPath -Name "FName" -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path $regPath -Name "LName" -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path $regPath -Name "Email" -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path $regPath -Name "tvfrdt" -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path $regPath -Name "radxcnt" -ErrorAction SilentlyContinue
    Remove-ItemProperty -Path $regPath -Name "LastCheckQU" -ErrorAction SilentlyContinue

    Write-Host "[OK] Registry trial timestamp updated to 2099/12/31" -ForegroundColor Green
}

# Clean CLSID tracking keys
$clsidPath = "HKCU:\Software\Classes\CLSID"
if (Test-Path $clsidPath) {
    Get-ChildItem -Path $clsidPath -ErrorAction SilentlyContinue | ForEach-Object {
        $sub = Get-ChildItem -Path $_.PSPath -ErrorAction SilentlyContinue
        if ($sub -and ($sub.Name -like "*InProcServer32*" -or $sub.Name -like "*Version*")) {
            Remove-Item -Path $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    Write-Host "[OK] Cleared trial tracking CLSID keys" -ForegroundColor Green
}

Write-Host "=================================================" -ForegroundColor Cyan
Write-Host "Trial successfully locked to 2099!" -ForegroundColor Green
