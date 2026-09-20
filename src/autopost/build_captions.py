#!/usr/bin/env python3
"""
Generate unique, SEO/viral-optimized Facebook Reel captions for the cartoon
(Tom & Jerry) reels in src/autopost/video and rename the source .mp4 files to
distinct SEO-friendly names.

Produces: src/autopost/config/captions.json
  { "<newfilename.mp4>": { "caption": "...", "title": "..." }, ... }

The poster (postReelsFB.js) reads this manifest so every reel gets a different
filename, viral title and hashtag set.

Run:  python src/autopost/build_captions.py
"""
import json
import random
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent          # src/autopost
VIDEO_DIR = HERE / "video"
OUT = HERE / "config" / "captions.json"
STATE = HERE / "config" / "reelsfb-state.json"

random.seed(20260914)  # reproducible unique generation

# ---------------------------------------------------------------- word banks
# Hooks are the first line FB indexes hardest for Reels search; variety +
# keyword coverage widens the audience surface. Mix of POV / question / list /
# challenge / save-bait / share-bait / nostalgia / open-loop formats.
HOOKS = [
    # POV format
    "POV: Jerry just outsmarted Tom AGAIN 😆 tag the friend who always roots for the underdog!",
    "POV: You're the mouse who always wins 🐭 this is YOUR energy 👑",
    "POV: You're Tom planning at 3AM 🤯 the plan backfired 😂",
    "POV: You're Jerry and Tom just set a trap 🪤 watch what happens next 😱",
    "POV: Monday energy is Jerry energy 💪 send this to someone who needs it!",
    "POV: You grew up on these cartoons 🥺 this was our childhood 🌙",
    
    # Challenge/rate
    "Rate this chase 1-10 💥 be honest, how many times have you seen THIS episode?",
    "Who is winning this?! 👀 wait for the end 🔥",
    "Prank level: 100 💀 Jerry's response: LEGENDARY 👑",
    "The comedy timing is elite 🏆 rate it 1-10 below 👇",
    "This clip is pure chaos 💀 and it gets worse 😂",
    "Name a funnier duo, I'll wait! 🏆 this is peak comedy 👑",
    
    # Nostalgia
    "This was my childhood 🌙 90s kids will remember 🥺",
    "Childhood memory unlocked 🎟️ who else watched on repeat?",
    "The rivalry that taught us pettiness is an art 🎨 90s kids raised us 👑",
    "Grew up on these cartoons? 🥺 save this for nostalgia 🌙",
    "This is the kind of content that ends friendships 👔 tag your rival!",
    "When the background music hits different mid-chase 🎶 turn it up!",
    
    # Open loop / pattern interrupt
    "Wait for the plot twist at the end 🤯 you will NOT believe what Jerry does!",
    "He set a trap for Jerry 🪤 think he got him? 😏",
    "Tom's face says it all 😤 the confidence though 💀",
    "Invisible attack 💨 Jerry strikes again 😂",
    "The plan backfired 🔥 poor Tom 😭",
    "When the tiny hero wins again 🏆 prove in comments Jerry is the GOAT!",
    
    # Save/share bait
    "Save this for your next bad day 😭 you'll thank me later 👑",
    "Tag someone who'd appreciate this 😂 they need to see it 🐭",
    "Send this to your chaos buddy 💀 no chill at 3AM 🕒",
    "Bookmark for when you need a laugh 😂 trust me on this 👑",
    "Share with your chaos partner 🐭 this is peak comedy 💀",
    "Save this for Monday motivation 💪 Jerry's energy is unmatched 👑",
    
    # Relatable / meme
    "Jerry said 'not today' 💪 the AUDACITY though 💀",
    "tom.exe has stopped working 😤 the nemesis is too powerful 😂",
    "Jerry's confidence >>> Monday energy 💪 send to someone who needs it!",
    "When they try so hard 😭 and he still fails 😂",
    "The sneakiness is unreal 🕵️ how did Jerry even get up there?!",
    "When the cartoon beef is more entertaining than real TV 📺 follow for daily chaos!",
    
    # "The X seconds when..." urgency
    "The 15 seconds when Tom lost it 😂 watch till the end 🔥",
    "That one second Tom regrets everything 😤 childhood trauma unlocked 💀",
    "The second Jerry became legend 👑 nobody expected this 😱",
    "10 seconds of pure chaos 💥 share with your chaos buddy!",
    
    # Comment bait
    "Which one are you today - Tom energy or Jerry energy? Be honest 😂",
    "The most legendary rivalry in cartoon history 🎯 who wins this round? Comment your score!",
    "Jerry really said 'I'm the main character' 🎧 drop your favorite episode name!",
    "Tom's plan: flawless. Execution: disaster 📄 comment your funniest fail!",
    "Cartoon physics will never not be funny ✨ which gag is your all-time fave?",
    "When Tom forgets he's a cat and Jerry forgets he's a mouse 🦰 chaos ensues!",
    
    # Follow bait
    "Follow for daily chaos 🐭 new cartoon reels every day!",
    "Follow @cartoonmornings for your daily dose of nostalgia 🌙",
]

