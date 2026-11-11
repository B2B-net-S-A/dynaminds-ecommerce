#!/usr/bin/env python3
"""Illustrative product pictures for the demo catalogue (tools/demo/catalog.json): one 800x800 JPEG per SKU,
drawn locally with Pillow (no downloads, no stock photos). Category shape + product name + manufacturer.

    python3 tools/demo/product-images.py <catalog.json> <output dir>
"""
import json, os, sys, textwrap
from PIL import Image, ImageDraw, ImageFont

FONTS = ['/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/System/Library/Fonts/Supplemental/Arial.ttf',
         '/Library/Fonts/Arial Unicode.ttf', '/System/Library/Fonts/Helvetica.ttc']


def font(size, bold=True):
    for f in (FONTS if bold else FONTS[1:]):
        if os.path.exists(f):
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()


def hexrgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def mix(c, t, k):
    return tuple(round(a + (b - a) * k) for a, b in zip(c, t))


def shape(d, cat, c):
    dark, light = mix(c, (0, 0, 0), 0.35), mix(c, (255, 255, 255), 0.55)
    if cat in ('Miody', 'Przetwory'):  # jar
        d.rounded_rectangle((270, 230, 530, 520), 40, fill=c, outline=dark, width=6)
        d.rectangle((285, 195, 515, 240), fill=dark)
        d.rounded_rectangle((300, 320, 500, 430), 12, fill=light)
    elif cat in ('Kawa', 'Herbata'):  # bag / box
        d.polygon([(280, 210), (520, 210), (550, 520), (250, 520)], fill=c, outline=dark)
        d.rectangle((280, 200, 520, 240), fill=dark)
        d.rounded_rectangle((310, 320, 490, 430), 12, fill=light)
    elif cat == 'Oliwy i octy':  # bottle
        d.rounded_rectangle((330, 260, 470, 530), 30, fill=c, outline=dark, width=6)
        d.rectangle((375, 170, 425, 270), fill=c, outline=dark, width=5)
        d.rectangle((370, 150, 430, 180), fill=dark)
        d.rounded_rectangle((345, 360, 455, 450), 10, fill=light)
    elif cat == 'Przyprawy':  # small tin
        d.rounded_rectangle((300, 260, 500, 520), 24, fill=c, outline=dark, width=6)
        d.ellipse((300, 235, 500, 285), fill=dark)
        d.rounded_rectangle((320, 350, 480, 440), 10, fill=light)
    elif cat == 'Książki':  # book
        d.rectangle((280, 200, 520, 530), fill=c, outline=dark, width=6)
        d.rectangle((280, 200, 310, 530), fill=dark)
        d.rectangle((340, 280, 490, 300), fill=light)
        d.rectangle((340, 320, 460, 335), fill=light)
    else:  # accessory: cup-like object
        d.rounded_rectangle((290, 260, 490, 520), 30, fill=c, outline=dark, width=6)
        d.arc((450, 310, 560, 450), -90, 90, fill=dark, width=18)
        d.ellipse((290, 240, 490, 285), fill=light, outline=dark, width=4)


def draw(p, out):
    c = hexrgb(p['color'])
    img = Image.new('RGB', (800, 800), mix(c, (255, 255, 255), 0.86))
    d = ImageDraw.Draw(img)
    d.ellipse((150, 120, 650, 620), fill=mix(c, (255, 255, 255), 0.72))
    shape(d, p['category'], c)
    d.rectangle((0, 610, 800, 800), fill=(255, 255, 255))
    lines = textwrap.wrap(p['name'], 30)[:2]
    for i, line in enumerate(lines):
        w = d.textlength(line, font=font(36))
        d.text(((800 - w) / 2, 632 + i * 46), line, fill=(34, 34, 34), font=font(36))
    sub = f"{p['manufacturer']} · {p['category']}"
    w = d.textlength(sub, font=font(24, False))
    d.text(((800 - w) / 2, 740), sub, fill=(110, 110, 110), font=font(24, False))
    img.save(out, 'JPEG', quality=82, optimize=True)


def main():
    cat, outdir = sys.argv[1], sys.argv[2]
    os.makedirs(outdir, mode=0o700, exist_ok=True)
    for p in json.load(open(cat, encoding='utf-8'))['products']:
        draw(p, os.path.join(outdir, p['sku'] + '.jpg'))
    print('images', len(os.listdir(outdir)), outdir)


main()
