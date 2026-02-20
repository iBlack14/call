@echo off
setlocal
cd /d "%~dp0"

echo Deteniendo servicios de KENIA...

set "STOPPED=0"

:: 1. Detener por archivos PID (forma mas limpia)
call :kill_from_pid_file ".run\server_calls.pid"
call :kill_from_pid_file ".run\server_whatsapp.pid"
call :kill_from_pid_file ".run\ngrok_multi.pid"

:: 2. Limpieza forzada por puertos (por si fallaron los PID)
:: Puerto 3000 (Llamadas) y 3010 (WhatsApp)
call :kill_by_port 3000
call :kill_by_port 3010

:: 3. Detener cualquier instancia de Ngrok sobrante
taskkill /IM ngrok.exe /F >nul 2>&1

:: Limpiar archivos temporales
del ".run\ngrok_calls_url.txt" >nul 2>&1
del ".run\ngrok_whatsapp_url.txt" >nul 2>&1
del ".run\ngrok_multi.yml" >nul 2>&1

if %STOPPED%==0 (
  echo No se encontraron procesos activos.
) else (
  echo Todos los servicios detenidos correctamente.
)

exit /b 0

:: --- FUNCIONES ---

:kill_from_pid_file
set "PF=%~1"
if not exist "%PF%" goto :eof
set "PID="
set /p PID=<"%PF%"
if not "%PID%"=="" (
  taskkill /PID %PID% /T /F >nul 2>&1
  set "STOPPED=1"
)
del "%PF%" >nul 2>&1
goto :eof

:kill_by_port
set "PORT=%~1"
echo Liberando puerto %PORT%...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { " ^
  "  $conn = Get-NetTCPConnection -LocalPort %PORT% -ErrorAction SilentlyContinue; " ^
  "  if ($conn) { " ^
  "    foreach ($c in $conn) { " ^
  "      if ($c.OwningProcess -gt 0) { " ^
  "        Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue; " ^
  "        Write-Output 'PID $($c.OwningProcess) detenido.'; " ^
  "      } " ^
  "    } " ^
  "    exit 0; " ^
  "  } " ^
  "} catch {}"
if not errorlevel 1 set "STOPPED=1"
goto :eof
