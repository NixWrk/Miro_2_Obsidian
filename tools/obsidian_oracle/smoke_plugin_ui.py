"""Real browser DOM checks against a synthetic native host (not Obsidian QA)."""
from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parents[2]


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="miro-plugin-ui-") as temporary:
        bundle = Path(temporary) / "fixture.js"
        subprocess.run([
            "node", str(REPO / "plugins/miro-canvas/node_modules/esbuild/bin/esbuild"),
            str(REPO / "tools/obsidian_oracle/fixtures/m1-browser.ts"),
            "--bundle", "--platform=browser", f"--outfile={bundle}",
        ], cwd=REPO, check=True)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1300, "height": 900})
            page.set_default_timeout(5000)
            errors: list[str] = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.set_content("<!doctype html><html><body></body></html>")
            page.add_style_tag(path=str(REPO / "plugins/miro-canvas/styles.css"))
            page.add_script_tag(path=str(bundle))
            assert page.evaluate("miroBrowser.mounted"), "M1 controls did not mount on real DOM"
            assert page.locator(".miro-canvas-panel").count() == 1
            assert page.evaluate("miroBrowser.getSaves()") == 0, "Opening a board saved it"
            page.evaluate("miroBrowser.session.setTheme('dark')")
            assert page.evaluate("miroBrowser.runtime.data.miroCanvas.settings.displayTheme") == "dark"
            assert page.evaluate("miroBrowser.getSaves()") == 1
            page.evaluate("miroBrowser.runtime.undo(); miroBrowser.session.refresh()")
            assert page.evaluate("miroBrowser.runtime.data.miroCanvas === undefined")
            page.evaluate("miroBrowser.runtime.redo(); miroBrowser.session.refresh()")
            page.evaluate("miroBrowser.session.toggleReviewMode()")
            assert page.evaluate("miroBrowser.runtime.readonly"), "Review mode did not guard native editor"
            page.evaluate("miroBrowser.session.toggleReviewMode()")
            assert not page.evaluate("miroBrowser.runtime.readonly"), "Review mode did not unlock"
            size = page.get_by_label("Size", exact=True)
            size.fill("28")
            size.dispatch_event("change")
            assert page.evaluate("miroBrowser.runtime.data.miroCanvas.localOverrides.n1.typography.fontSize") == 28
            assert page.evaluate("getComputedStyle(miroBrowser.content).fontSize") == "28px"
            page.get_by_label("Target", exact=True).select_option("fill")
            color = page.get_by_label("HEX", exact=True)
            color.fill("#abcdef")
            color.dispatch_event("change")
            assert page.evaluate("getComputedStyle(miroBrowser.node.nodeEl).backgroundColor") == "rgb(171, 205, 239)"
            page.evaluate("miroBrowser.session.lockSelection()")
            assert page.evaluate("miroBrowser.runtime.data.miroCanvas.localOverrides.n1.locked")
            assert page.evaluate("""() => {
              const event = new KeyboardEvent('keydown', {key:'Delete', bubbles:true, cancelable:true});
              miroBrowser.node.nodeEl.dispatchEvent(event); return event.defaultPrevented;
            }"""), "Locked node Delete was not blocked"
            assert not page.evaluate("""() => {
              const event = new KeyboardEvent('keydown', {key:'c', ctrlKey:true, bubbles:true, cancelable:true});
              miroBrowser.node.nodeEl.dispatchEvent(event); return event.defaultPrevented;
            }"""), "Lock incorrectly blocked copy"
            for key in ["z", "y", "f", "a"]:
                assert not page.evaluate("""key => {
                  const event = new KeyboardEvent('keydown', {key, ctrlKey:true, bubbles:true, cancelable:true});
                  miroBrowser.node.nodeEl.dispatchEvent(event); return event.defaultPrevented;
                }""", key), f"Lock incorrectly blocked Ctrl+{key}"
            page.evaluate("miroBrowser.session.unlockSelection()")
            page.evaluate("miroBrowser.node.nodeEl.style.left = '65px'; miroBrowser.session.refresh()")
            assert page.evaluate("miroBrowser.node.nodeEl.style.left") == "65px", "Appearance clobbered native geometry"
            page.evaluate("miroBrowser.session.navigate('zoom-in')")
            assert page.evaluate("miroBrowser.runtime.tZoom") > 0
            page.evaluate("miroBrowser.session.toggleAttachmentNames()")
            assert page.evaluate("getComputedStyle(miroBrowser.fileLabel).display") == "none", "Native attachment title stayed visible"
            page.evaluate("miroBrowser.session.toggleAttachmentNames()")
            assert page.evaluate("getComputedStyle(miroBrowser.fileLabel).display") != "none"
            assert page.evaluate("miroBrowser.fileNode.nodeEl.querySelectorAll('.miro-canvas-attachment-label').length") == 0, "Duplicate attachment label"
            assert page.evaluate("miroBrowser.sourceUnchanged()"), "miroSource changed"
            page.evaluate("miroBrowser.runtime.selection.clear()")
            page.wait_for_function("miroBrowser.session.snapshot.selectedIds.length === 0")
            output = REPO / "tools/obsidian_oracle/.out/m1-browser.png"
            output.parent.mkdir(parents=True, exist_ok=True)
            page.screenshot(path=str(output))
            page.evaluate("miroBrowser.dispose()")
            assert page.locator(".miro-canvas-panel").count() == 0
            assert not page.evaluate("miroBrowser.runtime.readonly")
            assert page.evaluate("miroBrowser.node.nodeEl.style.left") == "65px", "Teardown clobbered native geometry"
            assert page.evaluate("miroBrowser.node.nodeEl.style.backgroundColor") == "", "Teardown left appearance styles"
            assert page.evaluate("miroBrowser.checkPreexistingReadonly()") == {"preserved": True, "saved": False}
            assert errors == [], errors
            browser.close()
    print("OK: plugin browser DOM smoke passed (synthetic host; real Obsidian gate remains separate)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
