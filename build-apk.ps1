# 一键重新构建 APK（改了 www/ 里的客户端代码后运行本脚本）
# 用法：右键“用 PowerShell 运行”，或在终端执行：  ./build-apk.ps1
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

# 指向本项目内已安装的 JDK / Android SDK
$env:JAVA_HOME = "$root\tools\jdk\jdk-17.0.19+10"
$env:ANDROID_HOME = "$root\tools\android-sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME
$env:PATH = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$env:PATH"

Write-Host "[1/3] 同步 www 到 Android 工程 ..." -ForegroundColor Cyan
npx cap sync android

Write-Host "[2/3] 构建 debug APK ..." -ForegroundColor Cyan
Set-Location "$root\android"
.\gradlew.bat assembleDebug --no-daemon --console=plain
Set-Location $root

Write-Host "[3/3] 复制产物 ..." -ForegroundColor Cyan
Copy-Item "android\app\build\outputs\apk\debug\app-debug.apk" "texas-holdem.apk" -Force
Write-Host ("完成！APK 路径： " + (Join-Path $root "texas-holdem.apk")) -ForegroundColor Green
