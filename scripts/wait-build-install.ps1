param(
  [Parameter(Mandatory = $true)][string]$Head,
  [Parameter(Mandatory = $true)][string]$ApkName,
  [string]$Device = '192.168.1.7:37743'
)

$ErrorActionPreference = 'Continue'
$repo = 'accten/ColorLink-A7M2'
$adb = 'C:\Users\wu\AppData\Local\ColorLinkTools\platform-tools\adb.exe'
$helper = Join-Path $env:TEMP 'gh.mjs'

$cred = "url=https://github.com`nprotocol=https`n`n" | git credential fill 2>$null
$tok = (($cred -split "`n" | Where-Object { $_ -like 'password=*' }) -replace '^password=','') -join ''
if (-not $tok) { 'NO_TOKEN'; exit 1 }

function Api($path, $useProxy) {
  $proxyLine = if ($useProxy) { "proxy = `"http://127.0.0.1:10808`"`n" } else { '' }
  $cfg = "url = `"https://api.github.com$path`"`nheader = `"Authorization: Bearer $tok`"`n${proxyLine}ssl-no-revoke`nsilent`nmax-time = 60`n"
  $file = Join-Path $env:TEMP ('api_' + [guid]::NewGuid().ToString('N') + '.txt')
  [System.IO.File]::WriteAllText($file, $cfg)
  $out = curl.exe --config $file 2>$null
  Remove-Item $file -Force -ErrorAction SilentlyContinue
  return $out
}

$runId = $null
for ($i = 0; $i -lt 150 -and -not $runId; $i++) {
  $env:GH_TOK = $tok
  $line = node $helper "/repos/$repo/actions/runs?per_page=8" runs 2>&1 | Out-String
  $m = [regex]::Match($line, '(\d+) Android APK #\d+ ' + [regex]::Escape($Head) + '\s')
  if ($m.Success) { $runId = $m.Groups[1].Value; break }
  Start-Sleep -Seconds 30
}
if (-not $runId) { 'NO_RUN'; exit 1 }
"RUN_ID=$runId"

for ($i = 0; $i -lt 120; $i++) {
  $st = Api "/repos/$repo/actions/runs/$runId" $true
  if (-not $st) { $st = Api "/repos/$repo/actions/runs/$runId" $false }
  if ($st -match '"status":\s*"completed"') {
    if ($st -notmatch '"conclusion":\s*"success"') { 'BUILD_FAILED'; exit 1 }
    'BUILD_OK'
    break
  }
  Start-Sleep -Seconds 30
}

$json = Api "/repos/$repo/actions/runs/$runId/artifacts" $true
if (-not $json) { $json = Api "/repos/$repo/actions/runs/$runId/artifacts" $false }
$art = $json | ConvertFrom-Json
if (-not $art.artifacts) { 'NO_ARTIFACT'; exit 1 }
$url = $art.artifacts[0].archive_download_url
$size = $art.artifacts[0].size_in_bytes
"ARTIFACT=$size"

$zip = Join-Path $env:TEMP $ApkName
Remove-Item $zip -Force -ErrorAction SilentlyContinue
$z = $zip -replace '\\','/'
$ok = $false
for ($round = 0; $round -lt 40 -and -not $ok; $round++) {
  $proxyLine = if ($round % 2 -eq 0) { "proxy = `"http://127.0.0.1:10808`"`n" } else { '' }
  $cfg = "url = `"$url`"`nheader = `"Authorization: Bearer $tok`"`n${proxyLine}location`nssl-no-revoke`nsilent`nmax-time = 240`ncontinue-at -`noutput = `"$z`""
  $file = Join-Path $env:TEMP 'dlcfg.txt'
  [System.IO.File]::WriteAllText($file, $cfg)
  curl.exe --config $file 2>$null | Out-Null
  $len = 0
  if (Test-Path $zip) { $len = (Get-Item $zip).Length }
  "DL $([math]::Round($len / 1MB, 2))MB / $([math]::Round($size / 1MB, 2))MB"
  if ($len -ge $size) { $ok = $true } else { Start-Sleep -Seconds 3 }
}
if (-not $ok) { 'DL_INCOMPLETE'; exit 1 }

$dir = Join-Path $env:TEMP ('apkdir_' + $Head)
if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }
Expand-Archive -LiteralPath $zip -DestinationPath $dir -Force
$apk = Get-ChildItem $dir -Recurse -File -Filter *.apk | Select-Object -First 1
"APK=$($apk.FullName)"
& $adb connect $Device 2>&1 | Out-Null
& $adb -s $Device install -r $apk.FullName 2>&1 | Select-Object -Last 2
'DONE'
