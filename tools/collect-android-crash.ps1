param(
    [string]$Serial,
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$package = 'io.github.iurni.singbox.baidu'
$adbCommand = Get-Command adb -ErrorAction Stop

function Read-Adb([string[]]$Arguments) {
    $result = & $adbCommand.Source @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($result -join "`n") }
    return ($result -join "`n")
}

if (-not $Serial) {
    $listing = Read-Adb @('devices')
    $phones = @([regex]::Matches($listing, '(?m)^([^\s]+)\s+device\s*$') |
        ForEach-Object { $_.Groups[1].Value } |
        Where-Object { -not $_.StartsWith('emulator-') })
    if ($phones.Count -ne 1) {
        throw 'Connect one phone with USB debugging authorized, or specify -Serial. No phone data was changed.'
    }
    $Serial = $phones[0]
}
if (-not $OutputDirectory) {
    $OutputDirectory = Join-Path $PSScriptRoot ("..\dist\android-crash-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
}
$destination = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $destination | Out-Null

$details = foreach ($property in @('ro.product.manufacturer', 'ro.product.model', 'ro.build.version.release', 'ro.build.version.sdk', 'ro.product.cpu.abilist')) {
    "$property=$(Read-Adb @('-s', $Serial, 'shell', 'getprop', $property))"
}
$details += "page_size=$(Read-Adb @('-s', $Serial, 'shell', 'getconf', 'PAGE_SIZE'))"
$details | Set-Content -LiteralPath (Join-Path $destination 'device.txt') -Encoding utf8

$exits = Read-Adb @('-s', $Serial, 'shell', 'dumpsys', 'activity', 'exit-info', $package)
$exits | Set-Content -LiteralPath (Join-Path $destination 'app-exit-info.txt') -Encoding utf8
$lastPid = [regex]::Match($exits, 'timestamp=[^\r\n]*?\bpid=(\d+)\b')
if ($lastPid.Success) {
    $logs = Read-Adb @('-s', $Serial, 'logcat', '-d', '-b', 'main', '-b', 'system', '-b', 'crash', '-v', 'threadtime', "--pid=$($lastPid.Groups[1].Value)")
    $logs | Set-Content -LiteralPath (Join-Path $destination 'app-logcat.txt') -Encoding utf8
} else {
    'No process exit record found. Open SFA Baidu once to reproduce, then run this collector again.' |
        Set-Content -LiteralPath (Join-Path $destination 'app-logcat.txt') -Encoding utf8
}

# Native tombstones are emitted by debuggerd with a different PID. Keep only
# complete crash sections naming our package rather than other apps' reports.
$crashBuffer = Read-Adb @('-s', $Serial, 'logcat', '-d', '-b', 'crash', '-v', 'brief')
$sections = [regex]::Split($crashBuffer, '(?m)(?=^[FE]/(?:libc|AndroidRuntime)\s*\([^)]*\): (?:Fatal signal|FATAL EXCEPTION))')
$packageMarker = '(?:Cmdline:|Process:|>>>)\s+' + [regex]::Escape($package) + '(?:[,<\s]|$)'
$appCrashes = @($sections | Where-Object { $_ -match $packageMarker })
($appCrashes -join "`n") | Set-Content -LiteralPath (Join-Path $destination 'app-crash-buffer.txt') -Encoding utf8

Write-Output "Saved app crash diagnostics to $destination"
Write-Output 'This collector does not install apps, change settings, clear logs, or read VPN configurations.'
