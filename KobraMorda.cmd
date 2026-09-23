@echo off
rem Builds (if needed) and runs KobraMorda in this window. Printers are added in the dashboard.
cd /d "%~dp0backend"
if not exist dist\server.js call npm run build
node dist\server.js
