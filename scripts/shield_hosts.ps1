# Elevated Hosts file Updater for IDM Verification Domain Shielding
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
    # Remove ReadOnly if set
    if ((Get-Item $hostsPath).IsReadOnly) {
        Set-ItemProperty -Path $hostsPath -Name IsReadOnly -Value $false
    }

    $lines = Get-Content -Path $hostsPath
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

    $cleanLines += ""
    $cleanLines += "# === IDM Protection Blocklist ==="
    foreach ($d in $blockedDomains) {
        $cleanLines += "127.0.0.1 $d"
    }

    $cleanLines | Set-Content -Path $hostsPath -Force
    Clear-DnsClientCache -ErrorAction SilentlyContinue
    Write-Host "[OK] Hosts file successfully updated with IDM blocklist!" -ForegroundColor Green
} catch {
    Write-Host "[!] Error writing to hosts: $($_.Exception.Message)" -ForegroundColor Red
}
