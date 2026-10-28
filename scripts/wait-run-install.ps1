param(
  [Parameter(Mandatory = $true)][string]$RunId,
  [Parameter(Mandatory = $true)][string]$ApkName,
  [string]$Device = '192.168.1.7:37743'
)

$ErrorActionPreference = 'Continue'
$repo = 'accten/ColorLink-A7M2'
$adb = 'C:\Users\wu\AppData\Local\ColorLinkTools\platform-tools\adb.exe'
$statusScript = Join-Path $env:TEMP 'jobstat.mjs'

$cred = "url=https://github.com`nprotocol=https`n`n" | git credential fill 2>$null
$tok = (($cred -split "`n" | Where-Object { $_ -like 'password=*' }) -replace '^password=','') -join ''
if (-not $tok) { 'NO_TOKEN'; exit 1 }
$env:GH_TOK = $tok

function Api($path) {
  $cfg = "url = `"https://api.github.com$path`"`nheader = `"Authorization: Bearer $tok`"`nproxy = `"http://127.0.0.1:10808`"`nssl-no-revoke`nsilent`nmax-time = 120`n"
  $file = Join-Path $env:TEMP ('api_' + [guid]::NewGuid().ToString('N') + '.txt')
  [System.IO.File]::WriteAllText($file, $cfg)
  $out = curl.exe --config $file 2>$null
  Remove-Item $file -Force -ErrorAction SilentlyContinue
  if (-not $out) {
    $cfg2 = "url = `"https://api.github.com$path`"`nheader = `"Authorization: Bearer $tok`"`nssl-no-revoke`nsilent`nmax-time = 120`n"
    [System.IO.File]::WriteAllText($file, $cfg2)
    $out = curl.exe --config $file 2>$null
    Remove-Item $file -Force -ErrorAction SilentlyContinue
  }
  return $out
}

$done = $false
for ($i = 0; $i -lt 160; $i++) {
  $st = node $statusScript $RunId status 2>&1 | Out-String
  if ($st -match 'Build APK\s+completed\s+success') { 'BUILD_OK'; $done = $true; break }
  if ($st -match 'Build APK\s+completed\s+(failure|cancelled)') { "BUILD_FAILED`n$st"; exit 1 }
  Start-Sleep -Seconds 30
}
if (-not $done) { 'BUILD_TIMEOUT'; exit 1 }

$art = node $statusScript $RunId artifacts 2>&1 | Out-String
if ($art -notmatch '\d+\t\d+\t') { "NO_ARTIFACT`n$art"; exit 1 }
$parts = ($art.Trim() -split "`t")
$id = $parts[0]
$size = [int]$parts[1]
"ARTIFACT $id $([math]::Round($size / 1MB, 2))MB"

$zip = Join-Path $env:TEMP $ApkName
Remove-Item $zip -Force -ErrorAction SilentlyContinue
$z = $zip -replace '\\','/'
$ok = $false
for ($r = 0; $r -lt 60 -and -not $ok; $r++) {
  $proxyLine = if ($r % 2 -eq 0) { "proxy = `"http://127.0.0.1:10808`"`n" } else { '' }
  $cfg = "url = `"https://api.github.com/repos/$repo/actions/artifacts/$id/zip`"`nheader = `"Authorization: Bearer $tok`"`n${proxyLine}location`nssl-no-revoke`nsilent`nmax-time = 300`ncontinue-at -`noutput = `"$z`""
  $file = Join-Path $env:TEMP 'dlcfg.txt'
  [System.IO.File]::WriteAllText($file, $cfg)
  curl.exe --config $file 2>$null | Out-Null
  $len = 0
  if (Test-Path $zip) { $len = (Get-Item $zip).Length }
  "DL $([math]::Round($len / 1MB, 2))MB / $([math]::Round($size / 1MB, 2))MB"
  if ($len -ge $size) { $ok = $true } else { Start-Sleep -Seconds 3 }
}
if (-not $ok) { 'DL_INCOMPLETE'; exit 1 }

$dir = Join-Path $env:TEMP ('apkdir_' + [guid]::NewGuid().ToString('N').Substring(0, 6))
Expand-Archive -LiteralPath $zip -DestinationPath $dir -Force
$apk = Get-ChildItem $dir -Recurse -File -Filter *.apk | Select-Object -First 1
"APK=$($apk.FullName)"
& $adb connect $Device 2>&1 | Out-Null
& $adb -s $Device install -r $apk.FullName 2>&1 | Select-Object -Last 2
'INSTALLED'
