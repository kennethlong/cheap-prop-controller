@echo off
setlocal
cd /d "%~dp0"
set "CPC_PROJECTS_DIRECTORY=%~dp0projects"
for /f "delims=" %%V in ('powershell -NoProfile -Command "(ConvertFrom-Json -InputObject (Get-Content -Raw package.json)).version"') do set "CPC_VERSION=%%V"
if exist "release\%CPC_VERSION%\win-unpacked\Cheap Prop Controller.exe" (
  start "" "release\%CPC_VERSION%\win-unpacked\Cheap Prop Controller.exe"
) else if exist "release\win-unpacked\Cheap Prop Controller.exe" (
  start "" "release\win-unpacked\Cheap Prop Controller.exe"
) else (
  call npm start
)
