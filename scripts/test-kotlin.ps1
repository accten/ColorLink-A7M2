param(
  # Kotlin 编译器目录（含 bin\kotlinc.bat）。默认用仓库内的临时工具目录。
  [string]$Kotlinc = 'D:\ColorLink A7M2\_work\kt\kotlinc',
  [string]$Jars = 'D:\ColorLink A7M2\_work\kt',
  [string]$Java = 'D:\jdk-17.0.17.10-hotspot\bin\java.exe'
)

# 在普通 JVM 上跑 sony-camera 的纯 Kotlin 单测（属性数组、对象载荷、曝光解码、设备信息）。
#
# 为什么不用 Gradle：编 Android 模块要 SDK/NDK，一轮十几分钟；这些解析器不 import android.*，
# 直接用 kotlinc + junit 几十秒就能跑完，改解析器时先在这里过一遍。
#
# 依赖（工作目录里，不入库）：
#   _work/kt/kotlinc            kotlin-compiler-2.1.0
#   _work/kt/junit-4.13.2.jar
#   _work/kt/hamcrest-core-1.3.jar

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$src = Join-Path $repo 'packages\sony-camera\android\src\main\java\expo\modules\sonycamera'
$test = Join-Path $repo 'packages\sony-camera\android\src\test\java\expo\modules\sonycamera'

$kotlincExe = Join-Path $Kotlinc 'bin\kotlinc.bat'
$junit = Join-Path $Jars 'junit-4.13.2.jar'
$hamcrest = Join-Path $Jars 'hamcrest-core-1.3.jar'
$stdlib = Join-Path $Kotlinc 'lib\kotlin-stdlib.jar'
foreach ($path in @($kotlincExe, $junit, $hamcrest, $stdlib, $Java)) {
  if (-not (Test-Path $path)) { throw "缺少依赖：$path（见脚本头部注释）" }
}

$out = Join-Path $Jars 'classes'
Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $out | Out-Null

# 只编"不碰 android.*"的文件：这样测试能在 JVM 上直接跑
$files = @(
  (Join-Path $src 'SonyPtpCodec.kt'),
  (Join-Path $src 'SonyVendorCodes.kt'),
  (Join-Path $src 'SonyPtpProperties.kt'),
  (Join-Path $src 'SonyPtpDeviceInfo.kt'),
  (Join-Path $src 'SonySsdpDiscovery.kt'),
  (Join-Path $src 'SonyExposure.kt'),
  (Join-Path $test 'SonyPtpCodecTest.kt'),
  (Join-Path $test 'SonyObjectPayloadTest.kt'),
  (Join-Path $test 'SonyPropertyArrayTest.kt'),
  (Join-Path $test 'SonyExposureTest.kt')
)
foreach ($file in $files) { if (-not (Test-Path $file)) { throw "缺少源文件：$file" } }

& $kotlincExe -cp "$junit;$hamcrest" -d $out $files
if ($LASTEXITCODE -ne 0) { throw 'Kotlin 编译失败' }

$classpath = "$out;$junit;$hamcrest;$stdlib"
$classes = @(
  'expo.modules.sonycamera.SonyPtpCodecTest',
  'expo.modules.sonycamera.SonyPtpPropertiesTest',
  'expo.modules.sonycamera.SonyPtpDeviceInfoTest',
  'expo.modules.sonycamera.SonySsdpDiscoveryTest',
  'expo.modules.sonycamera.SonyObjectPayloadTest',
  'expo.modules.sonycamera.SonyPropertyArrayTest',
  'expo.modules.sonycamera.SonyExposureTest'
)
& $Java -cp $classpath org.junit.runner.JUnitCore @classes
if ($LASTEXITCODE -ne 0) { throw 'Kotlin 单测未通过' }
