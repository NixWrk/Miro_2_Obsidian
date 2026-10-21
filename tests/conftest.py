"""Local test runs must never contact a real Miro account."""

from urllib.parse import urlsplit

import pytest
import requests


@pytest.fixture(autouse=True)
def prevent_live_miro_requests(monkeypatch):
    send = requests.Session.send

    def guarded_send(self, request, **kwargs):
        hostname = (urlsplit(request.url).hostname or "").lower()
        if hostname == "miro.com" or hostname.endswith(".miro.com"):
            raise AssertionError("Live Miro requests are disabled in local tests; supply a fake response.")
        return send(self, request, **kwargs)

    monkeypatch.setattr(requests.Session, "send", guarded_send)
