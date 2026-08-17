@echo off
cd /d "%~dp0"

echo Campus Connect
if not exist node_modules call npm install

echo.
echo Make sure MySQL is running and campus_connect.sql is imported.
echo Open: http://localhost:3000
node server.js
pause
