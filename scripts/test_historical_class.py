"""Historical leaderboard regression tests using synthetic, temporary data only."""
from __future__ import annotations

import os
import gc
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
IMPORT_DB = tempfile.TemporaryDirectory(prefix="media-voti-history-import-")
os.environ["DATABASE_PATH"] = str(Path(IMPORT_DB.name) / "test.db")
os.environ["DEV_MODE"] = "true"

import main
from fastapi.testclient import TestClient


class HistoricalClassTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="media-voti-history-")
        self.addCleanup(self.temp.cleanup)
        self.addCleanup(gc.collect)
        self.db = patch.object(main, "DATABASE_PATH", str(Path(self.temp.name) / "test.db"))
        self.db.start()
        self.addCleanup(self.db.stop)
        self.year = patch.object(main, "current_school_year", return_value="2026/27")
        self.year.start()
        self.addCleanup(self.year.stop)
        self.session_patch = patch.object(main, "sessions", {})
        self.session_patch.start()
        self.addCleanup(self.session_patch.stop)
        main.init_db()
        self.user = SimpleNamespace(uid="current-login", ident="current-login", is_logged_in=True)
        main.app.dependency_overrides[main.current_user] = lambda: self.user
        self.addCleanup(main.app.dependency_overrides.clear)
        self.client = TestClient(main.app)
        self.addCleanup(self.client.close)
        self.set_identity()

    def set_identity(self, first="Ada", last="Test", **extra):
        main.sessions["synthetic-session"] = {
            "user": self.user,
            "card_cache": (9999999999, {"card": {"firstName": first, "lastName": last}}),
            **extra,
        }

    def seed(self, username, name="Ada Test", cls="3EI", school="OLD", year="2025/26", visible=True):
        # Raw inserts preserve homonyms that the production upsert deduplicates.
        with main.get_db_connection() as conn:
            conn.execute(
                "INSERT INTO leaderboard_entries VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (username, year, name, cls, school, 12, int(visible), 1),
            )
            conn.execute(
                "INSERT INTO average_leaderboard_entries_scoped "
                "(username, school_year, full_name, class_code, school_code, subject_name, "
                "period_key, period_label, average, visible_in_leaderboard, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (username, year, name, cls, school, "Matematica", "all", "Generale", 8, int(visible), 1),
            )
            conn.commit()

    def boards(self, **overrides):
        params = {"type": "class", "school_year": "2025/26", "class_code": "4BI", "school_code": "NEW", **overrides}
        for endpoint in ("/leaderboard", "/average-leaderboard"):
            response = self.client.get(endpoint, params={**params, "subject_name": "Matematica", "period_key": "all"})
            self.assertEqual(response.status_code, 200, response.text)
            yield response.json()

    def assert_scope_missing(self):
        for board in self.boards():
            self.assertFalse(board["class_scope_available"])
            self.assertIsNone(board["class_code"])
            self.assertIsNone(board["school_code"])
            self.assertEqual(board["items"], [])

    def test_old_third_class_is_used_when_current_class_is_fourth(self):
        self.seed("current-login")
        self.seed("current-login", cls="4BI", school="NEW", year="2026/27")
        self.seed("old-peer", name="Bea Test")
        self.seed("wrong-school", name="Carlo Test", school="NEW")
        self.seed("wrong-section", name="Dora Test", cls="3BI")
        self.seed("hidden-peer", name="Eva Test", visible=False)
        for board in self.boards():
            self.assertEqual((board["class_code"], board["school_code"]), ("3EI", "OLD"))
            self.assertEqual({row["username"] for row in board["items"]}, {"current-login", "old-peer"})
            self.assertEqual([row["username"] for row in board["items"] if row["is_me"]], ["current-login"])

    def test_changed_login_uses_current_card_before_editable_saved_name(self):
        self.seed("previous-login", name="Ada Test")
        self.seed("current-login", name="Wrong Name", cls="4BI", school="NEW", year="2026/27")
        self.seed("wrong-person", name="Wrong Name", cls="2AA")
        self.set_identity(profile={"full_name": "Wrong Name"}, me_cache=(9999999999, {"full_name": "Wrong Name"}))
        for board in self.boards():
            self.assertEqual(board["class_code"], "3EI")
            self.assertEqual([row["username"] for row in board["items"]], ["previous-login"])

    def test_changed_login_can_use_session_profile_without_card(self):
        self.seed("previous-login", name="Adà   TEST")
        main.sessions["synthetic-session"] = {"user": self.user, "profile": {"full_name": "Ada Test"}}
        for board in self.boards():
            self.assertTrue(board["class_scope_available"])
            self.assertEqual(board["class_code"], "3EI")

    def test_saved_editable_name_alone_does_not_link_accounts(self):
        self.seed("previous-login")
        self.seed("current-login", year="2026/27", cls="4BI", school="NEW")
        main.sessions.clear()
        self.assert_scope_missing()

    def test_ambiguous_name_in_different_scopes_is_not_guessed(self):
        self.seed("one")
        self.seed("two", cls="3BI")
        self.assert_scope_missing()

    def test_ambiguous_name_in_same_scope_is_not_treated_as_identity(self):
        self.seed("one")
        self.seed("two")
        self.assert_scope_missing()

    def test_missing_scope_on_homonym_does_not_hide_ambiguity(self):
        self.seed("one")
        self.seed("two", cls=None)
        self.assert_scope_missing()

    def test_missing_historical_data_does_not_guess_grade_or_section(self):
        self.seed("current-login", year="2026/27", cls="4BI", school="NEW")
        self.assert_scope_missing()

    def test_missing_historical_school_does_not_use_current_school(self):
        self.seed("current-login", school=None)
        self.assert_scope_missing()

    def test_historical_scope_can_come_from_the_other_leaderboard(self):
        self.seed("current-login")
        with main.get_db_connection() as conn:
            conn.execute("DELETE FROM leaderboard_entries")
            conn.execute("UPDATE average_leaderboard_entries_scoped SET subject_name = 'Italiano'")
            conn.commit()
        for board in self.boards():
            self.assertTrue(board["class_scope_available"])
            self.assertEqual((board["class_code"], board["school_code"]), ("3EI", "OLD"))
            self.assertEqual(board["items"], [])

    def test_current_year_keeps_current_class_filter(self):
        self.seed("current-login")
        self.seed("current-login", year="2026/27", cls="4BI", school="NEW")
        self.seed("other-current", name="Other Test", year="2026/27", cls="4CI", school="NEW")
        for board in self.boards(school_year="2026/27"):
            self.assertEqual((board["class_code"], board["school_code"]), ("4BI", "NEW"))
            self.assertEqual([row["username"] for row in board["items"]], ["current-login"])

    def test_historical_global_board_keeps_all_schools_in_selected_year(self):
        self.seed("one", name="First Test")
        self.seed("two", name="Second Test", cls="2AA", school="OTHER")
        self.seed("current-login", year="2026/27", cls="4BI", school="NEW")
        for board in self.boards(type="global"):
            self.assertEqual({row["username"] for row in board["items"]}, {"one", "two"})
            self.assertIsNone(board["class_scope_available"])

    def test_unique_numeric_alias_resolves_previous_login(self):
        self.user.uid = "S123X"
        self.user.ident = "123"
        self.seed("123")
        for board in self.boards():
            self.assertEqual(board["class_code"], "3EI")
            self.assertTrue(board["items"][0]["is_me"])

    def test_alias_collision_does_not_fall_back_to_name(self):
        self.user.uid = "S123X"
        self.user.ident = "123"
        self.seed("123")
        self.seed("G123", name="Another Test", cls="2AA")
        self.assert_scope_missing()

    def test_unique_alias_with_conflicting_identity_is_not_used(self):
        self.user.uid = "S123X"
        self.user.ident = "123"
        self.seed("123", name="Another Test")
        self.assert_scope_missing()

    def test_exact_username_wins_and_other_alias_is_not_marked_as_me(self):
        self.user.uid = "S123X"
        self.user.ident = "123"
        self.seed("S123X")
        self.seed("G123", name="Another Test")
        for board in self.boards():
            self.assertEqual([row["username"] for row in board["items"] if row["is_me"]], ["S123X"])

    def test_changed_login_name_match_never_grants_private_snapshots(self):
        self.seed("previous-login")
        for kind in ("voti", "assenze"):
            main.save_user_year_snapshot(username="previous-login", school_year="2025/26", kind=kind, payload={"private": True})
            denied = self.client.post("/" + kind, params={"school_year": "2025/26"})
            self.assertEqual(denied.status_code, 404)
            main.save_user_year_snapshot(username="current-login", school_year="2025/26", kind=kind, payload={"own": True})
            own = self.client.post("/" + kind, params={"school_year": "2025/26"})
            self.assertEqual(own.status_code, 200)
            self.assertEqual(own.json()[kind], {"own": True})


if __name__ == "__main__":
    unittest.main(verbosity=2)
