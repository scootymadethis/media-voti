#!/usr/bin/env python3
"""Test school-year schema, zero-overwrite protection, and year filtering."""
from __future__ import annotations

import asyncio
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


class ClassRolloverTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        main.init_db()

    def tearDown(self):
        for username in ("rollover_hours", "liveclass"):
            main.delete_leaderboard_entry(username)
            main.delete_average_leaderboard_entry(username)

    def test_current_year_entry_does_not_reuse_previous_class(self):
        main.upsert_leaderboard_entry(
            username="rollover_hours",
            full_name="Ada Rossi",
            class_code="4EI",
            school_code="VRIT0007",
            hours=18.0,
            visible_in_leaderboard=True,
            school_year="2025/26",
        )
        self.assertIsNone(main.get_leaderboard_entry("rollover_hours", school_year="2026/27"))
        profile = main._first_saved_profile_for_user("rollover_hours")
        self.assertEqual(profile["full_name"], "Ada Rossi")
        self.assertEqual(profile["school_code"], "VRIT0007")
        self.assertIsNone(profile["class_code"])

    def test_normalize_class_code(self):
        self.assertEqual(main.normalize_class_code("5EI ELETTRONICA"), "5EI")
        self.assertEqual(main.normalize_class_code("5 ei"), "5EI")
        self.assertEqual(
            main._extract_class_code_from_card_fields({"classDesc": "5EI INFORMATICA"}),
            "5EI",
        )
        self.assertEqual(
            main._extract_first_lesson_class_code(
                {"agenda": [{"classDesc": "5EI ELETTRONICA"}]}
            ),
            "5EI",
        )

    def test_live_ranges_stay_inside_new_school_year(self):
        ranges = list(main.iter_live_class_ranges(date(2026, 9, 1), max_weeks=2))
        self.assertTrue(ranges)
        self.assertGreaterEqual(ranges[0][0], "20260901")
        self.assertLess(ranges[0][0], "20260908")

    def test_new_year_leaderboards_use_live_class(self):
        main.upstream_cache.clear()
        main.upsert_leaderboard_entry(
            username="liveclass",
            full_name="Ada Rossi",
            class_code="4EI",
            school_code="VRIT0007",
            hours=22.0,
            visible_in_leaderboard=True,
            school_year="2025/26",
        )
        main.upsert_average_leaderboard_entry(
            username="liveclass",
            full_name="Ada Rossi",
            class_code="4EI",
            school_code="VRIT0007",
            subject_name=main.GENERAL_AVERAGE_SUBJECT,
            period_key=main.GENERAL_AVERAGE_PERIOD_KEY,
            period_label="Generale",
            average=7.5,
            visible_in_leaderboard=True,
            school_year="2025/26",
        )

        class User:
            uid = "liveclass"
            ident = "liveclass"
            is_logged_in = True

        original_agenda = main.cached_agenda_json
        original_cvv = main.cached_cvv_request_json

        def fake_agenda(u, start, end):
            return {"agenda": [{"classDesc": "5EI ELETTRONICA", "evtDate": start}]}

        def fake_cvv(u, endpoint_name, request_url, *args):
            if endpoint_name == "assenze":
                return {"events": []}
            if endpoint_name == "voti":
                return {
                    "grades": [
                        {
                            "decimalValue": 8,
                            "subjectDesc": "ITALIANO",
                            "displayValue": "8",
                            "color": "green",
                        }
                    ]
                }
            return {}

        main.cached_agenda_json = fake_agenda
        main.cached_cvv_request_json = fake_cvv
        try:
            profile = main.build_session_profile(User(), card_res=None)
            self.assertEqual(profile["class_code"], "5EI")
            self.assertEqual(profile["full_name"], "Ada Rossi")

            absence = asyncio.run(
                main.update_leaderboard(
                    main.LeaderboardUpdateBody(
                        class_code="4EI",
                        school_code="VRIT0007",
                        full_name="Ada Rossi",
                        hours=99,
                        visible_in_leaderboard=True,
                    ),
                    User(),
                )
            )
            self.assertEqual(absence["saved"]["class_code"], "5EI")
            self.assertEqual(absence["saved"]["school_year"], "2026/27")
            self.assertEqual(absence["saved"]["hours"], 0.0)
            old = main.get_leaderboard_entry("liveclass", school_year="2025/26")
            self.assertEqual(old["class_code"], "4EI")
            self.assertEqual(old["hours"], 22.0)

            grades = asyncio.run(
                main.update_average_leaderboard(
                    main.AverageLeaderboardUpdateBody(
                        class_code="4EI",
                        school_code="VRIT0007",
                        full_name="Ada Rossi",
                        subject_name=main.GENERAL_AVERAGE_SUBJECT,
                        period_key=main.GENERAL_AVERAGE_PERIOD_KEY,
                        period_label="Generale",
                        average=1,
                        visible_in_leaderboard=True,
                    ),
                    User(),
                )
            )
            self.assertEqual(grades["saved"]["class_code"], "5EI")
            self.assertEqual(grades["saved"]["school_year"], "2026/27")
            self.assertGreater(grades["saved"]["average"], 0)
            class_board = [
                row
                for row in main.list_average_leaderboard_entries(
                    main.GENERAL_AVERAGE_SUBJECT,
                    main.GENERAL_AVERAGE_PERIOD_KEY,
                    school_year="2026/27",
                )
                if row["class_code"] == "5EI" and row["username"] == "liveclass"
            ]
            self.assertEqual(len(class_board), 1)
        finally:
            main.cached_agenda_json = original_agenda
            main.cached_cvv_request_json = original_cvv
            main.upstream_cache.clear()


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