# Each caption ends with a distinct hashtag set (SEO clustering + reach).
# Local tags (Bangladesh/India/SEA) for less saturated discovery.
HASHTAG_SETS = [
    ["#cartoonmornings", "#tomandjerry", "#funnycartoon", "#cartooncomedy", "#classiccartoon", "#nostalgiacartoon", "#funnyreels", "#viralreels", "#fyp", "#foryou"],
    ["#cartoonmornings", "#tomandjerry", "#cartoonrivalry", "#epicchase", "#funnymoments", "#watchtillend", "#cartoonreels", "#trendingreels", "#explorepage", "#viral"],
    ["#cartoonmornings", "#tomandjerry", "#cartoonvideo", "#funnyvideo", "#reelsvideo", "#cartoonlovers", "#fyp", "#foryoupage", "#viralvideo", "#trending"],
    ["#cartoonmornings", "#tomandjerry", "#retrocartoon", "#90skids", "#oldcartoons", "#goldenera", "#funnyclips", "#reelsfacebook", "#explore", "#foryou"],
    ["#cartoonmornings", "#tomandjerry", "#cartoonmemes", "#relatable", "#memecartoon", "#funnyreels", "#dailyreels", "#cartoonoftheday", "#viral", "#trending"],
    ["#cartoonmornings", "#tomandjerry", "#classics", "#cartoonfunny", "#comedygold", "#funnymatch", "#cartoonfans", "#reels", "#fyp", "#foryoupage"],
    # Local/SEA discovery tags
    ["#cartoonmornings", "#tomandjerry", "#bangladesh", "#dhaka", "#90skids", "#funnyreels", "#viralreels", "#fyp", "#foryou", "#desi"],
    ["#cartoonmornings", "#tomandjerry", "#india", "#90skidsindia", "#oldcartoons", "#funnyclips", "#viral", "#trending", "#fyp", "#foryoupage"],
    ["#cartoonmornings", "#tomandjerry", "#sea", "#asean", "#nostalgia", "#childhood", "#funnyreels", "#viralreels", "#fyp", "#foryou"],
    ["#cartoonmornings", "#tomandjerry", "#desi", "#southasia", "#90skids", "#cartoonreels", "#funnyreels", "#viral", "#fyp", "#foryou"],
    # USA/international tags
    ["#cartoonmornings", "#tomandjerry", "#usa", "#american", "#funnyreels", "#viralreels", "#fyp", "#foryou", "#cartoonreels", "#trending"],
    ["#cartoonmornings", "#tomandjerry", "#hollywood", "#classiccartoon", "#oldcartoons", "#funnyclips", "#viral", "#trending", "#fyp", "#foryoupage"],
    ["#cartoonmornings", "#tomandjerry", "#international", "#worldwide", "#funnyreels", "#viralreels", "#fyp", "#foryou", "#cartoonreels", "#explore"],
]

# Short SEO keyword slugs used to build unique file names.
SLUGS = [
    "jerry-outsmarts-tom", "midnight-prank-war", "rate-this-chase", "plot-twist-ending",
    "tom-3am-plan", "tom-vs-jerry-energy", "legendary-rivalry", "childhood-cartoon-feels",
    "jerry-comeback", "unseen-plot-twist", "prank-level-100", "tom-plan-jerry-laughs",
    "jerry-stealth", "memory-unlocked", "chase-music-hits", "jerry-revenge-arc",
    "tom-tries-again", "pure-chaos-clip", "cartoon-logic", "jerry-confidence",
    "face-off-round2", "tom-fails-again", "tiny-hero-wins", "cartoon-physics",
    "jerry-main-character", "pettiness-art", "cat-mouse-chaos", "ends-friendships",
    "jerry-stealth-wins", "elite-timing", "chase-song", "tom-backfires",
    "jerry-heist", "beef-entertaining", "mouse-has-aura", "slowmo-defeat",
    "jerry-winning-streak", "good-prank", "classic-duo", "better-trap",
    "sound-effect-comic", "jerry-exit-award",
]


