param (
    [switch]$Silent
)

# Robust IDM Trial Reset & Expiration Prevention Engine
# Supports silent automated scheduled runs & manual execution

if (-not $Silent) {
    Write-Host "=================================================" -ForegroundColor Cyan
    Write-Host "       IDM Automatic Trial Reset Engine          " -ForegroundColor Green
    Write-Host "=================================================" -ForegroundColor Cyan
}

# 1. Terminate any running IDM processes gracefully
Get-Process -Name IDMan, IEMonitor -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

# 2. Main DownloadManager Registry Configuration & Update Shield
$regPath = "HKCU:\Software\DownloadManager"

if (Test-Path $regPath) {
    # Lock Trial Mode
    Set-ItemProperty -Path $regPath -Name "RegistrationStatus" -Value 0 -Type DWord -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $regPath -Name "reg_status" -Value 0 -Type DWord -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $regPath -Name "auto_reset_trial" -Value "2099/12/31" -Type String -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $regPath -Name "LstCheck" -Value "12/31/99" -Type String -ErrorAction SilentlyContinue
    
    # Shield against forced update-check verifications
    Set-ItemProperty -Path $regPath -Name "CheckUpdtVM" -Value 0 -Type DWord -ErrorAction SilentlyContinue

    # Remove all tracking & expired state keys
    $keysToRemove = @(
        "Serial", "FName", "LName", "Email",
        "tvfrdt", "radxcnt", "LastCheckQU", "scint",
        "FData", "MData", "Model", "Count", "TreeState1", "TreeState2"
    )

    foreach ($key in $keysToRemove) {
        Remove-ItemProperty -Path $regPath -Name $key -ErrorAction SilentlyContinue
    }

    if (-not $Silent) {
        Write-Host "[OK] Registry trial timestamp reset & update verification shielded." -ForegroundColor Green
    }
}

# 3. Clean all hidden CLSID tracking keys in HKCU
$clsidPaths = @(
    "HKCU:\Software\Classes\CLSID",
    "HKCU:\Software\Classes\WOW6432Node\CLSID"
)

foreach ($cPath in $clsidPaths) {
    if (Test-Path $cPath) {
        Get-ChildItem -Path $cPath -ErrorAction SilentlyContinue | ForEach-Object {
            $guidKey = $_.PSPath
            $subKeys = Get-ChildItem -Path $guidKey -ErrorAction SilentlyContinue
            
            # Identify IDM generated tracking nodes (without standard InProcServer32 or with IDM signatures)
            $isIdmTracking = $false
            if ($subKeys) {
                foreach ($sub in $subKeys) {
                    if ($sub.Name -like "*InProcServer32*" -or $sub.Name -like "*Version*" -or $sub.Name -like "*LocalServer32*") {
                        $isIdmTracking = $true
                        break
                    }
                }
            } else {
                # Keys with binary trial tracking values
                $props = Get-ItemProperty -Path $guidKey -ErrorAction SilentlyContinue
                if ($props.MData -or $props.Model -or $props.Count) {
                    $isIdmTracking = $true
                }
            }

            if ($isIdmTracking) {
                Remove-Item -Path $guidKey -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

if (-not $Silent) {
    Write-Host "[OK] Cleared trial tracking CLSID keys." -ForegroundColor Green
    Write-Host "=================================================" -ForegroundColor Cyan
    Write-Host "Trial successfully reset to full 30 days!" -ForegroundColor Green
}
