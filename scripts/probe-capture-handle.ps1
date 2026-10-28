param(
  [string]$Device = '192.168.1.7:37743'
)

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

function Read-Result([string]$xml) {
  $i = $xml.IndexOf('code=')
  if ($i -lt 0) { $i = $xml.IndexOf('失败') }
  if ($i -lt 0) { return 'no-result' }
  $len = [Math]::Min(160, $xml.Length - $i)
  return $xml.Substring($i, $len) -replace '&#10;', ' '
}

& $adb connect $d 2>&1 | Out-Null
& $adb -s $d shell am force-stop app.colorlink.a7m2
& $adb -s $d logcat -c
& $adb -s $d shell am start -n app.colorlink.a7m2/.MainActivity 2>&1 | Out-Null
Start-Sleep -Seconds 9

# 连接相机
$xml = Dump-UI 'r1'
if ($xml -match '允许') {
  $null = Tap-Text $xml '确定'
  Start-Sleep -Seconds 5
}
$null = Tap-Text (Dump-UI 'r2') '连接相机'
Start-Sleep -Seconds 8
"CONNECT: " + ((& $adb -s $d logcat -d -s ExpoSonyCamera:* 2>&1 | Select-String 'state=ready|state=error' | Select-Object -Last 1).Line)

# 打开设置 → 探测
$null = Tap-Text (Dump-UI 'r3') '设置'
Start-Sleep -Seconds 2
& $adb -s $d shell input swipe 1200 1400 1200 2800 300
Start-Sleep -Seconds 1
& $adb -s $d shell input swipe 1200 1400 1200 2800 300
Start-Sleep -Seconds 2
$ok = Tap-Text (Dump-UI 'r4') 'Sony 协议探测'
"OPEN_PROBE: $ok"
Start-Sleep -Seconds 2

$xml = Dump-UI 'r5'
$ok = Tap-Text $xml '回传目标 0xD222 = 1（host）'
Start-Sleep -Seconds 3
"HOST_DEST: " + (Read-Result (Dump-UI 'r6'))

# 回首页拍一张
& $adb -s $d shell input keyevent 4
Start-Sleep -Seconds 1
$null = Tap-Text (Dump-UI 'r7') '相机'
Start-Sleep -Seconds 2
$null = Tap-Text (Dump-UI 'r8') '远程快门'
Start-Sleep -Seconds 5

# 立刻回到探测面板
$null = Tap-Text (Dump-UI 'r9') '设置'
Start-Sleep -Seconds 2
& $adb -s $d shell input swipe 1200 1400 1200 2800 300
Start-Sleep -Seconds 1
& $adb -s $d shell input swipe 1200 1400 1200 2800 300
Start-Sleep -Seconds 2
$null = Tap-Text (Dump-UI 'r10') 'Sony 协议探测'
Start-Sleep -Seconds 2

foreach ($label in @('对象信息 0x1008', '分块读回传 0x101B (64KB)', 'Sony 分块 0x923D (handle 在前)', 'Sony 分块 0x923D (cardInfo=0)')) {
  $xml = Dump-UI 'rq'
  $tapped = Tap-Text $xml $label
  if (-not $tapped) {
    & $adb -s $d shell input swipe 1200 3000 1200 2600 250
    Start-Sleep -Seconds 1
    $xml = Dump-UI 'rq2'
    $tapped = Tap-Text $xml $label
  }
  Start-Sleep -Seconds 4
  "$label => tapped=$tapped " + (Read-Result (Dump-UI 'rr'))
}

'PROBE_DONE'
