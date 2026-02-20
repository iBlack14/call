@echo off
setlocal
cd /d "%~dp0"
set "CALLS_PORT=3000"
echo Testing process start...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$proc = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','echo hello > .run\test_start.log' -PassThru; " ^
  "$proc.Id | Out-File -FilePath '.run\test_start.pid' -Encoding ascii"
echo Done.
pause
