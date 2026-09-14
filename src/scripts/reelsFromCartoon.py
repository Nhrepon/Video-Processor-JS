#!/usr/bin/env python3
"""
Generate short 9:16 reels from cartoon video with branding.
Splits video into multiple parts with random durations (20-90s).
"""
import subprocess
import sys
import json
import random
from pathlib import Path


# Config
REPO = Path(r"E:\NH\NextJS\VideoProcessor")
INPUT_DIR = REPO / "src" / "input"
OUTPUT_DIR = REPO / "src" / "output" / "reels"
AUDIO_DIR = REPO / "src" / "audio"
ASSETS_DIR = REPO / "src" / "assets"

# Output specs
OUT_W, OUT_H = 1080, 1920  # 9:16 vertical
SAFE_TOP = 200  # Top safe zone height (for logo + title)
SAFE_BOTTOM = 200  # Bottom safe zone height (for subtitle text)

# Default: split into 10 parts
MIN_DURATION = 20  # Minimum duration for each part
MAX_DURATION = 90  # Maximum duration for each part
DEFAULT_NUM_PARTS = 10

def getRandomDuration() -> int:
    return random.randint(MIN_DURATION, MAX_DURATION)


def probe(path: str) -> dict:
    cmd = ["ffprobe", "-v", "quiet", "-print_format", "json",
           "-show_format", "-show_streams", path]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    data = json.loads(r.stdout)
    vs = next((s for s in data["streams"] if s["codec_type"] == "video"), None)
    fps = eval(vs["r_frame_rate"]) if "/" in vs["r_frame_rate"] else 30
    return {
        "w": int(vs["width"]),
        "h": int(vs["height"]),
        "dur": float(data["format"]["duration"]),
        "fps": fps,
        "has_audio": any(s["codec_type"] == "audio" for s in data["streams"])
    }


def get_bg_music() -> str | None:
    """Pick a random background music track."""
    if not AUDIO_DIR.exists():
        return None
    tracks = list(AUDIO_DIR.glob("*.mp4")) + list(AUDIO_DIR.glob("*.mp3"))
    return str(random.choice(tracks)) if tracks else None


def build_filter(orig_w: int, orig_h: int, has_logo: bool, has_music: bool, has_orig_audio: bool) -> tuple:
    """Build simple ffmpeg filter_complex string."""
    
    fc = []
    
    # Scale so height fills 1920, then crop center width to 1080
    new_w = int(orig_w * OUT_H / orig_h)
    fc.append(f"[0:v]scale={new_w}:{OUT_H}[wide]")
    
    # Crop center to 1080x1920
    crop_x = (new_w - OUT_W) // 2
    fc.append(f"[wide]crop={OUT_W}:{OUT_H}:{crop_x}:0[cropped]")
    
    # Add black bars for safe zones
    fc.append(f"[cropped]drawbox=x=0:y=0:w={OUT_W}:h={SAFE_TOP}:color=black:t=fill[topbar]")
    fc.append(f"[topbar]drawbox=x=0:y={OUT_H-SAFE_BOTTOM}:w={OUT_W}:h={SAFE_BOTTOM}:color=blue@0.7:t=fill[bottombar]")
    
    # Add logo overlay in top right
    if has_logo:
        fc.append("[1:v]scale=100:-1[logo]")
        fc.append(f"[bottombar][logo]overlay={OUT_W-120}:{(SAFE_TOP//2)-10}[output]")
    else:
        fc.append("[bottombar][output]")
    
    # Audio processing
    audio_filters = []
    if has_music:
        audio_filters.append("[2:a]volume=0.25[music]")
        if has_orig_audio:
            audio_filters.append("[0:a]volume=0.3[orig]")
            audio_filters.append("[orig][music]amix=inputs=2:duration=first[outa]")
        else:
            audio_filters.append("[music][outa]")
    elif has_orig_audio:
        audio_filters.append("[0:a]volume=0.5[outa]")
    else:
        audio_filters.append("anullsrc=channel_layout=stereo:sample_rate=44100[outa]")
    
    fc.extend(audio_filters)
    
    return ";".join(fc), 1 + (1 if has_logo else 0) + (1 if has_music else 0)


