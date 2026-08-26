param (
    [switch]$Silent
)

# Robust IDM Trial Reset & Telemetry Isolation Engine
# Supports silent automated scheduled runs & manual execution

if (-not $Silent) {
    Write-Host "=================================================" -ForegroundColor Cyan
    Write-Host "       IDM Advanced Trial Reset & Shield         " -ForegroundColor Green
    Write-Host "=================================================" -ForegroundColor Cyan
}

# 1. Terminate any running IDM processes gracefully
Get-Process -Name IDMan, IEMonitor -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

# 2. Update Hosts file to block IDM telemetry / verification endpoints
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

try {
    if (Test-Path $hostsPath) {
        $lines = Get-Content -Path $hostsPath -ErrorAction SilentlyContinue
        $cleanLines = @()
        
        foreach ($line in $lines) {
            $trimmed = $line.Trim()
            $isIdm = $false
            foreach ($d in $blockedDomains) {
                if ($trimmed -match [regex]::Escape($d)) {
                    $isIdm = $true
                    break
                }
            }
            if ($trimmed -match "# === IDM Manager Pro - Blocked Domains ===" -or $trimmed -match "# === IDM Protection Blocklist ===") {
                $isIdm = $true
            }
            if (-not $isIdm) {
                $cleanLines += $line
            }
        }

        # Add clean blocked entries
        $cleanLines += ""
        $cleanLines += "# === IDM Protection Blocklist ==="
        foreach ($d in $blockedDomains) {
            $cleanLines += "127.0.0.1 $d"
        }

        $cleanLines | Set-Content -Path $hostsPath -Force -ErrorAction SilentlyContinue
        if (-not $Silent) {
            Write-Host "[OK] Hosts file updated to isolate verification servers." -ForegroundColor Green
        }
    }
} catch {
    # Non-fatal if permission denied (requires admin)
}

# 3. Clean and Shield DownloadManager Registry Keys
$regPath = "HKCU:\Software\DownloadManager"

if (Test-Path $regPath) {
    # Set perpetual trial state
    Set-ItemProperty -Path $regPath -Name "RegistrationStatus" -Value 0 -Type DWord -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $regPath -Name "reg_status" -Value 0 -Type DWord -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $regPath -Name "auto_reset_trial" -Value "2099/12/31" -Type String -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $regPath -Name "LstCheck" -Value "12/31/99" -Type String -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $regPath -Name "CheckUpdtVM" -Value 0 -Type DWord -ErrorAction SilentlyContinue

    # Remove all fraud detection, splash popup, and tracking keys
    $keysToRemove = @(
        "unTrSplInfo", "tvfrdt", "radxcnt", "LastCheckQU", "showHTDlYtMsg",
        "Serial", "FName", "LName", "Email", "scint",
        "FData", "MData", "Model", "Count", "TreeState1", "TreeState2"
    )

    foreach ($key in $keysToRemove) {
        Remove-ItemProperty -Path $regPath -Name $key -ErrorAction SilentlyContinue
    }

    if (-not $Silent) {
        Write-Host "[OK] Cleared unTrSplInfo, tvfrdt, and trial tracking registry keys." -ForegroundColor Green
    }
}

# 4. Deep Clean hidden IDM CLSID keys in HKCU
$clsidPaths = @(
    "HKCU:\Software\Classes\CLSID",
    "HKCU:\Software\Classes\WOW6432Node\CLSID"
)

$clearedClsidCount = 0

foreach ($cPath in $clsidPaths) {
    if (Test-Path $cPath) {
        Get-ChildItem -Path $cPath -ErrorAction SilentlyContinue | ForEach-Object {
            $guidKey = $_.PSPath
            $guidName = $_.PSChildName
            $props = Get-ItemProperty -Path $guidKey -ErrorAction SilentlyContinue
            $subKeys = Get-ChildItem -Path $guidKey -ErrorAction SilentlyContinue
            
            # Check for IDM signatures (Model, Therad, HostID, MData, FData, Count, or subkey Version)
            $isIdmKey = $false

            if ($props.Model -or $props.Therad -or $props.HostID -or $props.MData -or $props.FData -or $props.Count) {
                $isIdmKey = $true
            } elseif ($subKeys) {
                foreach ($sub in $subKeys) {
                    if ($sub.PSChildName -eq "Version" -or $sub.PSChildName -eq "Model" -or $sub.PSChildName -eq "MData") {
                        $isIdmKey = $true
                        break
                    }
                }
            } elseif ($guidName -eq "{031E4825-7B94-4dc3-B131-E946B44C8DD5}" -or $guidName -eq "{51e8c629-936f-cb16-2e3e-c6b96a5d2f76}") {
                $isIdmKey = $true
            }

            if ($isIdmKey) {
                Remove-Item -Path $guidKey -Recurse -Force -ErrorAction SilentlyContinue
                $clearedClsidCount++
            }
        }
    }
}

if (-not $Silent) {
    Write-Host "[OK] Cleared $clearedClsidCount hidden IDM CLSID tracking keys." -ForegroundColor Green
}

# 5. Flush DNS Client Cache to apply hosts immediately
try {
    Clear-DnsClientCache -ErrorAction SilentlyContinue
} catch {}

if (-not $Silent) {
    Write-Host "=================================================" -ForegroundColor Cyan
    Write-Host "Trial successfully reset & network shielded!" -ForegroundColor Green
}
