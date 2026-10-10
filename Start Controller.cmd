@echo off
cd /d "%~dp0"
if exist "release\win-unpacked\Cheap Prop Controller.exe" (
  start "" "release\win-unpacked\Cheap Prop Controller.exe"
) else (
  call npm start
)
