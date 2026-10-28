param(
  [string]$Device = '192.168.1.3:38389',
  [string]$Pkg = 'app.colorlink.a7m2'
)

# 验证 A7M2 的「拍进内存缓存再回传」链路：连接 → 取景 → 按快门 → 取图。
# 每步都打印 logcat 里的关键行，失败时能直接看出卡在哪一步。

$ErrorActionPreference = 'Continue'
$adb = 'C:\Users\wu\AppData\Local\ColorLinkTools\platform-tools\adb.exe'
$d = $Device

function Get-Ui() {
  & $adb -s $d shell uiautomator dump /sdcard/u.xml 2>&1 | Out-Null
  & $adb -s $d pull /sdcard/u.xml (Join-Path $env:TEMP 'u.xml') 2>&1 | Out-Null
  return [System.IO.File]::ReadAllText((Join-Path $env:TEMP 'u.xml'))
}

function Tap-Text([string]$text) {
  $xml = Get-Ui
  $m = [regex]::Match($xml, 'text="' + [regex]::Escape($text) + '"[^>]*bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"')
  if (-not $m.Success) { return $false }
  $cx = [int](([int]$m.Groups[1].Value + [int]$m.Groups[3].Value) / 2)
  $cy = [int](([int]$m.Groups[2].Value + [int]$m.Groups[4].Value) / 2)
  & $adb -s $d shell input tap $cx $cy | Out-Null
  return $true
}

function Logs([string]$pattern, [int]$last = 12) {
  $lines = & $adb -s $d logcat -d 2>&1 | Select-String -Pattern $pattern
  return ($lines | Select-Object -Last $last | ForEach-Object { $_.Line })
}

& $adb connect $d 2>&1 | Out-Null
& $adb -s $d shell am force-stop $Pkg
& $adb -s $d logcat -c
& $adb -s $d shell am start -n "$Pkg/.MainActivity" 2>&1 | Out-Null
Start-Sleep -Seconds 9

$xml = Get-Ui
if ($xml -match '要允许') {
  $null = Tap-Text '确定'
  Start-Sleep -Seconds 3
}
"CONNECT: " + [bool](Tap-Text '连接相机')
Start-Sleep -Seconds 8
'--- connect ---'
Logs 'state=ready|state=error|Sony extended protocol|Sony vendor codes|Sony DeviceInfo' 6

"LIVE: " + [bool](Tap-Text '进入取景')
Start-Sleep -Seconds 6
Logs 'live-view cycle|stream session' 3

$shutter = Tap-Text '快门'
if (-not $shutter) { $shutter = Tap-Text '远程快门' }
"SHUTTER: $shutter"
Start-Sleep -Seconds 30

'--- capture ---'
Logs 'capture|D215|ObjectInMemory|getObject|focus|0x9207|0x1009|PTP event code=0xC201' 26

'--- saved ---'
Logs 'camera.photo.saved|camera.capture.failed|RAW_CAPTURE' 4

'VERIFY_DONE'
