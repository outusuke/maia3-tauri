#!/usr/bin/env python3
"""Builds src-tauri/icons/android/ from icon.png (the Flatpak icon). Needs Pillow."""
import pathlib

from PIL import Image, ImageDraw

ICONS = pathlib.Path(__file__).resolve().parent.parent / "src-tauri" / "icons"
OUT = ICONS / "android"
DENSITIES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}

src = Image.open(ICONS / "icon.png").convert("RGBA")
bg = src.getpixel((8, src.height // 2))[:3]

fg = src.copy()
px = fg.load()
for y in range(fg.height):
    for x in range(fg.width):
        if px[x, y][:3] == bg:
            px[x, y] = (0, 0, 0, 0)
fg = fg.crop(fg.getchannel("A").getbbox())


def foreground(size: int) -> Image.Image:
    # launcher masks crop outside the 66dp safe zone of the 108dp canvas
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    scale = size * 64 / 108 / max(fg.size)
    art = fg.resize((round(fg.width * scale), round(fg.height * scale)), Image.LANCZOS)
    canvas.paste(art, ((size - art.width) // 2, (size - art.height) // 2), art)
    return canvas


def legacy(size: int, round_: bool) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    if round_:
        big = Image.new("RGBA", (size * 4, size * 4), bg + (255,))
        art = src.resize((size * 4, size * 4), Image.LANCZOS)
        big.alpha_composite(art)
        mask = Image.new("L", big.size, 0)
        ImageDraw.Draw(mask).ellipse((0, 0, big.width - 1, big.height - 1), fill=255)
        big.putalpha(mask)
        return big.resize((size, size), Image.LANCZOS)
    img.alpha_composite(src.resize((size, size), Image.LANCZOS))
    return img


for name, px_size in DENSITIES.items():
    d = OUT / f"mipmap-{name}"
    d.mkdir(parents=True, exist_ok=True)
    legacy(px_size, False).save(d / "ic_launcher.png")
    legacy(px_size, True).save(d / "ic_launcher_round.png")
    foreground(round(px_size * 108 / 48)).save(d / "ic_launcher_foreground.png")

(OUT / "mipmap-anydpi-v26").mkdir(exist_ok=True)
(OUT / "mipmap-anydpi-v26" / "ic_launcher.xml").write_text(
    """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
  <background android:drawable="@color/ic_launcher_background"/>
</adaptive-icon>
"""
)
(OUT / "values").mkdir(exist_ok=True)
(OUT / "values" / "ic_launcher_background.xml").write_text(
    f"""<?xml version="1.0" encoding="utf-8"?>
<resources>
  <color name="ic_launcher_background">#{bg[0]:02X}{bg[1]:02X}{bg[2]:02X}</color>
</resources>
"""
)
print(f"wrote {OUT} (background #{bg[0]:02X}{bg[1]:02X}{bg[2]:02X})")
