"""Real browser DOM checks against a synthetic native host (not Obsidian QA)."""
from __future__ import annotations

import argparse
import subprocess
import tempfile
from pathlib import Path

from playwright.sync_api import sync_playwright

REPO = Path(__file__).resolve().parents[2]
EDGE_PATH = Path(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the synthetic Miro Canvas browser UI smoke test.")
    parser.add_argument("--browser", choices=("playwright", "edge"), default="playwright")
    parser.add_argument("--edge", type=Path, default=EDGE_PATH)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="miro-plugin-ui-") as temporary:
        bundle = Path(temporary) / "fixture.js"
        subprocess.run([
            "node", str(REPO / "plugins/miro-canvas/node_modules/esbuild/bin/esbuild"),
            str(REPO / "tools/obsidian_oracle/fixtures/m1-browser.ts"),
            "--bundle", "--platform=browser", f"--outfile={bundle}",
        ], cwd=REPO, check=True)
        with sync_playwright() as playwright:
            launch_options: dict[str, object] = {"headless": True}
            if args.browser == "edge":
                if not args.edge.is_file():
                    raise RuntimeError(f"Microsoft Edge executable is missing: {args.edge}")
                launch_options["executable_path"] = str(args.edge)
            browser = playwright.chromium.launch(**launch_options)
            page = browser.new_page(viewport={"width": 1600, "height": 900})
            page.set_default_timeout(5000)
            errors: list[str] = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.set_content("<!doctype html><html><body></body></html>")
            page.add_style_tag(path=str(REPO / "plugins/miro-canvas/styles.css"))
            page.add_script_tag(path=str(bundle))
            assert page.evaluate("miroBrowser.mounted"), "M1 controls did not mount on real DOM"
            assert page.locator(".miro-canvas-panel").count() == 1
            assert page.locator(".miro-canvas-minimap").count() == 1
            assert page.evaluate("document.querySelector('.miro-canvas-minimap').parentElement === miroBrowser.root")
            assert page.evaluate("!document.querySelector('.miro-canvas-panel').contains(document.querySelector('.miro-canvas-minimap'))")
            assert page.evaluate("getComputedStyle(document.querySelector('.miro-canvas-minimap')).position") == "absolute"
            assert page.evaluate("getComputedStyle(document.querySelector('.miro-canvas-minimap')).right") == "14px"
            assert page.evaluate("getComputedStyle(document.querySelector('.miro-canvas-minimap')).bottom") == "68px"
            assert page.evaluate("miroBrowser.getSaves()") == 0, "Opening a board saved it"
            assert page.evaluate("miroBrowser.node.nodeEl.getAttribute('data-miro-source-kind')") == "text"
            assert page.evaluate("miroBrowser.fileNode.nodeEl.getAttribute('data-miro-source-kind')") == "media"
            assert page.evaluate("miroBrowser.edge.edgeEl.getAttribute('data-miro-source-kind')") == "connector"
            assert page.evaluate("miroBrowser.edge.edgeEl.getAttribute('data-miro-source-end-cap')") == "arrow"
            assert page.evaluate("getComputedStyle(miroBrowser.content).fontSize") == "19px"
            page.evaluate("miroBrowser.session.toggleAttachmentNames()")
            assert page.evaluate("getComputedStyle(miroBrowser.fileLabel).display") == "none", "Native attachment title stayed visible"
            page.evaluate("miroBrowser.session.toggleAttachmentNames()")
            assert page.evaluate("getComputedStyle(miroBrowser.fileLabel).display") != "none"
            assert page.evaluate("miroBrowser.fileNode.nodeEl.querySelectorAll('.miro-canvas-attachment-label').length") == 0, "Duplicate attachment label"
            theme_before = page.evaluate("miroBrowser.runtime.data.miroCanvas.settings.displayTheme")
            saves_before_theme = page.evaluate("miroBrowser.getSaves()")
            page.evaluate("miroBrowser.session.setTheme('dark')")
            assert page.evaluate("miroBrowser.runtime.data.miroCanvas.settings.displayTheme") == "dark"
            assert page.evaluate("miroBrowser.getSaves()") == saves_before_theme + 1
            page.evaluate("miroBrowser.runtime.undo(); miroBrowser.session.refresh()")
            assert page.evaluate("miroBrowser.runtime.data.miroCanvas.settings.displayTheme") == theme_before
            page.evaluate("miroBrowser.runtime.redo(); miroBrowser.session.refresh()")
            page.evaluate("miroBrowser.session.toggleReviewMode()")
            assert page.evaluate("miroBrowser.runtime.readonly"), "Review mode did not guard native editor"
            page.evaluate("miroBrowser.session.toggleReviewMode()")
            assert not page.evaluate("miroBrowser.runtime.readonly"), "Review mode did not unlock"
            # Typography and colors now live in the floating selection toolbar.
            assert page.locator(".miro-canvas-toolbar").count() == 1
            assert not page.evaluate("document.querySelector('.miro-canvas-toolbar').hidden"), (
                "Selection toolbar stayed hidden for a selected node"
            )
            size = page.get_by_label("Font size", exact=True)
            size.fill("28")
            size.dispatch_event("change")
            assert page.evaluate("miroBrowser.runtime.data.miroCanvas.localOverrides.n1.typography.fontSize") == 28
            assert page.evaluate("getComputedStyle(miroBrowser.content).fontSize") == "28px"
            page.get_by_label("Fill color", exact=True).click()
            color = page.get_by_label("Fill color value", exact=True)
            color.fill("#abcdef")
            color.dispatch_event("change")
            assert page.evaluate("getComputedStyle(miroBrowser.node.nodeEl).backgroundColor") == "rgb(171, 205, 239)"
            page.evaluate("miroBrowser.runtime.selection.clear(); miroBrowser.session.refresh()")
            assert page.evaluate("document.querySelector('.miro-canvas-toolbar').hidden"), (
                "Selection toolbar stayed visible after the selection was cleared"
            )
            page.evaluate("miroBrowser.runtime.selection.add(miroBrowser.node); miroBrowser.session.refresh()")
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
            page.evaluate("miroBrowser.node.nodeEl.style.left = '65px'; miroBrowser.runtime.data = miroBrowser.runtime.getData(); miroBrowser.runtime.requestSave(true); miroBrowser.session.refresh()")
            assert page.evaluate("miroBrowser.node.nodeEl.style.left") == "65px", "Appearance clobbered native geometry"
            page.evaluate("miroBrowser.session.navigate('zoom-in')")
            assert page.evaluate("miroBrowser.runtime.tZoom") > 0
            assert page.evaluate("miroBrowser.sourceUnchanged()"), "miroSource changed"

            assert page.evaluate("miroBrowser.mountM2()"), "M2 tools did not mount"
            m2 = page.locator(".miro-canvas-m2-tools")
            comments = m2.locator(".miro-canvas-comments-panel")
            assert m2.count() == 1
            assert comments.count() == 1
            assert comments.locator(".miro-canvas-comments-panel__composer").count() == 1

            history_before_geometry = page.evaluate("miroBrowser.getHistoryLength()")
            m2.get_by_label("Rotation degrees", exact=True).fill("30")
            m2.get_by_role("button", name="Apply rotation", exact=True).click()
            assert page.evaluate("miroBrowser.runtime.data.miroCanvas.localOverrides.n1.rotation") == 30
            assert "rotate(30deg)" in page.evaluate("miroBrowser.node.nodeEl.style.transform")
            assert page.evaluate("miroBrowser.getHistoryLength()") == history_before_geometry + 1
            page.evaluate("miroBrowser.node.nodeEl.style.transform = 'translate(20px, 0px) rotate(30deg)'; miroBrowser.session.refresh()")
            assert page.evaluate("(miroBrowser.node.nodeEl.style.transform.match(/rotate\\(30deg\\)/g) || []).length") == 1
            assert "translate(20px, 0px)" in page.evaluate("miroBrowser.node.nodeEl.style.transform")
            page.evaluate("miroBrowser.runtime.undo(); miroBrowser.session.refresh(); miroBrowser.m2.refresh()")
            assert "rotate(30deg)" not in page.evaluate("miroBrowser.node.nodeEl.style.transform")
            page.evaluate("miroBrowser.runtime.redo(); miroBrowser.session.refresh(); miroBrowser.m2.refresh()")
            assert "rotate(30deg)" in page.evaluate("miroBrowser.node.nodeEl.style.transform")
            m2.get_by_role("button", name="Bring to front", exact=True).click()
            assert page.evaluate("miroBrowser.runtime.data.miroCanvas.zOrder.at(-1)") == "n1"
            assert page.evaluate("miroBrowser.sourceUnchanged()")
            page.evaluate("miroBrowser.runtime.undo(); miroBrowser.runtime.undo(); miroBrowser.session.refresh(); miroBrowser.m2.refresh()")
            assert "rotate(30deg)" not in page.evaluate("miroBrowser.node.nodeEl.style.transform")

            node_count = page.evaluate("miroBrowser.runtime.nodes.size")
            m2.get_by_label("Shape kind", exact=True).select_option("diamond")
            m2.get_by_label("Shape text", exact=True).fill("Local diamond")
            m2.get_by_label("Shape X", exact=True).fill("700")
            m2.get_by_role("button", name="Create shape", exact=True).click()
            assert page.evaluate("miroBrowser.runtime.nodes.size") == node_count + 1
            shape_id = page.evaluate("miroBrowser.runtime.data.nodes.find(n => n.text === 'Local diamond').id")
            assert page.evaluate("id => miroBrowser.runtime.data.miroCanvas.localOverrides[id].shape", shape_id)
            page.evaluate("miroBrowser.runtime.undo(); miroBrowser.session.refresh(); miroBrowser.m2.refresh()")
            assert page.evaluate("miroBrowser.runtime.nodes.size") == node_count
            page.evaluate("miroBrowser.runtime.redo(); miroBrowser.session.refresh(); miroBrowser.m2.refresh()")
            assert page.evaluate("miroBrowser.runtime.nodes.size") == node_count + 1
            for guard in ["review", "native-readonly"]:
                page.evaluate("guard => { if (guard === 'review') miroBrowser.session.toggleReviewMode(); else miroBrowser.runtime.readonly = true; }", guard)
                saves = page.evaluate("miroBrowser.getSaves()")
                m2.get_by_role("button", name="Create shape", exact=True).click()
                assert page.evaluate("miroBrowser.runtime.nodes.size") == node_count + 1
                assert page.evaluate("miroBrowser.getSaves()") == saves
                page.evaluate("guard => { if (guard === 'review') miroBrowser.session.toggleReviewMode(); else miroBrowser.runtime.readonly = false; }", guard)

            comments.get_by_label("New comment", exact=True).fill("Synthetic M2 comment")
            comments.get_by_role("button", name="Add comment", exact=True).click()
            card = comments.locator("article[data-comment-id]").filter(has_text="Synthetic M2 comment").first
            assert card.count() == 1, "M2 add comment did not render a local thread"
            thread_id = card.get_attribute("data-comment-id")
            assert thread_id
            card.locator(".miro-canvas-comment-card__edit-toggle").click()
            card.get_by_label(f"Edit comment {thread_id}", exact=True).fill("Edited synthetic M2 comment")
            page.wait_for_timeout(650)
            assert card.get_by_label(f"Edit comment {thread_id}", exact=True).evaluate("element => document.activeElement === element")
            card.get_by_role("button", name="Save edit", exact=True).click()
            card = comments.locator(f'article[data-comment-id="{thread_id}"]')
            assert "Edited synthetic M2 comment" in card.inner_text()
            page.evaluate("miroBrowser.runtime.undo(); miroBrowser.session.refresh(); miroBrowser.m2.refresh()")
            assert card.get_by_label(f"Edit comment {thread_id}", exact=True).input_value() == "Synthetic M2 comment"
            page.evaluate("miroBrowser.runtime.redo(); miroBrowser.session.refresh(); miroBrowser.m2.refresh()")
            card.get_by_label(f"Reply to {thread_id}", exact=True).fill("Synthetic reply")
            page.wait_for_timeout(650)
            assert card.get_by_label(f"Reply to {thread_id}", exact=True).evaluate("element => document.activeElement === element")
            card.get_by_role("button", name="Reply", exact=True).click()
            assert "Synthetic reply" in card.locator('[data-comment-region="replies"]').inner_text()
            assert card.get_by_label(f"Reply to {thread_id}", exact=True).input_value() == ""
            card.get_by_role("button", name="Resolve", exact=True).click()
            assert card.get_by_text("Resolved", exact=True).count() == 1

            anchor_x = m2.get_by_label("Anchor X, U or T", exact=True)
            anchor_y = m2.get_by_label("Anchor Y or V", exact=True)

            anchor_x.fill("123")
            anchor_y.fill("456")
            comments.get_by_role("button", name="Pick coordinates", exact=True).click()
            comments.get_by_label("New comment", exact=True).fill("Free anchor navigation")
            comments.get_by_role("button", name="Add comment", exact=True).click()
            free_card = comments.locator("article[data-comment-id]").filter(has_text="Free anchor navigation").first
            free_card.locator('[data-comment-action="select-target"]').click()
            assert page.evaluate("Math.abs(miroBrowser.runtime.tx - 123) < 0.001 && Math.abs(miroBrowser.runtime.ty - 456) < 0.001")

            page.evaluate("miroBrowser.select('n1')")
            anchor_x.fill("0.25")
            anchor_y.fill("0.5")
            comments.get_by_role("button", name="Use selection", exact=True).click()
            comments.get_by_label("New comment", exact=True).fill("Node anchor navigation")
            comments.get_by_role("button", name="Add comment", exact=True).click()
            node_card = comments.locator("article[data-comment-id]").filter(has_text="Node anchor navigation").first
            node_card.locator('[data-comment-action="select-target"]').click()
            assert page.evaluate("Math.abs(miroBrowser.runtime.tx - 140) < 0.001 && Math.abs(miroBrowser.runtime.ty - 200) < 0.001")

            page.evaluate("miroBrowser.select('image')")
            anchor_x.fill("0.2")
            anchor_y.fill("0.3")
            comments.get_by_role("button", name="Use selection", exact=True).click()
            comments.get_by_label("New comment", exact=True).fill("Image anchor navigation")
            comments.get_by_role("button", name="Add comment", exact=True).click()
            image_card = comments.locator("article[data-comment-id]").filter(has_text="Image anchor navigation").first
            image_card.locator('[data-comment-action="select-target"]').click()
            assert page.evaluate("Math.abs(miroBrowser.runtime.tx - 450) < 0.001 && Math.abs(miroBrowser.runtime.ty - 410) < 0.001")

            page.evaluate("miroBrowser.select('e1')")
            anchor_x.fill("0.5")
            anchor_y.fill("0.5")
            comments.get_by_role("button", name="Use selection", exact=True).click()
            comments.get_by_label("New comment", exact=True).fill("Edge anchor navigation")
            comments.get_by_role("button", name="Add comment", exact=True).click()
            edge_card = comments.locator("article[data-comment-id]").filter(has_text="Edge anchor navigation").first
            edge_card.locator('[data-comment-action="select-target"]').click()
            assert page.evaluate("Math.abs(miroBrowser.runtime.tx - 382.5) < 0.001 && Math.abs(miroBrowser.runtime.ty - 200) < 0.001")

            page.evaluate("miroBrowser.select('n1')")
            comments.get_by_role("button", name="Use selection", exact=True).click()
            m2.get_by_label("Anchor target", exact=True).select_option("image")
            anchor_x.fill("0.8")
            anchor_y.fill("0.25")
            m2.get_by_label("Connector", exact=True).select_option("e1")
            m2.get_by_label("Connector end", exact=True).select_option("from")
            m2.get_by_role("button", name="Set connector endpoint", exact=True).click()
            assert page.evaluate("miroBrowser.runtime.data.edges.find(e => e.id === 'e1').fromNode") == "image"
            assert page.evaluate("miroBrowser.runtime.data.miroCanvas.localOverrides.e1.connectorAnchors.from") == {"type": "image", "nodeId": "image", "u": 0.8, "v": 0.25}
            page.evaluate("miroBrowser.runtime.undo(); miroBrowser.session.refresh(); miroBrowser.m2.refresh()")
            assert page.evaluate("miroBrowser.runtime.data.edges.find(e => e.id === 'e1').fromNode") == "n1"
            page.evaluate("miroBrowser.runtime.redo(); miroBrowser.session.refresh(); miroBrowser.m2.refresh()")
            assert page.evaluate("miroBrowser.runtime.data.edges.find(e => e.id === 'e1').fromNode") == "image"
            page.evaluate("miroBrowser.select('image'); miroBrowser.session.lockSelection()")
            saves = page.evaluate("miroBrowser.getSaves()")
            m2.get_by_label("Anchor target", exact=True).select_option("n1")
            m2.get_by_role("button", name="Set connector endpoint", exact=True).click()
            assert page.evaluate("miroBrowser.getSaves()") == saves
            page.evaluate("miroBrowser.session.unlockSelection()")

            documents = m2.locator(".miro-canvas-document-controls")
            assert documents.count() == 1, "Selected PDF did not mount native document controls"
            documents.get_by_label("PDF page", exact=True).fill("3")
            documents.get_by_label("PDF fit", exact=True).select_option("width")
            documents.get_by_role("button", name="Open page", exact=True).click()
            page.wait_for_function("miroBrowser.openCalls.length === 1")
            assert page.evaluate("miroBrowser.openCalls[0]") == {
                "path": "attachments/Spec.pdf", "title": "Spec.pdf", "kind": "pdf", "page": 3, "fit": "width",
                "subpath": "#page=3",
            }
            documents.get_by_role("button", name="Next page", exact=True).click()
            page.wait_for_function("miroBrowser.openCalls.length === 2")
            assert page.evaluate("miroBrowser.openCalls[1].page") == 4

            history_before = page.evaluate("miroBrowser.getHistoryLength()")
            page.evaluate("""() => {
              const draft = miroBrowser.runtime.getData();
              draft.nodes.push({id:'history-node', type:'text', text:'history', x:700, y:300, width:100, height:80, unknownNode:{preserved:'history'}});
              draft.edges.push({id:'history-edge', fromNode:'n1', toNode:'history-node', unknownEdge:{preserved:'history'}});
              miroBrowser.runtime.importData(draft);
              miroBrowser.runtime.requestSave(true);
            }""")
            assert page.evaluate("miroBrowser.runtime.nodes.has('history-node') && miroBrowser.runtime.edges.has('history-edge')")
            assert page.evaluate("miroBrowser.getHistoryLength()") == history_before + 1
            page.evaluate("miroBrowser.runtime.undo(); miroBrowser.session.refresh(); miroBrowser.m2.refresh()")
            assert not page.evaluate("miroBrowser.runtime.nodes.has('history-node') || miroBrowser.runtime.edges.has('history-edge')")
            page.evaluate("miroBrowser.runtime.redo(); miroBrowser.session.refresh(); miroBrowser.m2.refresh()")
            assert page.evaluate("miroBrowser.runtime.nodes.has('history-node') && miroBrowser.runtime.edges.has('history-edge')")
            assert page.evaluate("miroBrowser.runtime.getData().nodes.find(n => n.id === 'history-node').unknownNode.preserved") == "history"
            assert page.evaluate("miroBrowser.runtime.getData().edges.find(e => e.id === 'history-edge').unknownEdge.preserved") == "history"
            page.evaluate("miroBrowser.runtime.undo(); miroBrowser.session.refresh(); miroBrowser.m2.refresh()")
            assert page.evaluate("miroBrowser.unknownsPreserved()"), "Unknown root/node/edge or miroSource fields changed"
            page.evaluate("miroBrowser.session.toggleAttachmentNames()")
            assert page.evaluate("getComputedStyle(miroBrowser.fileLabel).display") == "none"
            page.evaluate("miroBrowser.runtime.undo(); miroBrowser.session.refresh(); miroBrowser.m2.refresh()")
            assert page.evaluate("getComputedStyle(miroBrowser.fileLabel).display") != "none"

            page.evaluate("miroBrowser.runtime.selection.clear()")
            page.wait_for_function("miroBrowser.session.snapshot.selectedIds.length === 0")
            assert page.locator('.miro-canvas-panel[data-miro-canvas-has-selection="false"]').count() == 1
            assert not page.locator(".miro-canvas-panel__selection-only").first.is_visible()
            output = REPO / "tools/obsidian_oracle/.out/m1-browser.png"
            output.parent.mkdir(parents=True, exist_ok=True)
            m2.evaluate("element => element.scrollTop = 0")
            page.evaluate("window.scrollTo(0, 0)")
            page.screenshot(path=str(output))
            left_before_dispose = page.evaluate("miroBrowser.node.nodeEl.style.left")
            page.evaluate("miroBrowser.dispose()")
            assert page.locator(".miro-canvas-panel").count() == 0
            assert page.locator(".miro-canvas-minimap").count() == 0
            assert page.locator(".miro-canvas-m2-tools").count() == 0
            assert not page.evaluate("miroBrowser.runtime.readonly")
            assert page.evaluate("miroBrowser.node.nodeEl.style.left") == left_before_dispose, "Teardown clobbered native geometry"
            assert page.evaluate("miroBrowser.node.nodeEl.style.backgroundColor") == "", "Teardown left appearance styles"
            assert page.evaluate("miroBrowser.node.nodeEl.getAttribute('data-miro-source-kind')") is None
            assert page.evaluate("miroBrowser.edge.edgeEl.getAttribute('data-miro-source-kind')") is None
            assert page.evaluate("miroBrowser.checkPreexistingReadonly()") == {"preserved": True, "saved": False}
            assert errors == [], errors
            browser.close()
    print("OK: plugin browser DOM smoke passed (synthetic host; real Obsidian gate remains separate)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
