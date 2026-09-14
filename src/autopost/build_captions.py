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

# Bump this whenever a NEW batch of source clips is dropped in, so generated
# filenames never collide with previously-scheduled reels' names.
BATCH = "b3"

random.seed(20260914)  # reproducible unique generation

# ---------------------------------------------------------------- word banks
# Hooks are the first line FB indexes hardest for Reels search; variety +
# keyword coverage widens the audience surface. Mix of POV / question / list /
# challenge formats for viral mechanics (comment bait, save bait, watch-till-end).
HOOKS = [
    "POV: Jerry just outsmarted Tom AGAIN \U0001f602 tag the friend who always roots for the underdog!",
    "When the cartoon rivalry never sleeps but the snacks do \U0001f35f who's your MVP - Tom or Jerry?",
    "Rate this chase 1-10 \U0001f4a5 be honest, how many times have you seen THIS episode?",
    "Wait for the plot twist at the end \U0001f9f5 you will NOT believe what Jerry does! Watch till the end!",
    "Nobody: ... Tom at 3AM planning his next move \U0001f914 sound ON for this one \U0001f50a",
    "Which one are you today - Tom energy or Jerry energy? Be honest \U0001f602",
    "The most legendary rivalry in cartoon history \U0001f3af who wins this round? Comment your score!",
    "This is why childhood cartoons hit different \U0001f318 drop a \U0001f499 if you grew up on these!",
    "Jerry said 'not today' and Tom felt it \U0001f4a2 comment your favorite comeback moment!",
    "Plot twist nobody saw coming \U0001f92f save this for your bad-day pick-me-up!",
    "When the prank war escalates to level 100 \U0001f525 tag someone who'd 100% do this!",
    "Tom: makes a plan. Jerry: laughs in mouse \U0001f439 which side are you on?",
    "The sneakiness is unreal \U0001f575\ufe0f how did Jerry even get up there?!",
    "Childhood memory unlocked \U0001f39f\ufe0f who else watched this on repeat as a kid?",
    "When the background music hits different mid-chase \U0001f3b6 turn it up!",
    "Jerry's revenge arc is cinema \U0001f3ac nominate the best cartoon duo below!",
    "Tom tried, Tom failed, Tom will try again \U0001f1f9\U0001f1f3 respect the hustle!",
    "This clip is 10 seconds of pure chaos \U0001f4a5 share with your chaos buddy!",
    "When the cartoon logic makes zero sense but you love it anyway \U0001f923",
    "Jerry's confidence >>> your Monday energy \U0001f4aa send this to someone who needs it!",
    "The face-off you didn't know you needed \U0001f3a2 who takes round 2?",
    "Tom's plan: flawless. Execution: disaster \U0001f4c4 comment your funniest fail!",
    "When the tiny hero wins again \U0001f3c6 prove in the comments Jerry is the GOAT!",
    "Cartoon physics will never not be funny \U0001f4ab which gag is your all-time fave?",
    "Jerry really said 'I'm the main character' \U0001f3a7 drop your favorite episode name!",
    "The rivalry that taught us pettiness is an art \U0001f3a8 who's the bigger menace?",
    "When Tom forgets he's a cat and Jerry forgets he's a mouse \U0001f9b0 chaos ensues!",
    "This is the kind of content that ends friendships \U0001f454 tag your rival!",
    "Jerry's stealth is undefeated \U0001f6e1\ufe0f how many times has Tom fallen for it?",
    "The comedy timing in this clip is elite \U0001f3c6 name a funnier duo, I'll wait!",
    "When the chase song lives rent-free in your head \U0001f3b5 tap if you sang it!",
    "Tom's revenge plan backfired (again) \U0001f4a9 vote: who's funnier, Tom or Jerry?",
    "Jerry pulled a heist and Tom is STILL confused \U0001f4a0 explain this in the comments!",
    "When the cartoon beef is more entertaining than real TV \U0001f4fa follow for daily chaos!",
    "This tiny mouse has more aura than half of Hollywood \U0001f30f say it with a \U0001f525",
    "The slow-mo defeat face lives in my head rent-free \U0001f92b caption this in 3 words!",
    "Jerry's winning streak is statistically impossible \U0001f4ca who's counting the W's?",
    "When the prank is so good even Tom laughs \U0001f604 tag the friend who'd appreciate this!",
    "The classic duo that never misses \U0001f31f save this for your next bad day!",
    "Tom built a trap, Jerry built a better one \U0001f528 who's the real engineer?",
    "When the background sound effect is the real comedian \U0001f3ad drop a \U0001f604",
    "Jerry's exit strategy deserves an award \U0001f3c6 nominate your cartoon MVP!",
]

# Each caption ends with a distinct hashtag set (SEO clustering + reach).
# Six rotating anchor-tag sets keep the brand, the rest vary for keyword spread.
HASHTAG_SETS = [
    ["#cartoonmornings", "#tomandjerry", "#funnycartoon", "#cartooncomedy", "#classiccartoon", "#nostalgiacartoon", "#funnyreels", "#viralreels", "#fyp", "#foryou"],
    ["#cartoonmornings", "#tomandjerry", "#cartoonrivalry", "#epicchase", "#funnymoments", "#watchtillend", "#cartoonreels", "#trendingreels", "#explorepage", "#viral"],
    ["#cartoonmornings", "#tomandjerry", "#cartoonvideo", "#funnyvideo", "#reelsvideo", "#cartoonlovers", "#fyp", "#foryoupage", "#viralvideo", "#trending"],
    ["#cartoonmornings", "#tomandjerry", "#retrocartoon", "#90skids", "#oldcartoons", "#goldenera", "#funnyclips", "#reelsfacebook", "#explore", "#foryou"],
    ["#cartoonmornings", "#tomandjerry", "#cartoonmemes", "#relatable", "#memecartoon", "#funnyreels", "#dailyreels", "#cartoonoftheday", "#viral", "#trending"],
    ["#cartoonmornings", "#tomandjerry", "#classics", "#cartoonfunny", "#comedygold", "#funnymatch", "#cartoonfans", "#reels", "#fyp", "#foryoupage"],
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


def main():
    files = sorted(
        f.name for f in VIDEO_DIR.glob("*.mp4")
    )
    n = len(files)
    print(f"Found {n} videos in {VIDEO_DIR}")
    if n == 0:
        raise SystemExit("no videos found")

    captions = build_captions(n)
    manifest = {}
    used_names = set()
    for old_name, (title, caption) in zip(files, captions):
        slug = SLUGS[len(manifest) % len(SLUGS)]
        # distinct sequential name: cartoonmornings-<slug>-<batch>-epNN.mp4
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
    print(f"Wrote {len(manifest)} captions -> {OUT}")
    # uniqueness sanity
    caps = [m["caption"] for m in manifest.values()]
    titles = [m["title"] for m in manifest.values()]
    names = list(manifest.keys())
    print(f"unique names: {len(set(names)) == len(names)}")
    print(f"unique captions: {len(set(caps)) == len(caps)}")
    print(f"unique titles: {len(set(titles)) == len(titles)}")
    for nm in sorted(names)[:5]:
        print(f"  {nm}  |  {manifest[nm]['title']}")


if __name__ == "__main__":
    main()
