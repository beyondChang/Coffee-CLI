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
rem      is not available. Dev mode = vite on 127.0.0.1:5174 + debug binary
rem      built with `devUrl` from tauri.conf.json.
rem   3. Toolchains may live on D:\soft instead of the default Program Files
rem      paths. We probe both, call vcvars64.bat when available, and append the
rem      Windows SDK Include/Lib/bin paths (some SDK installs omit them).
rem ---------------------------------------------------------------------------

set "PF86=%ProgramFiles(x86)%"
set "PF=%ProgramFiles%"

rem --- locate MSVC vcvars64.bat (default drives + D:\soft) ---------------------
set "VCVARS="
if exist "%PF86%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=%PF86%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if exist "%PF%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=%PF%\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if exist "%PF86%\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=%PF86%\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
if exist "%PF%\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=%PF%\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
if exist "D:\soft\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=D:\soft\Microsoft Visual Studio\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if exist "D:\soft\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=D:\soft\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat"

if defined VCVARS goto :have_vcvars

rem --- fallback: bare MSVC toolset (no vcvars script) -------------------------
set "MSVCROOT="
if exist "%PF86%\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC" set "MSVCROOT=%PF86%\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC"
if exist "%PF%\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC" set "MSVCROOT=%PF%\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC"
if exist "%PF86%\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC" set "MSVCROOT=%PF86%\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC"
if exist "%PF%\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC" set "MSVCROOT=%PF%\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC"
if exist "D:\soft\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC" set "MSVCROOT=D:\soft\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC"
if exist "D:\soft\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC" set "MSVCROOT=D:\soft\Microsoft Visual Studio\2022\Community\VC\Tools\MSVC"
if not defined MSVCROOT goto :no_msvc
pushd "%MSVCROOT%"
for /d %%D in (*) do set "MSVC_BIN=%MSVCROOT%\%%D\bin\Hostx64\x64"
popd
if not defined MSVC_BIN goto :no_msvc
set "PATH=%MSVC_BIN%;%PATH%"
echo [dev] msvc: "%MSVC_BIN%"
goto :msvc_done

:have_vcvars
echo [dev] msvc env: "%VCVARS%"
call "%VCVARS%" >nul
goto :msvc_done

:no_msvc
echo [dev] WARNING: MSVC toolset not found - build will fail at link time.
echo [dev] install: winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"

:msvc_done

rem --- locate Windows SDK and append Include/Lib/bin --------------------------
rem vcvars64.bat does not always populate these when the SDK is off drive C.
set "SDKROOT="
if exist "%PF86%\Windows Kits\10\Include" set "SDKROOT=%PF86%\Windows Kits\10"
if exist "%PF%\Windows Kits\10\Include" set "SDKROOT=%PF%\Windows Kits\10"
if exist "D:\soft\Windows Kits\10\Include" set "SDKROOT=D:\soft\Windows Kits\10"
if not defined SDKROOT goto :no_sdk
pushd "%SDKROOT%\Include"
for /d %%D in (*) do set "SDKVER=%%D"
popd
if not defined SDKVER goto :no_sdk
set "INCLUDE=%SDKROOT%\Include\%SDKVER%\ucrt;%SDKROOT%\Include\%SDKVER%\um;%SDKROOT%\Include\%SDKVER%\shared;%INCLUDE%"
set "LIB=%SDKROOT%\Lib\%SDKVER%\um\x64;%SDKROOT%\Lib\%SDKVER%\ucrt\x64;%LIB%"
set "PATH=%SDKROOT%\bin\%SDKVER%\x64;%PATH%"
echo [dev] sdk: "%SDKROOT%" (%SDKVER%)
goto :sdk_done

:no_sdk
echo [dev] WARNING: Windows SDK not found - link may fail.

:sdk_done

rem --- build the debug binary on every run ------------------------------------
rem Always rebuild so backend edits are never silently skipped (cargo is
rem incremental: a no-op change is a few seconds). If the previous run left the
rem app open, the final link fails with "Access is denied" because the exe is
rem locked - close the running Coffee CLI first.
echo [dev] building backend...
cargo build
if errorlevel 1 goto :fail

rem --- make sure the vite dev server is up -------------------------------------
netstat -ano | findstr /r /c:":5174 .*LISTENING" >nul 2>&1
if errorlevel 1 (
  echo [dev] starting vite dev server in a new window...
  start "Coffee CLI dev UI" /D "%ROOT%\src-ui" cmd /k "npm run dev"
  timeout /t 5 /nobreak >nul
) else (
  echo [dev] vite already listening on 127.0.0.1:5174
)

rem --- launch the app ----------------------------------------------------------
echo [dev] launching Coffee CLI...
start "" "%ROOT%\target\debug\coffee-cli.exe"

popd
exit /b 0

:fail
echo [dev] build failed.
popd
exit /b 1