def process(input_path: str, num_parts: int = DEFAULT_NUM_PARTS) -> list:
    print(f"\n{'='*60}")
    print(f"Processing: {Path(input_path).name}")
    print(f"Will generate {num_parts} reels (9:16 format)")
    print(f"{'='*60}")
    
    info = probe(input_path)
    orig_w, orig_h = info["w"], info["h"]
    duration = info["dur"]
    fps = info["fps"]
    has_orig_audio = info["has_audio"]
    
    print(f"Input: {orig_w}x{orig_h}, {duration:.1f}s total")
    print(f"Target: {OUT_W}x{OUT_H} (9:16)")
    print(f"Each reel: 20-90s (random)")
    
    # Check assets
    logo_path = ASSETS_DIR / "logo.png"
    has_logo = logo_path.exists()
    bg_music = get_bg_music()
    has_music = bg_music is not None
    
    print(f"Logo: {'✓' if has_logo else '✗'}")
    print(f"Background music: {'✓ ' + Path(bg_music).name if has_music else '✗'}")
    
    # Build filter
    filter_str, num_inputs = build_filter(orig_w, orig_h, has_logo, has_music, has_orig_audio)
    print(f"Filter: {len(filter_str)} chars")
    
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    
    outputs = []
    current_time = 0
    
    for i in range(num_parts):
        # Random duration between 20-90 seconds
        part_duration = min(random.randint(20, 90), duration - current_time)
        
        start = current_time
        end = min(start + part_duration, duration)
        part_dur = end - start
        
        name = f"reel-{i+1:02d}-{int(part_dur)}s.mp4"
        out = OUTPUT_DIR / name
        
        print(f"\nPart {i+1}/{num_parts}: {start:.0f}s-{end:.0f}s ({part_dur:.1f}s)")
        
        cmd = ["ffmpeg", "-y", "-ss", str(start), "-i", input_path, "-t", str(part_dur)]
        
        # Add extra inputs
        input_idx = 1
        if has_logo:
            cmd.extend(["-loop", "1", "-t", str(part_dur), "-i", str(logo_path)])
            input_idx += 1
        if has_music:
            cmd.extend(["-i", str(bg_music)])
            input_idx += 1
        
        cmd.extend([
            "-filter_complex", filter_str,
            "-map", "[output]",
            "-map", "[outa]",
            "-c:v", "libx264", "-crf", "22", "-preset", "fast",
            "-pix_fmt", "yuv420p", "-r", "30",
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            str(out)
        ])
        
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
        if r.returncode == 0 and out.exists() and out.stat().st_size > 50000:
            size = out.stat().st_size / 1024 / 1024
            print(f"  ✓ {size:.1f}MB")
            outputs.append(str(out))
            current_time = end  # Move to next segment
        else:
            print(f"  ✗ Failed (rc={r.returncode}, size={out.stat().st_size if out.exists() else 0})")
            if r.stderr:
                lines = [l for l in r.stderr.split('\n') if 'error' in l.lower() or 'fail' in l.lower()]
                for line in lines[-3:]:
                    if line.strip():
                        print(f"    {line[:120]}")
    
    return outputs


def main():
    import argparse
    p = argparse.ArgumentParser()
    p.add_argument("input", nargs="?", help="Input video file")
    p.add_argument("--parts", type=int, default=DEFAULT_NUM_PARTS, help=f"Number of reels to generate (default: {DEFAULT_NUM_PARTS})")
    args = p.parse_args()
    
    if args.input:
        inp = Path(args.input)
        if not inp.is_absolute():
            inp = REPO / inp
    else:
        candidates = list(INPUT_DIR.glob("*.mp4"))
        if not candidates:
            print(f"No .mp4 in {INPUT_DIR}")
            sys.exit(1)
        inp = candidates[0]
    
    if not inp.exists():
        print(f"Not found: {inp}")
        sys.exit(1)
    
    outputs = process(str(inp), args.parts)
    
    if outputs:
        print(f"\n{'='*60}")
        print(f"✓ Generated {len(outputs)} reel(s)")
        for o in outputs:
            size_mb = Path(o).stat().st_size / 1024 / 1024
            print(f"  {Path(o).name} ({size_mb:.1f}MB)")
        print(f"Output dir: {OUTPUT_DIR}")
        print(f"{'='*60}")
    else:
        print("\n✗ No output generated")
        sys.exit(1)


if __name__ == "__main__":
    main()
