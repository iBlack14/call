@echo off
setlocal ENABLEDELAYEDEXPANSION

:: Ir al directorio del script
cd /d "%~dp0"

echo ===========================================
echo       INICIANDO SERVICIOS DE KENIA        
echo ===========================================

set "CALLS_PORT=3000"
set "WA_PORT=3010"

:: 1. Asegurar que no haya nada corriendo antes
echo [1/5] Limpiando procesos previos...
call stop_bg_ngrok.bat >nul 2>&1
timeout /t 2 /nobreak >nul

:: Crear carpeta temporal si no existe
if not exist ".run" mkdir ".run"

:: 2. Verificaciones básicas (Node, npm, ngrok)
echo [2/5] Verificando dependencias...
where /q node || (echo [ERROR] Instala Node.js primero && exit /b 1)
where /q npm || (echo [ERROR] Instala npm primero && exit /b 1)
where /q ngrok || (echo [ERROR] Instala ngrok primero && exit /b 1)

if not exist "whatsapp-backend\package.json" (
  echo [ERROR] No existe la carpeta whatsapp-backend o falta package.json
  exit /b 1
)

:: 3. Iniciar Servidores en segundo plano
echo [3/5] Iniciando servidores (Llamadas: %CALLS_PORT%, WhatsApp: %WA_PORT%)...

:: Servidor de LLAMADAS
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$proc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','set PORT=%CALLS_PORT% && npm run start:calls >> .run\server_calls.log 2>>&1' -WorkingDirectory '%CD%' -WindowStyle Hidden -PassThru; " ^
  "$proc.Id | Out-File -FilePath '.run\server_calls.pid' -Encoding ascii"

:: Servidor de WHATSAPP
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$proc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','set PORT=%WA_PORT% && npm run start:whatsapp >> .run\server_whatsapp.log 2>>&1' -WorkingDirectory '%CD%' -WindowStyle Hidden -PassThru; " ^
  "$proc.Id | Out-File -FilePath '.run\server_whatsapp.pid' -Encoding ascii"

:: 4. Configurar e Iniciar NGROK (Solo un tunel para evitar conflictos)
echo [4/5] Configurando túnel de Ngrok...
(
  echo version: "2"
  echo tunnels:
  echo   kenia:
  echo     proto: http
  echo     addr: %CALLS_PORT%
) > ".run\ngrok_multi.yml"

:: Iniciar Ngrok
set "NGROK_CFG=.run\ngrok_multi.yml"
if exist ".run\ngrok_auth.yml" set "NGROK_CFG=.run\ngrok_auth.yml,.run\ngrok_multi.yml"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$proc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','ngrok start kenia --config %NGROK_CFG% --log=stdout > .run\ngrok_multi.log 2>>&1' -WorkingDirectory '%CD%' -WindowStyle Hidden -PassThru; " ^
  "$proc.Id | Out-File -FilePath '.run\ngrok_multi.pid' -Encoding ascii"

:: 5. Esperar y Mostrar URL
echo [5/5] Esperando URL publica (esto tardara unos 10 seg)...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$url=''; " ^
  "for($i=0; $i -lt 15; $i++) { " ^
  "  try { " ^
  "    $t = Invoke-RestMethod -Uri 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 2; " ^
  "    if ($t.tunnels) { " ^
  "      $url = $t.tunnels[0].public_url; " ^
  "    } " ^
  "  } catch {} " ^
  "  if ($url) { break } " ^
  "  Start-Sleep -Seconds 1; " ^
  "} " ^
  "if ($url) { $url | Out-File -FilePath '.run\ngrok_url.txt' -Encoding ascii }"

:: Leer la URL guardada
set "URL_FINAL=Faltante"
if exist ".run\ngrok_url.txt" set /p URL_FINAL=<".run\ngrok_url.txt"

echo.
echo ===========================================
echo       SISTEMA LISTO EN SEGUNDO PLANO      
echo ===========================================
echo URL LOCAL:  http://localhost:%CALLS_PORT%
echo URL PUBLIC: %URL_FINAL%
echo ===========================================
echo (WhatsApp se accede via %URL_FINAL%/api/whatsapp)
echo ===========================================
echo.
echo Abriendo monitoreo de logs...
start "LOG LLAMADAS" powershell -NoExit -Command "Get-Content -Path '.run\server_calls.log' -Wait -Tail 50"
start "LOG WHATSAPP" powershell -NoExit -Command "Get-Content -Path '.run\server_whatsapp.log' -Wait -Tail 50"

echo.
echo TIP: Para detener todo, ejecuta: stop_bg_ngrok.bat
echo.
pause
exit /b 0
