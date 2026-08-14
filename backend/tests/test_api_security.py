import os
import sys
import unittest

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

import main


class LocalApiSecurityTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self.safe_host = {"host": "127.0.0.1:8000"}
        self.auth_headers = {
            "host": "127.0.0.1:8000",
            "x-folio-api-token": main._API_TOKEN,
        }

    def test_api_rejects_drive_by_side_effect_without_token(self):
        response = self.client.post("/api/cache/clear", headers=self.safe_host)
        self.assertEqual(response.status_code, 401)

    def test_api_rejects_unsafe_origin_even_with_token(self):
        response = self.client.post(
            "/api/cache/clear",
            headers={**self.auth_headers, "origin": "https://example.invalid"},
        )
        self.assertEqual(response.status_code, 403)

    def test_api_rejects_unsafe_host_even_with_token(self):
        response = self.client.post(
            "/api/cache/clear",
            headers={"host": "example.invalid", "x-folio-api-token": main._API_TOKEN},
        )
        self.assertEqual(response.status_code, 403)

    def test_safe_status_request_with_token_still_works(self):
        response = self.client.get("/api/status", headers=self.auth_headers)
        self.assertEqual(response.status_code, 200)


if __name__ == "__main__":
    unittest.main()
