"""Genera le fiamme dei voti "rosso fuoco" (sotto il 4) come SVG animato da usare in CSS.

Fiamme piccole, larghe esattamente quanto la pastiglia del voto: escono da DIETRO il bordo
superiore (la base è nascosta dalla faccia del voto) e ogni lingua ondeggia per conto suo con
un'animazione CSS interna all'SVG (transform su ogni path: composta dalla GPU, 60 fps).
Con l'argomento "devil" aggiunge le corna da demone (voti sotto il 3).

Uso: python scripts/generate_fire.py [devil]  → stampa l'url("data:...") per app.css
"""
import sys
from urllib.parse import quote

FLAMES = [
    ("l", "M1 27 C0 21 2 18 6 12 C6 16 9 17 9 20 C12 16 11 14 11 12 C17 19 17 23 15 27 Z"),
    ("r", "M25 27 C23 23 24 19 29 14 C29 18 31 19 32 20 C34 17 34 15 34 12 C39 19 40 23 39 27 Z"),
    ("m", "M12 27 C9 22 12 17 17 11 C20 7 20 4 20 2 C28 10 26 16 25 19 C29 15 29 13 28 10 C36 19 32 24 29 27 Z"),
    ("i", "M17 27 C15 23 17 20 20 16 C21 19 21 21 22 22 C24 19 24 17 24 16 C29 22 27 26 26 27 Z"),
]

STYLE = (
    ".f{transform-box:fill-box;transform-origin:50% 100%;animation:k 1.6s ease-in-out infinite alternate}"
    ".l{fill:#ff913d;animation-duration:1.3s;animation-delay:-.7s}"
    ".r{fill:#ff8535;animation-duration:1.5s;animation-delay:-.3s}"
    ".m{fill:#ffb044;animation-duration:1.75s;animation-delay:-.9s}"
    ".i{fill:#ffdc78;animation-duration:1.2s;animation-delay:-.4s}"
    "@keyframes k{0%{transform:scaleY(.91) skewX(-2deg)}50%{transform:scaleY(1.03) skewX(1deg)}"
    "100%{transform:scaleY(.96) skewX(2deg)}}"
    "@media (prefers-reduced-motion:reduce){.f{animation:none}}"
)

# Corna: base nascosta dietro la faccia del voto (y > 21), punta che curva verso l'esterno.
HORNS = (
    '<path d="M6 26 C5 19 4 12 1 6 C7 9 11 15 13 26 Z" fill="#c8161f" stroke="#4a0309" stroke-width="1.1" stroke-linejoin="round"/>'
    '<path d="M34 26 C35 19 36 12 39 6 C33 9 29 15 27 26 Z" fill="#c8161f" stroke="#4a0309" stroke-width="1.1" stroke-linejoin="round"/>'
    '<path d="M7.5 21 C7 16 5.5 12 3.5 9" fill="none" stroke="#ff7a6b" stroke-width="1" stroke-linecap="round"/>'
    '<path d="M32.5 21 C33 16 34.5 12 36.5 9" fill="none" stroke="#ff7a6b" stroke-width="1" stroke-linecap="round"/>'
)


def svg(devil=False):
    paths = "".join(f'<path class="f {c}" d="{d}"/>' for c, d in FLAMES)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 27"><style>{STYLE}</style>'
            f'{paths}{HORNS if devil else ""}</svg>')


if __name__ == "__main__":
    print(f'url("data:image/svg+xml,{quote(svg("devil" in sys.argv[1:]), safe=" /=:,.-()")}")')
