"""Il design system risponde 302 / 403 / 200 in base al ruolo admin."""

import os
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault("DATABASE_PATH", str(Path(tempfile.gettempdir()) / "aulera-ds-auth.db"))
os.environ.setdefault("COOKIE_SECURE", "false")

import main  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


class FakeUser:
    def __init__(self, username: str):
        self._app_username = username
        self.uid = username


def _put_session(username: str) -> str:
    sid = f"sid-{username}"
    with main.sessions_lock:
        main.sessions[sid] = {
            "user": FakeUser(username),
            "expires": time.time() + 3600,
        }
    return sid


class DesignSystemAuthTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)

    def test_anonymous_is_redirected(self):
        response = self.client.get("/design/", follow_redirects=False)
        self.assertEqual(response.status_code, 302)
        self.assertIn("auth-required", response.headers.get("location", ""))

    def test_student_is_forbidden(self):
        sid = _put_session("studente-non-admin")
        response = self.client.get("/design/", cookies={"session_id": sid}, follow_redirects=False)
        self.assertEqual(response.status_code, 403)
        self.assertIn("Accesso negato", response.text)
        self.assertNotIn("Riferimento interno", response.text)

    def test_admin_receives_the_reference(self):
        sid = _put_session(main.ADMIN_USERNAME)
        response = self.client.get("/design/", cookies={"session_id": sid}, follow_redirects=False)
        self.assertEqual(response.status_code, 200)
        self.assertIn("Riferimento interno", response.text)
        self.assertIn("--brand", response.text)


if __name__ == "__main__":
    unittest.main()
