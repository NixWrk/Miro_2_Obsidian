"""A short-lived CDP bridge to a dedicated, persistent Miro browser profile."""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator
from urllib.parse import urlsplit
from urllib.request import urlopen


PROFILE_ENV = "MIRO2OBSIDIAN_BROWSER_PROFILE"


class BrowserBridgeUnavailable(RuntimeError):
    """The dedicated browser cannot be started or reached over loopback."""


class BrowserLoginRequired(RuntimeError):
    """The owner did not finish Miro sign-in in the dedicated profile."""


@dataclass(frozen=True)
class BrowserBridge:
    cdp_url: str
    profile_dir: Path


def browser_profile_dir() -> Path:
    override = os.environ.get(PROFILE_ENV)
    if override:
        return Path(override).expanduser().resolve()
    if os.name == "nt":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local")
    elif sys.platform == "darwin":
        base = Path.home() / "Library" / "Application Support"
    else:
        base = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    return (base / "miro2obsidian" / "browser-profile").resolve()


def _install_chromium() -> None:
    """Use Playwright's pinned driver; never download from an invented URL."""
    from playwright._impl._driver import compute_driver_executable

    node, cli = compute_driver_executable()
    completed = subprocess.run(
        [str(node), str(cli), "install", "chromium"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        timeout=600,
        check=False,
    )
    if completed.returncode != 0:
        raise BrowserBridgeUnavailable("Could not install Chromium for the Miro browser profile.")


def _launch_context(playwright, profile: Path, *, headless: bool, install_missing: bool):
    chromium = playwright.chromium
    kwargs = {
        "headless": headless,
        "accept_downloads": True,
        "args": ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"],
    }
    if Path(chromium.executable_path).is_file():
        return chromium.launch_persistent_context(str(profile), **kwargs)
    for channel in (("msedge", "chrome") if os.name == "nt" else ("chrome", "msedge")):
        try:
            return chromium.launch_persistent_context(str(profile), channel=channel, **kwargs)
        except Exception:  # noqa: BLE001
            # The branded browser is optional; continue to the next source.
            pass
    if not install_missing:
        raise BrowserBridgeUnavailable("No Chromium-based browser is installed for Agent mode.")
    _install_chromium()
    return chromium.launch_persistent_context(str(profile), **kwargs)


def _cdp_url(profile: Path) -> str:
    port_file = profile / "DevToolsActivePort"
    deadline = time.monotonic() + 5
    while not port_file.is_file() and time.monotonic() < deadline:
        time.sleep(0.05)
    if not port_file.is_file():
        raise BrowserBridgeUnavailable("Chromium did not open its local debugging endpoint.")
    try:
        port = int(port_file.read_text(encoding="ascii").splitlines()[0])
    except (OSError, ValueError, IndexError) as exc:
        raise BrowserBridgeUnavailable("Chromium returned an invalid local debugging port.") from exc
    if not 1 <= port <= 65535:
        raise BrowserBridgeUnavailable("Chromium returned an invalid local debugging port.")
    endpoint = f"http://127.0.0.1:{port}"
    try:
        with urlopen(f"{endpoint}/json/version", timeout=3) as response:
            payload = json.load(response)
    except (OSError, ValueError) as exc:
        raise BrowserBridgeUnavailable("The local Chromium endpoint is unreachable.") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("Browser"), str):
        raise BrowserBridgeUnavailable("The local Chromium endpoint is invalid.")
    return endpoint


def _authenticated_miro_page(context) -> bool:
    """Check navigation only; never inspect cookies, credentials, or page data."""
    for page in context.pages:
        parts = urlsplit(page.url)
        if parts.hostname == "miro.com" and parts.path.startswith(("/app/dashboard", "/app/board/")):
            return True
    return False


def _prepare_miro_page(context, page, board_url: str, *, login_timeout_seconds: int,
                       on_status: Callable[[str], None] | None) -> None:
    # A signed-out board URL can remain on a blank loader; the dashboard exposes
    # the sign-in redirect reliably before the agent starts.
    page.goto("https://miro.com/app/dashboard/", wait_until="domcontentloaded", timeout=30000)
    if not _authenticated_miro_page(context):
        page.goto("https://miro.com/login/", wait_until="domcontentloaded", timeout=30000)
        if on_status:
            on_status("Miro sign-in is open in the dedicated browser. Finish the first login there.")
        deadline = time.monotonic() + login_timeout_seconds
        while not _authenticated_miro_page(context) and time.monotonic() < deadline:
            page.wait_for_timeout(1000)
        if not _authenticated_miro_page(context):
            raise BrowserLoginRequired("Miro sign-in was not completed in the dedicated browser.")
    if on_status:
        on_status("Miro browser session is signed in; opening the selected board.")
    page.goto(board_url, wait_until="domcontentloaded", timeout=30000)


@contextmanager
def start_browser_bridge(
    board_url: str, *, profile_dir: Path | None = None, headless: bool = False,
    install_missing: bool = True, login_timeout_seconds: int = 300,
    on_status: Callable[[str], None] | None = None,
) -> Iterator[BrowserBridge]:
    """Keep a dedicated browser open while an agent uses its loopback CDP URL."""
    try:
        from playwright.sync_api import Error, TimeoutError as PlaywrightTimeoutError, sync_playwright
    except ImportError as exc:
        raise BrowserBridgeUnavailable("Install the playwright package to use Agent mode.") from exc

    profile = (profile_dir or browser_profile_dir()).resolve()
    profile.mkdir(parents=True, exist_ok=True)
    with sync_playwright() as playwright:
        try:
            context = _launch_context(playwright, profile, headless=headless, install_missing=install_missing)
        except Error as exc:
            raise BrowserBridgeUnavailable(
                "The dedicated Miro browser could not start. Close another Agent run using this profile."
            ) from exc
        try:
            endpoint = _cdp_url(profile)
            page = context.pages[0] if context.pages else context.new_page()
            try:
                if urlsplit(board_url).hostname == "miro.com":
                    _prepare_miro_page(context, page, board_url,
                                       login_timeout_seconds=login_timeout_seconds,
                                       on_status=on_status)
                else:
                    page.goto(board_url, wait_until="domcontentloaded", timeout=30000)
            except PlaywrightTimeoutError:
                # The agent can inspect a slow-loading board in the open browser.
                pass
            yield BrowserBridge(endpoint, profile)
        finally:
            context.close()
