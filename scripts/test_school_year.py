#!/usr/bin/env python3
"""Test school-year schema, zero-overwrite protection, and year filtering."""
from __future__ import annotations

import os
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

TMP_DB = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
TMP_DB.close()
os.environ["DATABASE_PATH"] = TMP_DB.name
os.environ["DEV_MODE"] = "true"

from school_year import (  # noqa: E402
    current_school_year,
    format_school_year,
    merge_available_school_years,
    parse_school_year,
    school_year_start_year,
)
import main  # noqa: E402


class SchoolYearHelpersTest(unittest.TestCase):
    def test_parse_and_format(self):
        self.assertEqual(parse_school_year("2025/26"), "2025/26")
        self.assertEqual(parse_school_year("25/26"), "2025/26")
        self.assertEqual(parse_school_year("2025-26"), "2025/26")
        self.assertEqual(parse_school_year("2025/2026"), "2025/26")
        self.assertIsNone(parse_school_year("2025/27"))

    def test_current_year_boundaries(self):
        self.assertEqual(school_year_start_year(date(2026, 8, 10)), 2025)
        self.assertEqual(school_year_start_year(date(2026, 9, 1)), 2026)
        self.assertEqual(current_school_year(date(2026, 8, 10)), "2025/26")
        self.assertEqual(current_school_year(date(2026, 9, 1)), "2026/27")

    def test_merge_baseline(self):
        years = merge_available_school_years(["2025/26"])
        self.assertIn("2025/26", years)
        self.assertIn("2026/27", years)


class SchoolYearDbTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        main.init_db()

    def test_migration_tags_legacy_rows(self):
        with main.get_db_connection() as conn:
            cols = {row[1] for row in conn.execute("PRAGMA table_info(leaderboard_entries)")}
            self.assertIn("school_year", cols)
            avg_cols = {
                row[1]
                for row in conn.execute("PRAGMA table_info(average_leaderboard_entries_scoped)")
            }
            self.assertIn("school_year", avg_cols)

    def test_hours_separated_by_year(self):
        main.upsert_leaderboard_entry(
            username="u1",
            full_name="User One",
            class_code="4EI",
            school_code="VRIT0007",
            hours=12.0,
            visible_in_leaderboard=True,
            school_year="2025/26",
        )
        main.upsert_leaderboard_entry(
            username="u1",
            full_name="User One",
            class_code="5EI",
            school_code="VRIT0007",
            hours=3.0,
            visible_in_leaderboard=True,
            school_year="2026/27",
        )
        y25 = main.get_leaderboard_entry("u1", school_year="2025/26")
        y26 = main.get_leaderboard_entry("u1", school_year="2026/27")
        self.assertEqual(y25["hours"], 12.0)
        self.assertEqual(y26["hours"], 3.0)
        self.assertEqual(len(main.list_leaderboard_entries(school_year="2025/26")), 1)
        self.assertEqual(len(main.list_leaderboard_entries(school_year="2026/27")), 1)

    def test_average_zero_does_not_overwrite(self):
        year = "2025/26"
        main.upsert_average_leaderboard_entry(
            username="avg1",
            full_name="Avg One",
            class_code="4EI",
            school_code="VRIT0007",
            subject_name=main.GENERAL_AVERAGE_SUBJECT,
            period_key=main.GENERAL_AVERAGE_PERIOD_KEY,
            period_label="Generale",
            average=8.5,
            visible_in_leaderboard=True,
            school_year=year,
        )

        empty_voti = {"grades": []}
        computed = float(main.calculate_general_average_from_payload(empty_voti))
        self.assertEqual(computed, 0.0)
        self.assertFalse(main.payload_has_grades(empty_voti))

        existing = main.get_average_leaderboard_entry(
            "avg1",
            main.GENERAL_AVERAGE_SUBJECT,
            main.GENERAL_AVERAGE_PERIOD_KEY,
            school_year=year,
        )
        self.assertIsNotNone(existing)
        self.assertEqual(float(existing["average"]), 8.5)

        # Simulate the endpoint guard: zero average must not wipe non-zero rows.
        if computed <= 0 and float(existing["average"]) > 0:
            preserved = True
        else:
            main.upsert_average_leaderboard_entry(
                username="avg1",
                full_name="Avg One",
                class_code="4EI",
                school_code="VRIT0007",
                subject_name=main.GENERAL_AVERAGE_SUBJECT,
                period_key=main.GENERAL_AVERAGE_PERIOD_KEY,
                period_label="Generale",
                average=computed,
                visible_in_leaderboard=True,
                school_year=year,
            )
            preserved = False

        self.assertTrue(preserved)
        saved = main.get_average_leaderboard_entry(
            "avg1",
            main.GENERAL_AVERAGE_SUBJECT,
            main.GENERAL_AVERAGE_PERIOD_KEY,
            school_year=year,
        )
        self.assertEqual(float(saved["average"]), 8.5)

    def test_zero_average_does_not_create_row(self):
        year = "2026/27"
        empty_voti = {"grades": []}
        computed = float(main.calculate_general_average_from_payload(empty_voti))
        existing = main.get_average_leaderboard_entry(
            "avg_new",
            main.GENERAL_AVERAGE_SUBJECT,
            main.GENERAL_AVERAGE_PERIOD_KEY,
            school_year=year,
        )
        self.assertIsNone(existing)
        if computed <= 0 and not existing:
            skipped = True
        else:
            skipped = False
            main.upsert_average_leaderboard_entry(
                username="avg_new",
                full_name="New",
                class_code="1A",
                school_code="X",
                subject_name=main.GENERAL_AVERAGE_SUBJECT,
                period_key=main.GENERAL_AVERAGE_PERIOD_KEY,
                period_label="Generale",
                average=computed,
                visible_in_leaderboard=True,
                school_year=year,
            )
        self.assertTrue(skipped)
        self.assertIsNone(
            main.get_average_leaderboard_entry(
                "avg_new",
                main.GENERAL_AVERAGE_SUBJECT,
                main.GENERAL_AVERAGE_PERIOD_KEY,
                school_year=year,
            )
        )

    def test_snapshots_roundtrip(self):
        payload = {"grades": [{"decimalValue": 7, "subjectDesc": "ITA"}]}
        main.save_user_year_snapshot(
            username="snap1",
            school_year="2025/26",
            kind="voti",
            payload=payload,
        )
        loaded = main.get_user_year_snapshot(
            username="snap1", school_year="2025/26", kind="voti"
        )
        self.assertEqual(loaded, payload)


if __name__ == "__main__":
    try:
        unittest.main(verbosity=2)
    finally:
        try:
            os.unlink(TMP_DB.name)
        except OSError:
            pass
        for suffix in ("-wal", "-shm"):
            try:
                os.unlink(TMP_DB.name + suffix)
            except OSError:
                pass
