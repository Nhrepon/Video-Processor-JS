@echo off
cd /d "E:\NH\NextJS\VideoProcessor"
rem One upload+scheduling cycle: queues any NEW reels on Facebook's servers
rem (video_state=SCHEDULED, random 2-3h gaps). Facebook publishes them itself.
"C:\Users\RHYTHM CARE LTD\AppData\Local\Programs\Python\Python314\python.exe" src\autopost\schedule_pending.py >> src\autopost\config\reelsfb-cron.log 2>&1
