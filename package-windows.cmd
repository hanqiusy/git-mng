@echo off
setlocal

cd /d "%~dp0"
echo.
echo Building the Windows executable...
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-windows.ps1"
set "BUILD_EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%BUILD_EXIT_CODE%"=="0" (
  echo Build failed with exit code %BUILD_EXIT_CODE%.
) else (
  echo Build completed successfully.
)
echo.
pause
exit /b %BUILD_EXIT_CODE%
