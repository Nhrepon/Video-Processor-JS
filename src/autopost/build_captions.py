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
import sys
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")
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

    # More variety hooks — 80+ extra for large batches
    "When Jerry wins without even trying 😂 that's main character energy 💫",
    "Caption this in 3 words. Go. 👇",
    "The face-off nobody asked for but everyone needed 🎬 who takes this round?",
    "POV: Your cat is plotting something at 3AM 📱🐱 this is that energy 🕵️",
    "Tom out here proving that confidence ≠ competence 😂 proof in the comments 💀",
    "Jerry wins again and doesn't even care 🐭 that's legendary behavior 👑",
    "The moment Tom realizes he's been outsmarted again 😤 never gets old 😂",
    "POV: You just witnessed Jerry's stealth move in real time 🕶️ GOAT behavior 🐭",
    "Tom spent all episode setting up that trap. Jerry: walks through it 🐭💀",
    "The most iconic 10 seconds in cartoon history 🎞️ drop a 🐱 if Tom deserved better 😭",
    "Jerry be like: I didn't ask for this responsibility but I'll take it anyway 💪🐭",
    "Slow motion Tom's face rn 😂 faces that deserve their own meme template 📸",
    "Nobody panic. Jerry's got this under control. 🐭✨ he's built different 💫",
    "This chase sequence hits different with headphones on 🎧 turn it UP 🔊",
    "Tom had ONE job 😂 ONE. Jerry had zero jobs and still won the whole episode 🏆🐭",
    "Tom's plan: flawless. Execution: disaster 📄 comment your funniest fail!",
    "Jerry's confidence is unmatched 😂 that's just how he wakes up every day 🐭",
    "This is the energy when you know you're the protagonist but nobody else does 🦸😂",
    "The way Tom gives 100% and Jerry gives 0% effort and Jerry STILL wins 💀🐭",
    "POV: You're the audience and you've been rooting for Jerry this whole time 👀",
    "Tom just did the most and achieved the least 😂 textbook cat behavior 💀",
    "Jerry said I will not be distracted 🐭 proceeds to outsmart everyone anyway 👑",
    "This is literally me ignoring my responsibilities and still coming out on top 🐭✨",
    "POV: You just watched Jerry escape AGAIN and Tom is now in a different area code 🌍😂",
    "The confidence Tom has before the chase starts vs after is the whole meme 😂💀",
    "Jerry's survival instincts hit different when he outruns a cat like it's nothing 🏃🐭",
    "POV: You're watching this for the 50th time and it still makes you laugh 😂📺",
    "Tom's failure rate: 100%. Jerry's success rate: also 100%. The irony is art 🎨",
    "Jerry doesn't run from cats. He makes cats run from HIM 🐭💀",
    "This episode deserved more views. Share this so more people witness the chaos! 📈",
    "Tag someone who would lose to Jerry in a cartoon universe 🏃😂",
    "POV: You just learned Jerry's full name is actually 'Jerry the Unstoppable Force' 🐭⚡",
    "Tom's trap failed so fast it created a black hole 😂🕳️ and Jerry walked through it 💀",
    "This 10-second clip contains more humor than most full comedy shows 🎬😂",
    "Jerry said: I'm not even trying and Tom said: I AM trying and it's still not enough 😭",
    "Watch Tom's face go from confident to confused to devastated in 0.5 seconds 😂💀",
    "Tom had the plan. Jerry had the plot armor. We all know how this ended 🐭🏆",
    "If Tom spent half this energy on something else he'd be a genius 😂💡 but no",
    "The background music in this clip hits harder than Tom hits the floor 😂🎵",
    "Jerry wins every round without a scratch. That's the Tom & Jerry way 🐭👑",
    "POV: You paused mid-chase to screenshot Jerry's smug face and it was perfect 📸😂",
    "Tom tries ONE thing. Jerry counters with 47 things. This is why we love this show 💀🐭",
    "The way this clip starts innocent and ends with Tom in a vase is art 🎨😂",
    "Jerry doesn't fight fair. He fights smart. That's why he's the real GOAT 🐭🧠",
    "Tom: I will catch you today. Jerry: cute. Jerry proceeds to not get caught ever 🐭😂",
    "This clip is proof that overconfidence gets you nothing but embarrassment 😂💀",
    "Jerry out here collecting wins like they're Pokemon cards 🐭🎴 that's main character energy",
    "The animation team deserves a raise for this specific chase sequence 👏🎬",
    "POV: Your group chat would be so chaotic if Tom and Jerry were in it 😂💬",
    "Tom's face in this moment is literally a meme template. You're welcome 📸💀",
    "Jerry be like: I didn't study and I still passed the exam 🐭📚😂",
    "This is why we still watch Tom & Jerry in 2024. The comedy never ages 😂📺",
    "Share this before Tom finds out someone posted his fails online 😂🌐",
    "Jerry said: I'm built different and Tom said: prove it. Jerry proved it. 💪🐭💀",
    "Tom tried to use physics. Jerry said: cute. Physics agreed with Jerry 🐭⚛️😂",
    "If this clip doesn't make you laugh then check your pulse 😂🏥",
    "Jerry just speedran the whole episode without dying once 🏃🐭 that's efficiency",
    "Tom's face in the final seconds of this clip is the face of a broken man 😂💔",
    "Jerry: natural talent. Tom: natural comedy. We all win watching this duo 😂🏆",
    "This chase has more plot twists than most movies 🎬💥 proof in the comments 📝",
    "POV: You've watched this 100 times and still can't figure out how Jerry did that 🐭🔍",
    "Tom's trap design: 10/10. Tom's trap execution: 0/10. The gap is hilarious 😂💀",
    "Jerry doesn't need plot armor. Jerry IS the plot. And he's winning it 🐭📖👑",
    "The fact that this rivalry has lasted 80+ years is the real win here 🏆🎞️",
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


