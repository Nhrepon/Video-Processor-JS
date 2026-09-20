@echo off
REM cartoon-daily.cmd — Windows Scheduled Task wrapper for the daily pipeline
REM Runs node src/scripts/cartoon_daily_pipeline.js and logs output

set REPO=E:\NH\NextJS\VideoProcessor
set LOGFILE=%REPO%\src\autopost\config\daily-pipeline.log

echo [%date% %time%] Starting daily pipeline >> "%LOGFILE%"

cd /d "%REPO%"

node src\scripts\cartoon_daily_pipeline.js >> "%LOGFILE%" 2>&1

set EXITCODE=%ERRORLEVEL%

echo [%date% %time%] Pipeline exit code: %EXITCODE% >> "%LOGFILE%"

exit /b %EXITCODE%