def build_captions(n):
    """Return list of (title, caption) with guaranteed-unique hooks+hashtags."""
    if n > len(HOOKS):
        raise ValueError(f"need {n} unique hooks, only {len(HOOKS)} defined")
    if n > len(SLUGS):
        raise ValueError(f"need {n} unique slugs, only {len(SLUGS)} defined")
    chosen = []
    seen_hooks = set()
    seen_tags = set()
    idxs = list(range(len(HOOKS)))
    random.shuffle(idxs)
    for i in idxs:
        hook = HOOKS[i]
        if hook in seen_hooks:
            continue
        seen_hooks.add(hook)
        tags = HASHTAG_SETS[i % len(HASHTAG_SETS)]
        key = hook + "|" + " ".join(tags)
        if key in seen_tags:
            continue
        seen_tags.add(key)
        # title = hook with emoji/punctuation noise stripped, for the manifest
        title = re.sub(
            r"[\U0001F000-\U0001FAFF\u2600-\u27BF\u2190-\u21FF\u2B00-\u2BFF]",
            "", hook,
        )
        title = re.sub(r"\s+", " ", title).strip().rstrip("!?").strip()
        caption = f"{hook}\n.\n.\n.\n" + " ".join(tags)
        chosen.append((title, caption))
        if len(chosen) == n:
            break
    if len(chosen) < n:
        raise RuntimeError(f"only generated {len(chosen)} unique captions")
    return chosen


def next_batch_label():
    """Auto-detect next batch label (b3, b4, b5...) from existing files."""
    max_b = 2  # start looking from b3
    for f in VIDEO_DIR.glob("cartoonmornings-*.mp4"):
        m = re.search(r"-b(\d+)-", f.name)
        if m:
            max_b = max(max_b, int(m.group(1)))
    return f"b{max_b + 1}"


def main():
    # Read existing state so we skip already-posted/skipped reels
    posted = set()
    skipped = set()
    if STATE.exists():
        try:
            st = json.loads(STATE.read_text(encoding="utf-8"))
            posted = set((st.get("posted") or {}).keys())
            skipped = set((st.get("skipped") or {}).keys())
        except Exception:
            pass

    # Read existing manifest so we merge, not overwrite
    existing_manifest = {}
    if OUT.exists():
        try:
            existing_manifest = json.loads(OUT.read_text(encoding="utf-8"))
        except Exception:
            pass

    all_files = sorted(
        f.name for f in VIDEO_DIR.glob("*.mp4")
    )

    # Only process files that are NOT already in state
    files = [f for f in all_files if f not in posted and f not in skipped]
    n = len(files)
    print(f"Found {n} new video(s) in {VIDEO_DIR} ({len(all_files) - n} already tracked)")
    if n == 0:
        raise SystemExit("no new videos to caption")

    captions = build_captions(n)
    manifest = dict(existing_manifest)  # start with existing
    used_names = set(manifest.keys())
    BATCH = next_batch_label()
    print(f"Batch label: {BATCH}")

    for old_name, (title, caption) in zip(files, captions):
        # Use SEO title as filename: strip emoji, normalize, truncate
        slug = re.sub(r"[^\w\s-]", "", title, flags=re.UNICODE)
        slug = re.sub(r"[\s]+", "-", slug).strip("-").lower()
        slug = slug[:60]  # keep it short

        ep = len(manifest) + 1
        new_name = f"cartoonmornings-{slug}-{BATCH}-ep{ep:02d}.mp4"

        # guarantee filename uniqueness
        while new_name in used_names:
            ep += 1
            new_name = f"cartoonmornings-{slug}-{BATCH}-ep{ep:02d}.mp4"
        used_names.add(new_name)

        old_path = VIDEO_DIR / old_name
        new_path = VIDEO_DIR / new_name
        if old_name != new_name:
            old_path.rename(new_path)
        manifest[new_name] = {"title": title, "caption": caption}

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {len(manifest)} total captions ({len(manifest) - len(existing_manifest)} new) -> {OUT}")
    # uniqueness sanity
    caps = [m["caption"] for m in manifest.values()]
    titles = [m["title"] for m in manifest.values()]
    names = list(manifest.keys())
    print(f"unique names: {len(set(names)) == len(names)}")
    print(f"unique captions: {len(set(caps)) == len(caps)}")
    print(f"unique titles: {len(set(titles)) == len(titles)}")
    for nm in sorted(names)[-5:]:
        print(f"  {nm}  |  {manifest[nm]['title']}")


if __name__ == "__main__":
    main()
