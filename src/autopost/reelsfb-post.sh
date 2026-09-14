#!/bin/sh
# One upload+scheduling cycle for cartoonMornings reels.
# Queues any NEW reels on Facebook's servers (video_state=SCHEDULED,
# random 2-3h gaps); Facebook publishes them at the scheduled times.
cd "/e/NH/NextJS/VideoProcessor" || exit 1
exec python src/autopost/schedule_pending.py
