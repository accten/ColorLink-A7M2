param(
  [string]$Device = '192.168.1.7:37743',
  [string]$Pkg = 'app.colorlink.a7m2'
)

# 验证 A7M2 的「拍进内存缓存再回传」链路：连接 → 读属性 → 远程快门 → 取图。
# 每一步都把 logcat 里的关键行打出来，失败时能直接看到卡在哪一步。

$ErrorActionPreference = 'Continue'
$adb = 'C:\Users\wu\AppData\Local\ColorLinkTools\platform-tools\adb.exe'
$d = $Device

function Dump-UI([string]$name) {
  $tmp = Join-Path $env:TEMP "$name.xml"
  & $adb -s $d shell uiautomator dump "/sdcard/$name.xml" 2>&1 | Out-Null
  & $adb -s $d pull "/sdcard/$name.xml" $tmp 2>&1 | Out-Null
  return [System.IO.File]::ReadAllText($tmp)
}

function Tap-Text([string]$xml, [string]$text) {
  $pattern = 'text="' + [regex]::Escape($text) + '"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"'
  $m = [regex]::Match($xml, $pattern)
  if (-not $m.Success) { return $false }
  $cx = [int](([int]$m.Groups[1].Value + [int]$m.Groups[3].Value) / 2)
  $cy = [int](([int]$m.Groups[2].Value + [int]$m.Groups[4].Value) / 2)
  & $adb -s $d shell input tap $cx $cy
  return $true
}

function Logs([string]$pattern, [int]$last = 12) {
  $lines = & $adb -s $d logcat -d 2>&1 | Select-String -Pattern $pattern
  return ($lines | Select-Object -Last $last | ForEach-Object { $_.Line -replace '^.*?\[ColorLink\]\s*', '' })
}

& $adb connect $d 2>&1 | Out-Null
& $adb -s $d shell am force-stop $Pkg
& $adb -s $d logcat -c
& $adb -s $d shell am start -n "$Pkg/.MainActivity" 2>&1 | Out-Null
Start-Sleep -Seconds 9

$xml = Dump-UI 'v1'
if ($xml -match '允许') {
  $null = Tap-Text $xml '确定'
  Start-Sleep -Seconds 4
}
$null = Tap-Text (Dump-UI 'v2') '连接相机'
Start-Sleep -Seconds 10

'--- connect ---'
Logs 'state=ready|state=error|Sony extended protocol|Sony vendor codes|DeviceInfo model|Sony DeviceInfo' 14

'--- D215 baseline ---'
Logs 'Sony D215|ObjectInMemory' 6

# 回首页拍一张
& $adb -s $d shell input keyevent 4
Start-Sleep -Seconds 1
$null = Tap-Text (Dump-UI 'v3') '相机'
Start-Sleep -Seconds 2
$shot = Tap-Text (Dump-UI 'v4') '远程快门'
"SHUTTER_TAPPED: $shot"
Start-Sleep -Seconds 22

'--- capture ---'
Logs 'capture|D215|ObjectInMemory|getObject|focus|PTP event code=0x' 22

'--- photo saved ---'
Logs 'camera.photo.saved|camera.capture.failed' 4

'--- files on device ---'
& $adb -s $d shell "su -c 'ls -l /data/data/$Pkg/files/ingest 2>/dev/null | tail -3'" 2>&1
$latest = & $adb -s $d shell "ls -t /sdcard/Android/data/$Pkg/files 2>/dev/null | head -3" 2>&1
"app files: $latest"

'VERIFY_DONE'
