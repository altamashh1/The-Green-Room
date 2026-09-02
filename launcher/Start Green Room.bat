@echo off
setlocal

rem One-click local launcher for The Green Room.
for %%I in ("%~dp0..") do set "PROJECT_DIR=%%~fI"
set "BACKEND_DIR=%PROJECT_DIR%\backend"
set "APP_URL=http://localhost:4000"
set "APP_VERSION=2026.09.02.5"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js 18 or newer is required to run The Green Room.
  echo Install it from https://nodejs.org, then run this launcher again.
  pause
  exit /b 1
)

if not exist "%BACKEND_DIR%\node_modules\express\package.json" (
  echo Installing backend dependencies. This only happens the first time.
  call npm --prefix "%BACKEND_DIR%" install
  if errorlevel 1 (
    echo.
    echo Dependencies could not be installed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

rem Reuse only the current app version. If an older Green Room server is open,
rem stop it first so the launcher never serves stale frontend or backend code.
powershell -NoProfile -Command "try { $r = Invoke-RestMethod -TimeoutSec 1 '%APP_URL%/api/health'; if ($r.app -eq 'green-room' -and $r.version -eq '%APP_VERSION%') { exit 0 } } catch {}; exit 1" >nul 2>&1
if errorlevel 1 (
  powershell -NoProfile -Command "try { $r = Invoke-RestMethod -TimeoutSec 1 '%APP_URL%/api/health'; if ($r.ok -eq $true) { $p = Get-NetTCPConnection -LocalPort 4000 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess; if ($p) { Stop-Process -Id $p -Force } } } catch {}; exit 0" >nul 2>&1
  powershell -NoProfile -Command "Start-Process -FilePath 'npm.cmd' -ArgumentList 'start' -WorkingDirectory '%BACKEND_DIR%'"
)

echo Starting The Green Room...
for /L %%I in (1,1,30) do (
  powershell -NoProfile -Command "try { $r = Invoke-RestMethod -TimeoutSec 1 '%APP_URL%/api/health'; if ($r.app -eq 'green-room' -and $r.version -eq '%APP_VERSION%') { exit 0 } } catch {}; exit 1" >nul 2>&1
  if not errorlevel 1 goto :openApp
  ping 127.0.0.1 -n 2 >nul
)

echo.
echo The app did not start within 30 seconds. Check the "Green Room Server" window for details.
pause
exit /b 1

:openApp
start "" "%APP_URL%"
exit /b 0
