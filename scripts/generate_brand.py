"""Genera tutte le icone e i loghi di Skoolio a partire dai due originali in brand/.

- brand/skoolio-app-icon.png  icona dell'app (riquadro con alone rosso, sfondo trasparente)
- brand/skoolio-logo.png      logo orizzontale (tocco rosso + "Skoolio" bianco, trasparente)

Uscite: icone e loghi del sito (public/assets), icone e splash Android (mipmap/drawable),
icona e splash iOS. Uso: python scripts/generate_brand.py (richiede Pillow).
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC_ICON = ROOT / "brand" / "skoolio-app-icon.png"
SRC_LOGO = ROOT / "brand" / "skoolio-logo.png"
ASSETS = ROOT / "public" / "assets"
RES = ROOT / "android" / "app" / "src" / "main" / "res"
IOS = ROOT / "ios" / "App" / "App" / "Assets.xcassets"
SPLASH_BG = (28, 28, 30, 255)  # grigio scuro dell'app (--bg)


def alpha_bbox(im, threshold):
    return im.getchannel("A").point(lambda v: 255 if v > threshold else 0).getbbox()


def fit(im, size):
    return im.resize((size, size), Image.LANCZOS)


def on_square(im, size, scale, bg=(0, 0, 0, 0)):
    """Mette im (quadrata) al centro di un quadrato size×size, larga scale·size."""
    canvas = Image.new("RGBA", (size, size), bg)
    side = round(size * scale)
    piece = im.resize((side, side), Image.LANCZOS)
    canvas.alpha_composite(piece, ((size - side) // 2, (size - side) // 2))
    return canvas


def main():
    icon = Image.open(SRC_ICON).convert("RGBA")
    # Icona con l'alone, ritagliata in un quadrato centrato sul riquadro.
    x0, y0, x1, y1 = alpha_bbox(icon, 8)
    side = max(x1 - x0, y1 - y0)
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    glow = icon.crop((cx - side // 2, cy - side // 2, cx + side // 2, cy + side // 2))
    # Solo il riquadro (senza alone), su nero: per le icone che il sistema arrotonda da sé.
    tx0, ty0, tx1, ty1 = alpha_bbox(icon, 240)
    tside = min(tx1 - tx0, ty1 - ty0)
    tcx, tcy = (tx0 + tx1) // 2, (ty0 + ty1) // 2
    tile = icon.crop((tcx - tside // 2, tcy - tside // 2, tcx + tside // 2, tcy + tside // 2))
    tile_bleed = Image.new("RGBA", tile.size, (0, 0, 0, 255))
    tile_bleed.alpha_composite(tile)

    # --- sito ---
    fit(tile_bleed, 180).convert("RGB").save(ASSETS / "apple-touch-icon.png", optimize=True)
    fit(tile, 64).save(ASSETS / "favicon.png", optimize=True)
    fit(tile, 192).save(ASSETS / "skoolio-192.png", optimize=True)
    fit(tile, 512).save(ASSETS / "skoolio-512.png", optimize=True)

    logo = Image.open(SRC_LOGO).convert("RGBA")
    logo = logo.crop(alpha_bbox(logo, 4))
    h = 160
    logo = logo.resize((round(logo.width * h / logo.height), h), Image.LANCZOS)
    logo.save(ASSETS / "skoolio-logo.png", optimize=True)
    # Variante per il tema chiaro: la scritta bianca diventa quasi nera, il tocco resta rosso.
    dark = logo.copy()
    px = dark.load()
    for y in range(dark.height):
        for x in range(dark.width):
            r, g, b, a = px[x, y]
            if a and min(r, g, b) > 150 and max(r, g, b) - min(r, g, b) < 40:
                px[x, y] = (28, 28, 30, a)
    dark.save(ASSETS / "skoolio-logo-dark.png", optimize=True)

    # --- Android ---
    for density, px_size in {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}.items():
        d = RES / f"mipmap-{density}"
        # icona classica (Android < 8): il riquadro senza alone, che su sfondi chiari sporcherebbe i bordi
        fit(tile, px_size).save(d / "ic_launcher.png", optimize=True)
        fit(tile, px_size).save(d / "ic_launcher_round.png", optimize=True)
        # Icona adattiva (108dp, zona sicura 72dp): il riquadro con l'alone sta nella zona sicura.
        fg = px_size * 108 // 48
        on_square(glow, fg, 0.78).save(d / "ic_launcher_foreground.png", optimize=True)
    for splash in RES.glob("drawable*/splash.png"):
        w, hh = Image.open(splash).size
        canvas = Image.new("RGBA", (w, hh), SPLASH_BG)
        s = round(min(w, hh) * 0.46)
        canvas.alpha_composite(fit(glow, s), ((w - s) // 2, (hh - s) // 2))
        canvas.convert("RGB").save(splash, optimize=True)

    # --- iOS ---
    fit(tile_bleed, 1024).convert("RGB").save(IOS / "AppIcon.appiconset" / "AppIcon-512@2x.png", optimize=True)
    for splash in (IOS / "Splash.imageset").glob("*.png"):
        w, hh = Image.open(splash).size
        canvas = Image.new("RGBA", (w, hh), SPLASH_BG)
        s = round(min(w, hh) * 0.22)
        canvas.alpha_composite(fit(glow, s), ((w - s) // 2, (hh - s) // 2))
        canvas.convert("RGB").save(splash, optimize=True)
    print("ok")


if __name__ == "__main__":
    main()
