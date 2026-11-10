@echo off
setlocal
set "ROOT=%~dp0.."
pushd "%ROOT%"

rem ---------------------------------------------------------------------------
rem Coffee CLI - local dev launcher (Windows)
rem
rem Why this script exists:
rem   1. Git Bash ships its own link.exe (GNU coreutils) which shadows the MSVC
rem      linker, so `cargo build` fails with "link: extra operand". We put the
rem      MSVC bin directory first on PATH before building.
rem   2. The repo has no root package.json and no cargo-tauri, so `tauri dev`
rem      is not available. Dev mode = vite on 127.0.0.1:5173 + debug binary
rem      built with `devUrl` from tauri.conf.json.
rem ---------------------------------------------------------------------------

rem --- locate the newest MSVC toolset -----------------------------------------
rem Paths are held in variables on purpose: a literal "(x86)" inside a for
rem collection makes cmd close the group early ("\Microsoft was unexpected").
set "VS1=%ProgramFiles(x86)%\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC"
set "VS2=%ProgramFiles%\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC"
set "VS3=%ProgramFiles(x86)%\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC"
set "VS4=%ProgramFiles%\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC"

set "MSVC_BIN="
for /d %%D in ("%VS1%\*") do set "MSVC_BIN=%%~fD\bin\Hostx64\x64"
for /d %%D in ("%VS2%\*") do set "MSVC_BIN=%%~fD\bin\Hostx64\x64"
for /d %%D in ("%VS3%\*") do set "MSVC_BIN=%%~fD\bin\Hostx64\x64"
for /d %%D in ("%VS4%\*") do set "MSVC_BIN=%%~fD\bin\Hostx64\x64"

if defined MSVC_BIN (
  set "PATH=%MSVC_BIN%;%PATH%"
  echo [dev] msvc: "%MSVC_BIN%"
) else (
  echo [dev] WARNING: MSVC toolset not found - build will fail at link time.
  echo [dev] install: winget install Microsoft.VisualStudio.2022.BuildTools ^
    --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
)

rem --- build the debug binary on every run ------------------------------------
rem Always rebuild so backend edits are never silently skipped (cargo is
rem incremental: a no-op change is a few seconds). If the previous run left the
rem app open, the final link fails with "Access is denied" because the exe is
rem locked — close the running Coffee CLI first.
echo [dev] building backend...
cargo build
if errorlevel 1 goto :fail

rem --- make sure the vite dev server is up ------------------------------------
netstat -ano | findstr /r /c:":5173 .*LISTENING" >nul 2>&1
if errorlevel 1 (
  echo [dev] starting vite dev server in a new window...
  start "Coffee CLI dev UI" /D "%ROOT%\src-ui" cmd /k "npm run dev"
  timeout /t 5 /nobreak >nul
) else (
  echo [dev] vite already listening on 127.0.0.1:5173
)

rem --- launch the app ---------------------------------------------------------
echo [dev] launching Coffee CLI...
start "" "%ROOT%\target\debug\coffee-cli.exe"

popd
exit /b 0

:fail
echo [dev] build failed.
popd
exit /b 1
