"""Genera il contorno di fiamme cartoon usato dai voti sotto il 4 (.grade.g-fire)."""
import math, sys
# Anello di fiamme cartoon (stile illustrazione piatta) attorno alla pastiglia del voto.
# viewBox 120: la pastiglia occupa il centro (mezzo lato ~36); le fiamme salgono verso l'alto.
CX, CY = 60, 84

def perimeter(a, b, rad, count):
    """Punti equidistanti sul bordo di un rettangolo arrotondato, con normale uscente."""
    pts = []
    for k in range(count):
        t = 2 * math.pi * (k + 0.5) / count
        c, s = math.cos(t), math.sin(t)
        n = 5.0
        x = a * math.copysign(abs(c) ** (2 / n), c)
        y = b * math.copysign(abs(s) ** (2 / n), s)
        gx = (abs(x / a) ** (n - 1)) * math.copysign(1, x) / a if x else 0.0
        gy = (abs(y / b) ** (n - 1)) * math.copysign(1, y) / b if y else 0.0
        L = math.hypot(gx, gy) or 1
        pts.append((CX + x, CY + y, gx / L, gy / L))
    return pts

def tongue(x, y, nx, ny, h, w, curl):
    # fiamma "a goccia" cartoon: base larga, pancia tonda, punta arricciata di lato
    dx, dy = nx, ny - 1.35
    L = math.hypot(dx, dy) or 1
    ux, uy = dx / L, dy / L
    px, py = -uy, ux
    P = lambda a, b: (x + px * a + ux * b, y + py * a + uy * b)
    f = lambda p: f"{p[0]:.1f} {p[1]:.1f}"
    bl, br = P(-w, 0), P(w, 0)
    tip = P(curl * w * 0.9, h)
    return (f"M{f(bl)}C{f(P(-w * 1.45, h * 0.38))} {f(P(-w * 0.55, h * 0.8))} {f(tip)}"
            f"C{f(P(w * 0.15, h * 0.72))} {f(P(w * 1.35, h * 0.42))} {f(br)}Z")

def layer(color, half, rad, count, hbase, w, seed):
    a = b = half
    base = (f'<rect x="{CX-a:.1f}" y="{CY-b:.1f}" width="{2*a:.1f}" height="{2*b:.1f}" rx="{rad}" fill="{color}"/>')
    tongues = []
    for k, (x, y, nx, ny) in enumerate(perimeter(a, b, rad, count)):
        up = max(0.0, -ny)
        side = 1 - abs(ny)
        down = max(0.0, ny)
        wob = 0.7 + 0.6 * ((math.sin(k * 2.17 + seed) + 1) / 2)
        h = hbase * wob * (0.35 + 1.1 * up + 0.45 * side) * (1 - 0.75 * down)
        if h < 2.5:
            continue
        tongues.append(f'<path fill="{color}" d="{tongue(x, y, nx, ny, h, w * (0.85 + 0.35 * up), 1 if k % 2 else -1)}"/>')
    # fiamma centrale più alta: la sagoma classica del fuoco
    tongues.append(f'<path fill="{color}" d="{tongue(CX + 2, CY - b + 2, 0, -1, hbase * 1.55, w * 1.25, 1)}"/>')
    return base + "".join(tongues)

# Uso: python3 scripts/generate_fire.py <variante 0|1> [devil]
#   variante: due fotogrammi diversi delle fiamme (si alternano in dissolvenza nel CSS)
#   devil:    aggiunge le corna da demone sopra la pastiglia (voti sotto il 3)
# Il centro (la pastiglia del voto, mezzo lato ~36,7 unità, raggio ~23) è forato: la pastiglia è lo
# sfondo dell'elemento e le fiamme le stanno attorno. Incorporato come data URI in app.css.
variant = int(sys.argv[1]) if len(sys.argv) > 1 else 0
devil = len(sys.argv) > 2 and sys.argv[2] == "devil"
seed = 1.3 + 2.6 * variant
SCALE = 0.85  # fiamme un po' più basse della prima versione

HOLE = 36.4
hole = f'<rect x="{CX-HOLE:.1f}" y="{CY-HOLE:.1f}" width="{2*HOLE:.1f}" height="{2*HOLE:.1f}" rx="23" fill="#000"/>'
flames = (layer("#E5370E", 40, 15, 12, 30 * SCALE, 10, seed)
          + layer("#FF8A00", 38.5, 14, 11, 20 * SCALE, 8, seed + 2.1)
          + layer("#FFD23F", 37.2, 13, 10, 11 * SCALE, 6, seed + 4.2))

horns = ""
if devil:
    # Corna cartoon: base sul bordo alto della pastiglia, curva verso l'esterno e punta in su.
    def horn(side):
        # mezzaluna: base larga sul bordo, curva verso l'esterno, punta sottile rivolta in alto
        bx = CX + side * 17
        by = CY - HOLE + 4
        f = lambda x, y: f"{x:.1f} {y:.1f}"
        body = (f'M{f(bx - side*8, by)}'
                f' C{f(bx - side*9, by-16)} {f(bx + side*4, by-27)} {f(bx + side*17, by-33)}'
                f' C{f(bx + side*10, by-25)} {f(bx + side*9, by-13)} {f(bx + side*10, by)} Z')
        shine = (f'M{f(bx - side*3, by-5)} C{f(bx - side*2, by-15)} {f(bx + side*6, by-23)} {f(bx + side*12, by-28)}')
        return (f'<path d="{body}" fill="#C8161F" stroke="#4A0309" stroke-width="2.4" stroke-linejoin="round"/>'
                f'<path d="{shine}" fill="none" stroke="#FF7A6B" stroke-width="2" stroke-linecap="round" opacity="0.9"/>')
    horns = horn(-1) + horn(1)

svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 140">'
       f'<defs><mask id="m" maskUnits="userSpaceOnUse" x="0" y="0" width="120" height="140">'
       f'<rect width="120" height="140" fill="#fff"/>{hole}</mask></defs>'
       f'<g mask="url(#m)">{flames}</g>{horns}</svg>')
print(svg)
