import math
import os
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD = os.path.join(HERE, '..', 'build')
ICONSET = os.path.join(BUILD, 'icon.iconset')
os.makedirs(ICONSET, exist_ok=True)


def make_app_icon():
    S = 2048  # 2x supersampling for crisp anti-aliasing
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))

    # Outer macOS app rounded square (squircle-like margin ~100px per Apple HIG at 1024 -> ~200px at 2048)
    m = 180
    r = 380
    mask = Image.new('L', (S, S), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([m, m, S - m, S - m], radius=r, fill=255)

    # Background gradient + subtle cyan/indigo ambient glow
    bg = Image.new('RGBA', (S, S), (11, 16, 27, 255))
    glow = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse([260, 140, 1460, 1340], fill=(14, 165, 233, 55))
    gd.ellipse([660, 740, 1860, 1940], fill=(99, 102, 241, 65))
    glow = glow.filter(ImageFilter.GaussianBlur(radius=190))
    bg = Image.alpha_composite(bg, glow)

    # Subtle inner border highlight
    border = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    bd = ImageDraw.Draw(border)
    bd.rounded_rectangle([m + 6, m + 6, S - m - 6, S - m - 6], radius=r - 6, outline=(148, 163, 184, 52), width=12)
    bg = Image.alpha_composite(bg, border)
    bg.putalpha(mask)
    img = Image.alpha_composite(img, bg)

    # Subtle glowing orbital ring connecting AI nodes
    ring_layer = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    rd = ImageDraw.Draw(ring_layer)
    cx, cy = S // 2, S // 2
    ring_r = 650
    rd.ellipse([cx - ring_r, cy - ring_r, cx + ring_r, cy + ring_r], outline=(56, 189, 248, 95), width=20)
    ring_blur = ring_layer.filter(ImageFilter.GaussianBlur(radius=24))
    img = Image.alpha_composite(img, ring_blur)
    img = Image.alpha_composite(img, ring_layer)

    # Four small orbital hub nodes around the ring (45 deg diagonals)
    nodes = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    nd = ImageDraw.Draw(nodes)
    node_specs = [
        (-45, (34, 211, 238, 255)),   # top-right cyan
        (135, (129, 140, 248, 255)),  # bottom-left indigo
        (45, (52, 211, 153, 255)),    # bottom-right emerald
    ]
    for deg, col in node_specs:
        rad = math.radians(deg)
        nx = cx + ring_r * math.cos(rad)
        ny = cy + ring_r * math.sin(rad)
        nr = 44
        nd.ellipse([nx - nr - 14, ny - nr - 14, nx + nr + 14, ny + nr + 14], fill=(11, 16, 27, 255))
        nd.ellipse([nx - nr, ny - nr, nx + nr, ny + nr], fill=col)
    img = Image.alpha_composite(img, nodes)

    # Center rounded terminal card
    card = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    cd = ImageDraw.Draw(card)
    cw, ch = 920, 740
    x0, y0 = cx - cw // 2, cy - ch // 2
    x1, y1 = cx + cw // 2, cy + ch // 2
    cd.rounded_rectangle([x0 - 16, y0 - 16, x1 + 16, y1 + 16], radius=165, fill=(2, 6, 23, 180))
    cd.rounded_rectangle([x0, y0, x1, y1], radius=150, fill=(17, 24, 39, 255), outline=(226, 232, 240, 225), width=36)

    # Terminal prompt chevron `>` and underscore `_`
    # `>` polygon
    px0, py0 = x0 + 205, y0 + 230
    chev = [
        (px0, py0),
        (px0 + 215, cy),
        (px0, y1 - 230),
    ]
    cd.line(chev, fill=(56, 189, 248, 255), width=64, joint='curve')
    # Smooth endcaps for `>`
    for px, py in chev:
        cd.ellipse([px - 32, py - 32, px + 32, py + 32], fill=(56, 189, 248, 255))

    # `_` bar
    bx0, by0 = cx + 35, cy + 125
    bx1, by1 = x1 - 185, cy + 185
    cd.rounded_rectangle([bx0, by0, bx1, by1], radius=30, fill=(248, 250, 252, 255))

    img = Image.alpha_composite(img, card)

    icon_1024 = img.resize((1024, 1024), Image.Resampling.LANCZOS)
    icon_1024.save(os.path.join(BUILD, 'icon_1024.png'))
    icon_1024.resize((512, 512), Image.Resampling.LANCZOS).save(os.path.join(BUILD, 'icon.png'))

    sizes = [16, 32, 128, 256, 512]
    for sz in sizes:
        icon_1024.resize((sz, sz), Image.Resampling.LANCZOS).save(os.path.join(ICONSET, f'icon_{sz}x{sz}.png'))
        icon_1024.resize((sz * 2, sz * 2), Image.Resampling.LANCZOS).save(os.path.join(ICONSET, f'icon_{sz}x{sz}@2x.png'))


def make_tray_icon():
    # Draw at 176x176 (4x of 44) and downsample to 44x44 (@2x) and 22x22
    S = 176
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    # Monochrome black-on-transparent rounded terminal outline + `>_`
    d.rounded_rectangle([18, 28, S - 18, S - 28], radius=30, outline=(0, 0, 0, 255), width=14)
    pts = [(48, 64), (78, 88), (48, 112)]
    d.line(pts, fill=(0, 0, 0, 255), width=14, joint='curve')
    for px, py in pts:
        d.ellipse([px - 7, py - 7, px + 7, py + 7], fill=(0, 0, 0, 255))
    d.rounded_rectangle([92, 106, 132, 120], radius=7, fill=(0, 0, 0, 255))

    img.resize((44, 44), Image.Resampling.LANCZOS).save(os.path.join(BUILD, 'trayTemplate@2x.png'))
    img.resize((22, 22), Image.Resampling.LANCZOS).save(os.path.join(BUILD, 'trayTemplate.png'))


if __name__ == '__main__':
    make_app_icon()
    make_tray_icon()
    print('ICONS_GENERATED_OK')
