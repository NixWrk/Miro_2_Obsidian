"""Miro app setup text: manifest and checklist (no network, no secrets)."""

from __future__ import annotations

import json

import pytest

from miro2obsidian import app_setup
from miro2obsidian.app_setup import app_manifest_yaml, setup_steps


def test_manifest_has_only_the_keys_miro_accepts() -> None:
    text = app_manifest_yaml()
    keys = [
        line.split(":", 1)[0]
        for line in text.splitlines()
        if line and not line.startswith(("#", " "))
    ]
    assert keys == ["appName", "sdkUri", "redirectUris", "scopes"]
    assert "icons" not in text
    assert "appName: Miro to Obsidian - local export" in text
    assert "sdkUri: http://localhost:8766/index.html" in text
    assert "  - http://localhost:8765/callback" in text
    assert "  - boards:read" in text and "  - team:read" in text
    assert "boards:write" not in text


def test_manifest_follows_ports_and_quotes_unusual_names() -> None:
    text = app_manifest_yaml(app_name="Team: notes #1", sdk_port=9001, oauth_port=9000)
    assert 'appName: "Team: notes #1"' in text
    assert "sdkUri: http://localhost:9001/index.html" in text
    assert "http://localhost:9000/callback" in text


@pytest.mark.parametrize(
    "kwargs",
    [{"sdk_port": 0}, {"oauth_port": 70000}, {"sdk_port": True}, {"app_name": "a\nb"}, {"app_name": " "}],
)
def test_manifest_rejects_bad_input(kwargs) -> None:
    with pytest.raises(ValueError):
        app_manifest_yaml(**kwargs)


def test_manifest_is_parsable_when_yaml_is_available() -> None:
    yaml = pytest.importorskip("yaml")
    data = yaml.safe_load(app_manifest_yaml(app_name="Team: notes #1"))
    assert data == {
        "appName": "Team: notes #1",
        "sdkUri": "http://localhost:8766/index.html",
        "redirectUris": ["http://localhost:8765/callback"],
        "scopes": ["boards:read", "team:read"],
    }


def test_steps_are_structured_ordered_and_json_safe() -> None:
    steps = setup_steps()
    assert [s["id"] for s in steps] == [
        "open_developer_hub",
        "create_app",
        "configure_app",
        "install_app",
        "connect",
        "open_app_on_board",
    ]
    for step in steps:
        assert set(step) == {"id", "title", "instructions", "url", "copy_values", "actor"}
        assert step["title"] and step["instructions"]
        assert step["actor"] in {"person", "program"}
        assert all(isinstance(k, str) and isinstance(v, str) for k, v in step["copy_values"].items())
    json.dumps(steps)


def test_steps_cover_every_required_setting() -> None:
    by_id = {s["id"]: s for s in setup_steps()}
    assert by_id["open_developer_hub"]["url"] == "https://developers.miro.com/page/developer-hub#your-apps"
    configure = by_id["configure_app"]
    values = configure["copy_values"]
    assert values["App URL"] == "http://localhost:8766/index.html"
    assert values["Redirect URI"] == "http://localhost:8765/callback"
    assert values["Scopes"] == "boards:read team:read"
    assert values["App manifest (YAML)"] == app_manifest_yaml()
    text = configure["instructions"]
    assert "if your app settings page offers editing the app manifest" in text
    assert "Use this URI for SDK authorization" in text
    assert "Expire user authorization token" in text and "renews" in text
    assert "install" in by_id["install_app"]["instructions"].lower()
    assert "administrator" in by_id["install_app"]["instructions"]
    assert by_id["connect"]["copy_values"]["Command"] == "miro2obsidian auth login --form"
    assert by_id["connect"]["actor"] == "program"
    assert "icon" in by_id["open_app_on_board"]["instructions"]


def test_labels_may_differ_is_stated_honestly() -> None:
    steps = setup_steps()
    assert "may differ" in steps[0]["instructions"]
    assert "may differ" in next(s for s in steps if s["id"] == "configure_app")["instructions"]


def test_steps_never_contain_credentials_placeholders_that_look_real() -> None:
    blob = json.dumps(setup_steps()).lower()
    for word in ("client_secret=", "access_token", "bearer "):
        assert word not in blob


def test_custom_ports_flow_into_steps() -> None:
    steps = {s["id"]: s for s in setup_steps(sdk_port=7001, oauth_port=7000)}
    assert steps["configure_app"]["copy_values"]["App URL"] == "http://localhost:7001/index.html"
    assert steps["configure_app"]["copy_values"]["Redirect URI"] == "http://localhost:7000/callback"


def test_module_exports() -> None:
    assert app_setup.DEVELOPER_HUB_URL.startswith("https://developers.miro.com/")
