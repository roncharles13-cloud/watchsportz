@echo off
REM WatchSportZ local canary — wrapper for Windows Task Scheduler.
REM Runs one canary pass and appends output to canary.log next to this file.
cd /d "%~dp0"
node canary-local.mjs >> canary.log 2>&1