def build_captions(n):
    """Return list of (title, caption) with unique hooks+hashtags."""
    chosen = []
    seen_captions = set()  # hook+tags combo (the actual Facebook post content)
    idxs = list(range(len(HOOKS)))
    random.shuffle(idxs)

    # Track taken slug-hash pairs to guarantee unique filenames.
    # title uniqueness is enforced differently — different hooks with the
    # same stripped text are fine since they produce different captions.
    taken_slugs = set()

    # First pass: unique hooks (skip hooks with identical stripped text)
    # and unique slug-hash combos (guarantees unique filenames).
    seen_stripped = {}
    for i in idxs:
        hook = HOOKS[i]
        tags = HASHTAG_SETS[i % len(HASHTAG_SETS)]
        caption_text = hook + " " + " ".join(tags)
        if caption_text in seen_captions:
            continue

        # Build slug from hook for the filename (unique per reel).
        slug = re.sub(r"[^\w\s-]", "", hook, flags=re.UNICODE)
        slug = re.sub(r"[\s]+", "-", slug).strip("-").lower()
        # Hash the full slug to avoid 20-char-suffix collisions on similar hooks.
        import hashlib
        slug_key = hashlib.md5(slug.encode()).hexdigest()[:12]
        if slug_key in taken_slugs:
            continue
        taken_slugs.add(slug_key)

        # Check for duplicate-stripped hook titles — keep first seen.
        stripped = re.sub(r"[\U0001F000-\U0001FAFF\u2600-\u27BF\u2190-\u21FF\u2B00-\u2BFF]", "", hook)
        stripped = re.sub(r"\s+", " ", stripped).strip().rstrip("!?").strip()
        if stripped in seen_stripped:
            continue
        seen_stripped[stripped] = True

        seen_captions.add(caption_text)
        # Title = original hook (keeps emojis; makes each post visually distinct)
        title = hook
        caption = f"{hook}\n.\n.\n.\n" + " ".join(tags)
        chosen.append((title, caption))
        if len(chosen) == n:
            return chosen

    # Second pass: allow different hashtag sets on same/similar hooks
    # (different tags = different caption = fine).
    if len(chosen) < n:
        attempts = 0
        max_attempts = n * 15
        while len(chosen) < n and attempts < max_attempts:
            attempts += 1
            i = random.randint(0, len(HOOKS) - 1)
            hook = HOOKS[i]
            tags = HASHTAG_SETS[random.randint(0, len(HASHTAG_SETS) - 1)]
            caption_text = hook + " " + " ".join(tags)
            if caption_text in seen_captions:
                attempts += 1
                continue
            seen_captions.add(caption_text)

            slug = re.sub(r"[^\w\s-]", "", hook, flags=re.UNICODE)
            slug = re.sub(r"[\s]+", "-", slug).strip("-").lower()
            import hashlib
            slug_key = hashlib.md5(slug.encode()).hexdigest()[:12]
            if slug_key in taken_slugs:
                continue
            taken_slugs.add(slug_key)

            title = hook
            caption = f"{hook}\n.\n.\n.\n" + " ".join(tags)
            chosen.append((title, caption))

    if len(chosen) < n:
        raise RuntimeError(f"only generated {len(chosen)} unique captions (needed {n})")
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

    # Process any file lacking a manifest entry — including ones already in
    # state. In-state files must NOT be renamed: state is keyed by filename,
    # and renaming would make schedule_pending treat them as new → duplicate
    # uploads. They get a manifest entry under their current name instead.
    files = [f for f in all_files if f not in existing_manifest]
    n = len(files)
    print(f"Found {n} uncaptioned video(s) in {VIDEO_DIR} ({len(all_files) - n} already in manifest)", file=sys.stderr)
    if n == 0:
        raise SystemExit("no new videos to caption")

    captions = build_captions(n)
    manifest = dict(existing_manifest)  # start with existing
    used_names = set(manifest.keys())
    BATCH = next_batch_label()
    print(f"Batch label: {BATCH}", file=sys.stderr)

    for old_name, (title, caption) in zip(files, captions):
        if old_name in posted or old_name in skipped:
            # Already scheduled/posted under this name — manifest entry only,
            # no rename (state is keyed by filename).
            manifest[old_name] = {"title": title, "caption": caption}
            continue

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
    print(f"Wrote {len(manifest)} total captions ({len(manifest) - len(existing_manifest)} new) -> {OUT}", file=sys.stderr)
    # uniqueness sanity (titles may contain chars not encodable by cp1252)
    caps = [m["caption"] for m in manifest.values()]
    titles = [m["title"] for m in manifest.values()]
    names = list(manifest.keys())
    print(f"unique names: {len(set(names)) == len(names)}", file=sys.stderr)
    print(f"unique captions: {len(set(caps)) == len(caps)}", file=sys.stderr)
    print(f"unique titles: {len(set(titles)) == len(titles)}", file=sys.stderr)
    for nm in sorted(names)[-5:]:
        try:
            print(f"  {nm}  |  {manifest[nm]['title']}", file=sys.stderr)
        except Exception:
            print(f"  {nm}  |  [title with special chars]", file=sys.stderr)


if __name__ == "__main__":
    main()
