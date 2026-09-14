import subprocess, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent

# One upload+scheduling cycle: queues any NEW reels on Facebook's servers
# (video_state=SCHEDULED, random 2-3h gaps). Facebook publishes them itself.
result = subprocess.run(
    [sys.executable, str(HERE / "schedule_pending.py")],
    cwd=str(REPO),
)
sys.exit(result.returncode)
