# Script to Register Native Messaging Host for Original IDM Extension
# Registers 'com.tonec.idm' in HKCU:\Software\Google\Chrome\NativeMessagingHosts

$regPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.tonec.idm"
$jsonPath = "C:\Users\kingm\OneDrive\Desktop\Downloader\bridge\com.tonec.idm.json"

if (-not (Test-Path $regPath)) {
    New-Item -Path $regPath -Force | Out-Null
}

Set-ItemProperty -Path $regPath -Name "(default)" -Value $jsonPath -ErrorAction SilentlyContinue
Write-Host "[OK] Native Messaging Host 'com.tonec.idm' registered successfully!" -ForegroundColor Green
Write-Host "JSON Path: $jsonPath" -ForegroundColor Cyan
