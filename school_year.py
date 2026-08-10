"""Anno scolastico italiano (1 set → 31 ago) e etichette UI."""
from __future__ import annotations

from datetime import date
from typing import Iterable, Optional


# Dati già presenti in DB prima dell'introduzione degli anni scolastici.
LEGACY_SCHOOL_YEAR = "2025/26"
BASELINE_SCHOOL_YEARS = ("2025/26", "2026/27")


def school_year_start_year(ref: Optional[date] = None) -> int:
    """Anno di inizio a.s. (es. ago 2026 → 2025, set 2026 → 2026)."""
    day = ref or date.today()
    return day.year if day.month >= 9 else day.year - 1


def current_school_year(ref: Optional[date] = None) -> str:
    start = school_year_start_year(ref)
    return format_school_year(start)


def format_school_year(start_year: int) -> str:
    return f"{start_year}/{str(start_year + 1)[2:]}"


def parse_school_year(value: Optional[str]) -> Optional[str]:
    raw = str(value or "").strip()
    if not raw:
        return None
    # Accetta 2025/26, 2025-26, 25/26
    normalized = raw.replace("-", "/").replace(" ", "")
    parts = normalized.split("/")
    if len(parts) != 2:
        return None
    a, b = parts[0], parts[1]
    if not a.isdigit() or not b.isdigit():
        return None
    if len(a) == 2:
        a = f"20{a}"
    if len(a) != 4:
        return None
    start = int(a)
    end_two = b[-2:]
    expected = str(start + 1)[2:]
    if end_two != expected:
        # Tolleriamo 2025/2026
        if len(b) == 4 and int(b) == start + 1:
            return format_school_year(start)
        return None
    return format_school_year(start)


def school_year_label(value: str) -> str:
    parsed = parse_school_year(value) or value
    return f"A.S. {parsed}"


def merge_available_school_years(*groups: Iterable[str]) -> list[str]:
    years: set[str] = set(BASELINE_SCHOOL_YEARS)
    years.add(current_school_year())
    for group in groups:
        for item in group:
            parsed = parse_school_year(item)
            if parsed:
                years.add(parsed)
    return sorted(years, reverse=True)
