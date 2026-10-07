# Run BiliLite smoke tests locally (works on Windows PowerShell 5.1).
#
# Notes (why this script looks odd):
#  * Launching Electron from inside the workspace crashes before Chromium init
#    (STATUS_BREAKPOINT), so we pass --no-sandbox --disable-gpu --user-data-dir=<writable dir in workspace>.
#  * This machine exports ELECTRON_RUN_AS_NODE=1 by default, which turns Electron into Node: remove it.
#  * node / pnpm are not on PATH, and the pnpm "build" script spawns "node" internally, so prepend it.
#  * PowerShell prints child stderr as NativeCommandError, so `pnpm build` may report exit 1 even on success:
#    judge the build by looking for "built in".
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools\run-smoke.ps1                 # full smoke
#   powershell -ExecutionPolicy Bypass -File tools\run-smoke.ps1 -SkipBuild
#   powershell -ExecutionPolicy Bypass -File tools\run-smoke.ps1 -Theme light -Shots
param(
  [switch]$SkipBuild,
  [switch]$Shots,
  [string]$Theme = '',
  [string]$Tag = 'local'
)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue

$nodeDir = 'C:\Users\zouyx\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin'
$pnpmJs = 'C:\Users\zouyx\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\pnpm\bin\pnpm.mjs'
$env:PATH = "$nodeDir;$env:PATH"

if (-not $SkipBuild) {
  Write-Host '=== build (electron-vite build) ==='
  & "$nodeDir\node.exe" $pnpmJs build 2>&1 | Select-Object -Last 14
}

$ud = Join-Path $root "tmp-ud-$Tag"
$out = Join-Path $root "smoke-$Tag-report.txt"
$run = Join-Path $root "smoke-$Tag-run.out"

$env:STUDY_SMOKE = '1'
$env:STUDY_SMOKE_OUT = $out
$env:STUDY_USER_DATA = $ud
Remove-Item Env:STUDY_SMOKE_BOOKS -ErrorAction SilentlyContinue
if ($Shots) { $env:STUDY_SMOKE_SHOT = Join-Path $root "shots-$Tag" } else { Remove-Item Env:STUDY_SMOKE_SHOT -ErrorAction SilentlyContinue }
if ($Theme) { $env:STUDY_SMOKE_THEME = $Theme } else { Remove-Item Env:STUDY_SMOKE_THEME -ErrorAction SilentlyContinue }

Write-Host "=== launch electron (user data: $ud) ==="
& cmd /c "`"$root\node_modules\electron\dist\electron.exe`" . --no-sandbox --disable-gpu --user-data-dir=`"$ud`" > `"$run`" 2>&1"
$code = $LASTEXITCODE
Write-Host "=== electron exit code = $code (full smoke: equals failure count) ==="
Write-Host "report: $out"
if (Test-Path $out) { Get-Content $out -Encoding UTF8 | Select-Object -Last 6 }
exit $code
