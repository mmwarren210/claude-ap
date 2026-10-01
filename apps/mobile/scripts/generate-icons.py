"""Generate the CrownIQ launch assets from a small geometric mark.

Run with: python apps/mobile/scripts/generate-icons.py
Requires Pillow. No external fonts or brand image downloads.
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parents[1] / "assets" / "images"
SIZE = 1024
DARK = (9, 14, 11, 255)
GREEN = (169, 243, 92, 255)


def mark(color=GREEN):
    image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.polygon(
        [(230, 352), (333, 437), (512, 263), (691, 437), (794, 352),
         (740, 660), (284, 660)],
        fill=color,
    )
    draw.rounded_rectangle((275, 675, 749, 726), radius=22, fill=color)
    for x, y in [(230, 347), (512, 258), (794, 347)]:
        draw.ellipse((x - 28, y - 28, x + 28, y + 28), fill=color)
    # Subtle dark inset keeps the crown legible as a shape at small sizes.
    if color == GREEN:
        draw.polygon([(385, 538), (512, 414), (639, 538)], fill=DARK)
    return image


def on_background(foreground, background=DARK):
    image = Image.new("RGBA", (SIZE, SIZE), background)
    image.alpha_composite(foreground)
    return image.convert("RGB")


OUT.mkdir(parents=True, exist_ok=True)
on_background(mark()).save(OUT / "icon.png")
mark().save(OUT / "splash-icon.png")
mark().save(OUT / "android-icon-foreground.png")
Image.new("RGB", (SIZE, SIZE), DARK[:3]).save(OUT / "android-icon-background.png")
mark((255, 255, 255, 255)).save(OUT / "android-icon-monochrome.png")
on_background(mark()).resize((64, 64), Image.Resampling.LANCZOS).save(OUT / "favicon.png")
