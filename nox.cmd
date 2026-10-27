@echo off
setlocal
set "NOX_INSTALL_DIR=%~dp0"
if not defined NOX_DATA_DIR if defined LOCALAPPDATA set "NOX_DATA_DIR=%LOCALAPPDATA%\Nox AI"
"%~dp0runtime\node.exe" "%~dp0dist\src\cli.js" %*
exit /b %errorlevel%
