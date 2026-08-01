# Copyright (c) 2026 TechLead 187 LLC
# SPDX-License-Identifier: BUSL-1.1
#
# Regenerate the two v1.12.0 voice-mode placeholder JPGs.
#
# The README references .jpg paths so the real captures can be dropped straight over these with no README
# edit. Committed placeholders (rather than nothing) keep the README rendering instead of showing two broken
# images between the release and the screenshots landing.
#
#   python .github/assets/screenshots/v1.12.0/make_placeholders.py
#
# Writes .github/assets/voice-panel-undocked.jpg and .github/assets/voice-mini-composer.jpg.

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

# The voice screenshots live flat in .github/assets/ alongside every other README capture.
OUT = Path(__file__).resolve().parents[2]
W, H = 1280, 720
BG_TOP, BG_BOT = (18, 20, 27), (10, 11, 15)
ACCENT, MUTED, DIM = (224, 123, 240), (107, 114, 128), (75, 85, 99)


def font(size: int, bold: bool = False):
    for name in (("segoeuib.ttf", "arialbd.ttf") if bold else ("segoeui.ttf", "arial.ttf")):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default(size)


def centered(d: ImageDraw.ImageDraw, y: int, text: str, f, fill) -> None:
    d.text((W // 2, y), text, font=f, fill=fill, anchor="mm")


def card(path: Path, title: str, sub: str, note: str) -> None:
    img = Image.new("RGB", (W, H), BG_BOT)
    d = ImageDraw.Draw(img)
    for y in range(H):  # vertical gradient
        t = y / (H - 1)
        d.line([(0, y), (W, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(BG_TOP, BG_BOT)))
    # dashed inset border
    m, dash, gap = 26, 26, 20
    for x in range(m, W - m, dash + gap):
        d.line([(x, m), (min(x + dash, W - m), m)], fill=(42, 47, 61), width=3)
        d.line([(x, H - m), (min(x + dash, W - m), H - m)], fill=(42, 47, 61), width=3)
    for y in range(m, H - m, dash + gap):
        d.line([(m, y), (m, min(y + dash, H - m))], fill=(42, 47, 61), width=3)
        d.line([(W - m, y), (W - m, min(y + dash, H - m))], fill=(42, 47, 61), width=3)
    centered(d, H // 2 - 46, "LUCID Agent  ·  Voice mode", font(30, True), ACCENT)
    centered(d, H // 2 + 6, title, font(24), (229, 231, 235))
    centered(d, H // 2 + 48, sub, font(18), MUTED)
    centered(d, H - 62, note, font(15), DIM)
    img.save(path, "JPEG", quality=88, optimize=True)
    print("wrote", path.name)


card(OUT / "voice-panel-undocked.jpg",
     "The [Voice] panel, popped out",
     "Equalizer undocked and anchored anywhere in the window",
     "screenshot placeholder — replace this file, keep the name")
card(OUT / "voice-mini-composer.jpg",
     "The mini equalizer, under the prompt bar",
     "Compact strip beside the mic while a reply is spoken",
     "screenshot placeholder — replace this file, keep the name")
