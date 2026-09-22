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
    parser.add_argument("--interactions", action="store_true", help="Focused clipboard and selection interaction regression.")
    parser.add_argument("--controls", action="store_true", help="Connector menus, marquee and first-press comment drag.")
    parser.add_argument("--screenshots", type=Path, help="Optional controls screenshots directory.")
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
            if args.controls:
                page.evaluate("""() => {
                  const b=miroBrowser;b.session.resetTools();
                  b.session.writeBoardConnectors([{id:'menu-line',from:{type:'free',x:-200,y:100},to:{type:'free',x:100,y:100},route:'straight',color:'#334455',width:2,startCap:'none',endCap:'arrow'}]);
                  b.session.connectorLayer.select(['menu-line']);
                }""")
                toolbar = page.locator('.miro-canvas-toolbar').filter(has=page.get_by_role('button', name='Swap line ends', exact=True))
                assert toolbar.is_visible()
                page.evaluate("miroBrowser.runtime.menu.menuEl.replaceChildren()")
                assert toolbar.get_by_role('button', name='Delete selection', exact=True).is_visible(), 'Native menu hid connector actions'
                assert not page.locator('.miro-board-connector-tools').is_visible()
                toolbar.get_by_role('button', name='Line color', exact=True).click()
                toolbar.get_by_label('Custom line color', exact=True).fill('#ff5500')
                assert page.evaluate("miroBrowser.runtime.getData().miroCanvas.connectors['menu-line'].color") == '#ff5500'
                toolbar.get_by_role('button', name='Line color', exact=True).click()
                toolbar.get_by_role('button', name='Swap line ends', exact=True).click()
                assert page.evaluate("miroBrowser.runtime.getData().miroCanvas.connectors['menu-line'].startCap") == 'arrow'
                page.evaluate("miroBrowser.session.armTool('connector')")
                panel = page.locator('.miro-canvas-tools__connectors')
                assert panel.locator('[data-shape]').evaluate_all("els=>els.map(e=>e.dataset.shape)") == ['arrow', 'elbow', 'block', 'line', 'curve', 'polyline', 'spline']
                assert panel.locator('[data-connector-color]').count() == 8
                panel.locator('[data-connector-color="#67c6a0"]').click()
                panel.get_by_label('New connector width slider', exact=True).fill('9')
                assert page.evaluate("miroBrowser.session.connectorColor") == '#67c6a0'
                assert page.evaluate("miroBrowser.session.connectorWidth") == 9
                assert panel.bounding_box()['width'] < 620, 'Connector bar is oversized'
                tools_bar = page.locator('.miro-canvas-tools')
                connector_width = tools_bar.bounding_box()['width']
                positions = panel.locator(':scope > [data-shape]').evaluate_all("els=>els.map(e=>e.getBoundingClientRect().top)")
                assert len(positions) == 7 and max(positions) - min(positions) < 1, 'Types must be directly available in one row'
                assert panel.locator('.miro-canvas-toolbar__panel').count() == 0
                tools_bar.get_by_role('button', name='Pen P', exact=True).click()
                assert abs(tools_bar.bounding_box()['width'] - connector_width) < 1, 'Drawing/connector widths differ'
                tools_bar.locator('[data-tool="shape"]').click()
                shapes = tools_bar.locator('.miro-canvas-toolbar__panel--shapes')
                assert shapes.is_visible()
                assert not panel.is_visible()
                tools_bar.locator('[data-tool="connector"]').click()
                assert not shapes.is_visible()
                assert panel.is_visible()
                tools_bar.locator('[data-tool="shape"]').click()
                assert shapes.is_visible() and not panel.is_visible()
                page.evaluate("miroBrowser.session.armTool('connector')")
                assert not shapes.is_visible() and panel.is_visible()
                panel.locator('[data-shape="block"]').click()
                assert panel.get_by_label('New connector width', exact=True).input_value() == '16'
                panel.get_by_label('New connector width slider', exact=True).fill('23')
                panel.locator('[data-shape="arrow"]').click()
                assert panel.get_by_label('New connector width', exact=True).input_value() == '9'
                panel.locator('[data-shape="block"]').click()
                assert panel.get_by_label('New connector width', exact=True).input_value() == '23'
                panel.locator('[data-shape="arrow"]').click()
                assert toolbar.get_by_role('button', name='Delete selection', exact=True).is_visible()
                # Drag an existing end while the creation tool is still armed.
                assert not page.locator('.miro-canvas-handles').is_visible(), 'Duplicate native handles'
                before_end = page.evaluate("miroBrowser.runtime.getData().miroCanvas.connectors['menu-line'].from")
                box = page.evaluate("document.querySelector('.miro-board-connector-grip[data-end=from]').getBoundingClientRect().toJSON()")
                assert box is not None
                gx, gy = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
                page.mouse.move(gx, gy)
                page.mouse.down()
                page.mouse.move(gx + 30, gy + 40, steps=5)
                page.mouse.up()
                after_end = page.evaluate("miroBrowser.runtime.getData().miroCanvas.connectors['menu-line'].from")
                assert abs(after_end['x'] - before_end['x'] - 30) < 1, (before_end, after_end)
                assert abs(after_end['y'] - before_end['y'] - 40) < 1, (before_end, after_end)
                assert page.locator('.miro-board-connector-hit').count() == 1, 'Grip created a new connector'
                assert page.locator('.miro-board-connector-grip').count() == 2
                # Non-unit zoom and an offset camera must use the same endpoint origin.
                page.evaluate("miroBrowser.runtime.setViewport(60,30,1);miroBrowser.session.followViewport()")
                box = page.evaluate("document.querySelector('.miro-board-connector-grip[data-end=from]').getBoundingClientRect().toJSON()")
                assert box is not None
                gx, gy = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
                before_zoom_end = after_end
                page.mouse.move(gx, gy)
                page.mouse.down()
                page.mouse.move(gx + 20, gy + 30, steps=5)
                page.mouse.up()
                after_zoom_end = page.evaluate("miroBrowser.runtime.getData().miroCanvas.connectors['menu-line'].from")
                assert abs(after_zoom_end['x'] - before_zoom_end['x'] - 10) < 1, (box, before_zoom_end, after_zoom_end)
                assert abs(after_zoom_end['y'] - before_zoom_end['y'] - 15) < 1, (box, before_zoom_end, after_zoom_end)
                assert not page.locator('.miro-canvas-handles').is_visible()
                page.evaluate("miroBrowser.runtime.setViewport(0,0,0);miroBrowser.session.followViewport()")
                page.evaluate("""() => {
                  const b=miroBrowser,s=b.session,original=s.settings;
                  s.resetTools();s.settings={...original,lassoBinding:'right',panBinding:'right'};
                  let pans=0;const pan=()=>pans++;b.root.addEventListener('mousedown',pan,true);
                  const p={button:2,buttons:2,pointerId:81,clientX:950,clientY:450,bubbles:true,cancelable:true};
                  b.root.dispatchEvent(new PointerEvent('pointerdown',p));
                  b.root.dispatchEvent(new MouseEvent('mousedown',p));
                  if(!s.toolGesture)throw Error('Right lasso did not start');
                  if(s.panGestureEnd||pans)throw Error('Lasso also started panning');
                  window.dispatchEvent(new PointerEvent('pointercancel',p));
                  b.root.dispatchEvent(new MouseEvent('mousedown',{...p,button:1}));
                  if(pans!==1)throw Error('Middle pan was blocked');
                  b.root.removeEventListener('mousedown',pan,true);
                  s.settings={...original,connectorAttachNodes:true,connectorAllowFree:false,connectorAttachConnectors:false};
                  const free=s.viewportPoint({x:-600,y:-400}), node=s.viewportPoint({x:100,y:180});
                  if(s.connectorLanding(free,undefined,undefined,'')!==undefined)throw Error('Default allowed free end');
                  if(s.connectorLanding(node,undefined,undefined,'')?.nodeId!=='n1')throw Error('Default rejected node');
                  const count=Object.keys(b.runtime.getData().miroCanvas.connectors).length;
                  s.createLine({route:'straight',endCap:'arrow'},[{x:-600,y:-400},{x:-500,y:-400}]);
                  if(Object.keys(b.runtime.getData().miroCanvas.connectors).length!==count)throw Error('Creation bypassed policy');
                  s.settings={...original,connectorAttachNodes:false,connectorAllowFree:false,connectorAttachConnectors:false};
                  if(s.connectorLanding(node,undefined,undefined,'')!==undefined)throw Error('Disabled node attachment accepted');
                  const c=b.runtime.getData().miroCanvas.connectors['menu-line'];
                  const edge=s.viewportPoint({x:(c.from.x+c.to.x)/2,y:(c.from.y+c.to.y)/2});
                  if(s.connectorLanding(edge,undefined,undefined,'')!==undefined)throw Error('Disabled edge attachment accepted');
                  s.settings={...s.settings,connectorAttachConnectors:true};
                  if(s.connectorLanding(edge,undefined,undefined,'')?.anchor.type!=='edge')throw Error('Enabled edge attachment rejected');
                  s.settings={...s.settings,connectorAllowFree:true};
                  if(s.connectorLanding(free,undefined,undefined,'')?.anchor.type!=='free')throw Error('Enabled free end rejected');
                  s.settings=original;s.connectorLayer.select(['menu-line']);s.armTool('connector');
                }""")
                if args.screenshots:
                    args.screenshots.mkdir(parents=True, exist_ok=True)
                    page.screenshot(path=str(args.screenshots / 'connector-controls.png'))
                page.evaluate("""async () => {
                  const b=miroBrowser;b.session.resetTools();const saves=b.getSaves();
                  const c=b.runtime.getData().miroCanvas.connectors['menu-line'];
                  const middle={x:(c.from.x+c.to.x)/2,y:(c.from.y+c.to.y)/2};
                  const start=b.session.viewportPoint({x:middle.x-20,y:middle.y-20}),end=b.session.viewportPoint({x:middle.x+20,y:middle.y+20});
                  b.root.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:45,clientX:start.x,clientY:start.y,bubbles:true}));
                  window.dispatchEvent(new PointerEvent('pointermove',{pointerId:45,clientX:end.x,clientY:end.y,bubbles:true}));
                  window.dispatchEvent(new PointerEvent('pointerup',{pointerId:45,clientX:end.x,clientY:end.y,bubbles:true}));
                  await Promise.resolve();b.session.readInteractionState();
                  if(!b.session.selectedIds.includes('menu-line'))throw Error('Marquee missed a crossing connector');
                  if(b.getSaves()!==saves)throw Error('Selection wrote history');
                  b.session.resetTools();b.session.commentDraft={type:'free',x:200,y:180};b.session.createComment('First press drag');b.session.closeCommentThread();b.select('n1');b.root.focus();
                }""")
                marker = page.locator('.miro-canvas-comment-marker').first
                before = marker.bounding_box()
                assert before is not None
                x, y = before['x'] + before['width'] / 2, before['y'] + before['height'] / 2
                page.mouse.move(x, y)
                page.mouse.down()
                # A refresh between press and first move must not cancel the pickup.
                page.evaluate("miroBrowser.session.refresh()")
                page.mouse.move(x + 90, y + 35, steps=6)
                page.mouse.up()
                after = marker.bounding_box()
                assert after is not None
                assert abs(after['x'] - before['x'] - 90) < 2, (before, after)
                assert abs(after['y'] - before['y'] - 35) < 2, (before, after)
                assert page.evaluate("miroBrowser.session.openThread===undefined"), 'Drag opened the comment card'
                page.evaluate("""() => {
                  const b=miroBrowser,s=b.session;s.resetTools();s.connectorLayer.select(['menu-line']);
                  const first=b.runtime.getData().miroCanvas.connectors['menu-line'];
                  const press=()=>{
                    const grip=document.querySelector('.miro-board-connector-grip[data-end=from]');
                    const r=grip.getBoundingClientRect();
                    grip.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:91,clientX:r.x+6,clientY:r.y+6,bubbles:true,cancelable:true}));
                  };
                  press();
                  s.writeBoardConnectors([{...first,color:'#abcdef'}]);
                  const target=s.viewportPoint({x:-350,y:180});
                  window.dispatchEvent(new PointerEvent('pointerup',{pointerId:91,clientX:target.x,clientY:target.y}));
                  const saved=b.runtime.getData().miroCanvas.connectors['menu-line'];
                  if(saved.color!=='#abcdef'||JSON.stringify(saved.from)!==JSON.stringify(first.from))throw Error('Stale drag overwrote a newer edit');
                  const original=s.settings;s.settings={...original,connectorAllowFree:false};
                  press();
                  const node=s.viewportPoint({x:100,y:180});
                  window.dispatchEvent(new PointerEvent('pointermove',{pointerId:91,clientX:node.x,clientY:node.y}));
                  window.dispatchEvent(new PointerEvent('pointerup',{pointerId:91,clientX:target.x,clientY:target.y}));
                  if(JSON.stringify(b.runtime.getData().miroCanvas.connectors['menu-line'].from)!==JSON.stringify(first.from))throw Error('Invalid release attached to an earlier target');
                  s.settings=original;
                  const block={...saved,block:true,startCap:'none',endCap:'none'};
                  s.writeBoardConnectors([block]);s.connectorLayer.select(['menu-line']);
                  s.applyElementStyle({connector:{startCap:'stealth',endCap:'none'}});
                  const hit=document.querySelector('[data-connector-id="menu-line"]');
                  if(hit.getAttribute('fill')!=='transparent')throw Error('Hit overlay paints over block arrow');
                  if(!b.runtime.getData().miroCanvas.connectors['menu-line'].block)throw Error('Swapping block head lost block style');
                  s.applyElementStyle({connector:{startCap:'none',endCap:'none'}});
                  if(b.runtime.getData().miroCanvas.connectors['menu-line'].block)throw Error('Removing block head did not make a line');
                  s.connectorWidth=11;
                  s.createLine({route:'straight',block:true,width:16},[{x:-600,y:-400},{x:-500,y:-400}]);
                  if(!Object.values(b.runtime.getData().miroCanvas.connectors).some(c=>c.block&&c.width===11))throw Error('Block ignored width control');
                }""")
                page.evaluate("""() => {
                  const b=miroBrowser,s=b.session;s.resetTools();
                  const base={route:'straight',color:'#123456',width:2,startCap:'none',endCap:'arrow'};
                  s.writeBoardConnectors([
                    {...base,id:'group-a',from:{type:'free',x:-350,y:-180},to:{type:'free',x:-150,y:-180}},
                    {...base,id:'group-b',from:{type:'free',x:-350,y:-120},to:{type:'free',x:-150,y:-120}}
                  ]);
                  s.connectorLayer.select(['group-a','group-b']);b.root.focus();
                  b.groupBefore=b.runtime.getData();b.groupSaves=b.getSaves();
                  b.originalGetData=b.runtime.getData;
                  b.runtime.getData=function(){const d=b.originalGetData.call(this);d.nodes[0].subpath=undefined;d.edges[0].label=undefined;return d;};
                }""")
                start = page.evaluate("miroBrowser.session.viewportPoint({x:-250,y:-180})")
                page.mouse.move(start['x'], start['y'])
                page.mouse.down()
                page.mouse.move(start['x'] + 70, start['y'] + 35, steps=6)
                page.evaluate("miroBrowser.session.refresh()")
                assert page.evaluate("miroBrowser.getSaves()===miroBrowser.groupSaves")
                page.mouse.up()
                page.evaluate("""() => {
                  const b=miroBrowser;b.runtime.getData=b.originalGetData;b.session.refresh();
                  for(const id of ['group-a','group-b']){
                    const c=b.runtime.getData().miroCanvas.connectors[id],old=b.groupBefore.miroCanvas.connectors[id];
                    if(Math.abs(c.from.x-old.from.x-70)>1||Math.abs(c.from.y-old.from.y-35)>1)throw Error('Group drag snapped back: '+id);
                  }
                  if(b.getSaves()!==b.groupSaves+1)throw Error('Group drag was not one save');
                  b.runtime.undo();b.session.refresh();
                  if(JSON.stringify(b.runtime.getData())!==JSON.stringify(b.groupBefore))throw Error('Group undo failed');
                  b.runtime.redo();b.session.refresh();
                  if(b.runtime.getData().miroCanvas.connectors['group-b'].from.x!==-280)throw Error('Group redo failed');
                }""")
                assert errors == [], errors
                page.evaluate("miroBrowser.dispose()")
                browser.close()
                print("OK: shared menus, connector marquee and first-press comment drag (synthetic host)")
                return 0
            if args.interactions:
                page.evaluate("""async () => {
                  const b = miroBrowser;
                  const check = (ok, message) => { if (!ok) throw Error(message); };
                  const clipboard = new DataTransfer();
                  b.select('n1'); b.root.focus();
                  const initialCount=b.runtime.nodes.size;
                  const keyCopy=new KeyboardEvent('keydown',{code:'KeyC',key:'с',ctrlKey:true,bubbles:true,cancelable:true});
                  b.root.dispatchEvent(keyCopy);
                  check(keyCopy.defaultPrevented,'Physical Ctrl+C was not handled');
                  b.root.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyV',key:'м',ctrlKey:true,bubbles:true,cancelable:true}));
                  check(b.runtime.nodes.size===initialCount+1,'Physical Ctrl+V did not paste');
                  b.runtime.undo(); b.session.refresh();
                  b.select('n1', 'file');
                  b.node.nodeEl.tabIndex = 0;
                  b.node.nodeEl.focus();
                  const copy = new ClipboardEvent('copy', {clipboardData: clipboard, bubbles:true, cancelable:true});
                  b.node.nodeEl.dispatchEvent(copy);
                  check(copy.defaultPrevented, 'Copy from focused child was ignored');
                  const payload = JSON.parse(clipboard.getData('text/plain'));
                  check(payload.graph.nodes.length === 2, 'Selection not copied');
                  check(payload.graph.edges.length === 1, 'Internal connector not copied');
                  const before = b.runtime.nodes.size;
                  b.root.focus();
                  b.root.dispatchEvent(new ClipboardEvent('paste', {clipboardData:clipboard, bubbles:true, cancelable:true}));
                  check(b.runtime.nodes.size === before + 2, 'Paste did not add nodes');
                  const files = b.runtime.getData().nodes.filter(n => n.type === 'file' && n.file === 'attachments/Spec.pdf');
                  check(files.length === 2, 'Attachment did not reuse its file path');
                  check(b.sourceUnchanged(), 'Copy duplicated or changed Miro source');
                  b.root.dispatchEvent(new ClipboardEvent('cut', {clipboardData:new DataTransfer(), bubbles:true, cancelable:true}));
                  check(b.runtime.nodes.size === before, 'Cut did not remove pasted selection');
                  b.runtime.undo(); b.session.refresh();
                  check(b.runtime.nodes.size === before + 2, 'Cut undo lost nodes');
                  b.select('n1'); b.root.focus(); b.session.lockSelection();
                  b.root.dispatchEvent(new ClipboardEvent('cut', {clipboardData:new DataTransfer(), bubbles:true, cancelable:true}));
                  check(b.runtime.nodes.has('n1'), 'Cut removed a locked node');
                  b.session.unlockSelection();
                  const input = document.createElement('textarea'); b.root.append(input); input.focus();
                  const textCopy = new ClipboardEvent('copy', {clipboardData:new DataTransfer(), bubbles:true, cancelable:true});
                  input.dispatchEvent(textCopy);
                  check(!textCopy.defaultPrevented, 'Node copy stole text editing');
                  input.remove();
                  b.runtime.importData(b.initial); b.session.refresh();
                  b.select('n1'); b.root.focus();
                  const graph = b.runtime.getData();
                  graph.edges.push({id:'edge-target', fromNode:'file', fromSide:'bottom', toNode:'image', toSide:'top'});
                  b.runtime.importData(graph); b.session.refresh();
                  const geometry = b.session.landingGeometry().geometry;
                  const target = geometry.edges['edge-target'];
                  const point = {x:(target.start.x+target.end.x)/2, y:(target.start.y+target.end.y)/2};
                  b.session.moveConnectorEnd('e1', 'to', b.session.viewportPoint(point));
                  check(b.runtime.data.miroCanvas.localOverrides.e1.connectorAnchors.to.type === 'edge', 'Endpoint did not attach to another edge');
                  check(b.runtime.data.miroCanvas.localOverrides.e1.connectorAnchors.to.edgeId === 'edge-target', 'Wrong edge attached');
                  const nodeCount = b.runtime.nodes.size;
                  b.session.createLine({kind:'arrow',route:'straight',endCap:'arrow',input:'drag'}, [{x:1500,y:1400},{x:1700,y:1400}]);
                  check(b.runtime.nodes.size === nodeCount, 'Free connector created a node');
                  const connectors = b.runtime.getData().miroCanvas.connectors;
                  const id = Object.keys(connectors)[0];
                  check(!!id, 'Free connector was not persisted');
                  check(b.root.querySelector('[data-connector-id="'+id+'"]'), 'Free connector was not rendered');
                  const saved = JSON.parse(JSON.stringify(b.runtime.getData()));
                  b.runtime.undo(); b.session.refresh();
                  check(!b.runtime.getData().miroCanvas.connectors?.[id], 'Connector undo failed');
                  b.runtime.redo(); b.session.refresh();
                  check(b.runtime.getData().miroCanvas.connectors[id].endCap === 'arrow', 'Connector redo lost style');
                  b.runtime.importData(saved); b.session.refresh();
                  b.session.resetTools();
                  b.root.querySelector('[data-connector-id="'+id+'"]').dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:25,bubbles:true}));
                  window.dispatchEvent(new PointerEvent('pointerup',{button:0,pointerId:25,bubbles:true}));
                  const connectorClipboard = new DataTransfer();
                  b.root.focus(); b.root.dispatchEvent(new ClipboardEvent('copy',{clipboardData:connectorClipboard,bubbles:true,cancelable:true}));
                  check(JSON.parse(connectorClipboard.getData('text/plain')).graph.connectors.length === 1, 'Connector selection not copied');
                  b.root.dispatchEvent(new ClipboardEvent('paste',{clipboardData:connectorClipboard,bubbles:true,cancelable:true}));
                  check(Object.keys(b.runtime.getData().miroCanvas.connectors).length === 2, 'Connector paste failed: '+JSON.stringify(b.session.transientDiagnostics));
                  check(b.runtime.nodes.size === nodeCount, 'Connector paste created nodes');
                  b.session.armTool('connector');
                  check(!b.root.querySelector('.miro-canvas-tools__connectors').hidden,'Connector palette closed while tool is active');
                  b.runtime.tx=400; b.runtime.x=80; b.runtime.ty=200; b.runtime.y=30;
                  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
                  const displayed=b.session.viewportPoint({x:80,y:30}), box=b.root.getBoundingClientRect();
                  check(Math.abs(displayed.x-box.left-box.width/2)<1,'Overlay follows target camera instead of displayed camera');
                  check(b.session.minimap.viewport.x===80,'Minimap lags behind displayed camera');
                  b.session.resetTools();
                  check(b.session.armedTool==='select' && b.root.querySelector('.miro-canvas-tools__connectors').hidden,'Reset did not clear connector mode');
                  b.root.querySelector('[data-tool="connector"]').click();
                  check(!b.root.querySelector('.miro-canvas-tools__connectors').hidden,'Connector palette did not open');
                  check(!b.root.querySelector('[data-tool="connector"]').closest('.miro-canvas-toolbar__popover'),'Duplicate connector popover remains');
                  check(b.root.querySelectorAll('.miro-canvas-tools__connectors [data-shape]').length===7,'Connector palette lost a route kind');
                  b.session.resetTools();
                  b.runtime.setViewport(0,0,0);
                  clearInterval(b.session.refreshTimer); b.session.refreshTimer=undefined;
                  const bound={id:'live-bound',from:{type:'node',nodeId:'n1',u:1,v:0.5},to:{type:'node',nodeId:'file',u:0,v:0.5},route:'straight',color:'#334455',width:2,startCap:'none',endCap:'arrow'};
                  check(b.session.writeBoardConnectors([bound]),'Live test connector was refused');
                  const pathBefore=b.root.querySelector('[data-connector-id="live-bound"]').getAttribute('d');
                  const savesBeforeDrag=b.getSaves();
                  b.node.nodeEl.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:91,bubbles:true}));
                  b.node.nodeEl.style.left=(parseFloat(b.node.nodeEl.style.left)+90)+'px';
                  await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
                  const pathDuring=b.root.querySelector('[data-connector-id="live-bound"]').getAttribute('d');
                  check(pathDuring!==pathBefore,'Attached connector waited for polling while its node moved');
                  check(b.getSaves()===savesBeforeDrag,'Live node preview wrote history');
                  window.dispatchEvent(new PointerEvent('pointerup',{button:0,pointerId:91,bubbles:true}));
                  // Finish the native drag's own save/history boundary before testing another gesture.
                  b.runtime.data=b.runtime.getData(); b.runtime.requestSave(true); b.session.refresh();
                  const savesBeforeFreeDrag=b.getSaves();
                  const freeHit=b.root.querySelector('[data-connector-id="'+id+'"]');
                  const freeBefore=freeHit.getAttribute('d');
                  freeHit.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:92,clientX:500,clientY:400,bubbles:true}));
                  window.dispatchEvent(new PointerEvent('pointermove',{pointerId:92,clientX:550,clientY:425,bubbles:true}));
                  check(b.root.querySelector('[data-connector-id="'+id+'"]').getAttribute('d')!==freeBefore,'Line drag preview waited for release');
                  check(b.getSaves()===savesBeforeFreeDrag,'Line drag preview saved before release');
                  window.dispatchEvent(new PointerEvent('pointerup',{button:0,pointerId:92,clientX:550,clientY:425,bubbles:true}));
                  b.session.resetTools(); b.select('n1'); b.root.focus();
                  b.root.querySelector('[data-connector-id="'+id+'"]').dispatchEvent(new PointerEvent('pointerdown',{button:0,shiftKey:true,pointerId:93,bubbles:true}));
                  window.dispatchEvent(new PointerEvent('pointerup',{pointerId:93,bubbles:true}));
                  const mixedCopy=new DataTransfer();
                  b.root.dispatchEvent(new ClipboardEvent('copy',{clipboardData:mixedCopy,bubbles:true,cancelable:true}));
                  const mixed=JSON.parse(mixedCopy.getData('text/plain'));
                  check(mixed.graph.nodes.length===1 && mixed.graph.connectors.length===1,'Shift selection did not copy nodes and connectors together');
                  const beforeMixedPaste=b.runtime.getData();
                  b.root.dispatchEvent(new ClipboardEvent('paste',{clipboardData:mixedCopy,bubbles:true,cancelable:true}));
                  check(b.runtime.nodes.size===beforeMixedPaste.nodes.length+1,'Mixed paste lost its node');
                  check(Object.keys(b.runtime.getData().miroCanvas.connectors).length===Object.keys(beforeMixedPaste.miroCanvas.connectors).length+1,'Mixed paste lost its connector');
                  b.runtime.undo(); b.session.refresh();
                  check(JSON.stringify(b.runtime.getData())===JSON.stringify(beforeMixedPaste),'Mixed paste undo was not atomic');
                  b.session.resetTools(); b.select('n1'); b.session.connectorLayer.select([id]); b.root.focus();
                  const beforeMixed=b.runtime.getData(), savesBeforeMixed=b.getSaves();
                  b.root.querySelector('[data-connector-id="'+id+'"]').dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:94,clientX:500,clientY:400,bubbles:true}));
                  window.dispatchEvent(new PointerEvent('pointermove',{pointerId:94,clientX:560,clientY:420,bubbles:true}));
                  check(b.getSaves()===savesBeforeMixed,'Mixed drag preview wrote history');
                  check(b.node.nodeEl.style.translate==='60px 20px','Mixed drag did not preview node movement');
                  window.dispatchEvent(new PointerEvent('pointerup',{pointerId:94,clientX:560,clientY:420,bubbles:true}));
                  check(b.runtime.getData().nodes.find(n=>n.id==='n1').x===beforeMixed.nodes.find(n=>n.id==='n1').x+60,'Mixed drag did not move node');
                  check(b.runtime.getData().miroCanvas.connectors[id].from.x===beforeMixed.miroCanvas.connectors[id].from.x+60,'Mixed drag did not move connector');
                  b.runtime.undo(); b.session.refresh();
                  check(JSON.stringify(b.runtime.getData())===JSON.stringify(beforeMixed),'Mixed drag undo was not atomic');
                  b.session.resetTools(); b.select('n1'); b.session.connectorLayer.select([id]); b.root.focus();
                  const beforeDelete=b.runtime.getData();
                  b.runtime.deleteSelection(); b.session.refresh();
                  check(!b.runtime.nodes.has('n1')&&!b.runtime.getData().miroCanvas.connectors[id]&&!b.runtime.getData().miroCanvas.connectors['live-bound'],'Native Delete left dangling connectors');
                  b.runtime.undo(); b.session.refresh();
                  check(JSON.stringify(b.runtime.getData())===JSON.stringify(beforeDelete),'Mixed delete undo lost graph data');
                  b.session.resetTools(); b.select('n1'); b.session.connectorLayer.select(['live-bound']); b.root.focus();
                  const boundCopy=new DataTransfer();b.root.dispatchEvent(new ClipboardEvent('copy',{clipboardData:boundCopy,bubbles:true,cancelable:true}));
                  const boundPayload=JSON.parse(boundCopy.getData('text/plain')).graph.connectors[0];
                  check(boundPayload.from.type==='node'&&boundPayload.from.nodeId==='n1'&&boundPayload.to.type==='free','Mixed copy did not detach an external anchor');
                  b.session.resetTools();
                  b.session.penPoints=[{x:-500,y:-500},{x:2500,y:-500},{x:2500,y:2500},{x:-500,y:2500}];
                  b.session.selectLassoed();b.session.readInteractionState();
                  check(b.session.selectedIds.includes('n1')&&b.session.selectedIds.includes(id),'Lasso did not catch a mixed selection');
                  b.dispose();
                }""")
                assert errors == [], errors
                browser.close()
                print("OK: focused clipboard/edge interactions passed (synthetic host)")
                return 0
            assert page.locator(".miro-canvas-dock").count() == 1
            assert page.locator(".miro-canvas-dock__map").count() == 1
            assert page.evaluate("document.querySelector('.miro-canvas-dock').parentElement === miroBrowser.root")
            assert page.evaluate("document.querySelector('.miro-canvas-dock').contains(document.querySelector('.miro-canvas-dock__map'))")
            assert page.evaluate("getComputedStyle(document.querySelector('.miro-canvas-dock')).position") == "absolute"
            assert page.evaluate("getComputedStyle(document.querySelector('.miro-canvas-dock')).right") == "12px"
            assert page.evaluate("getComputedStyle(document.querySelector('.miro-canvas-dock')).bottom") == "36px"
            assert page.evaluate("miroBrowser.getSaves()") == 0, "Opening a board saved it"
            assert page.evaluate("miroBrowser.node.nodeEl.getAttribute('data-miro-source-kind')") == "text"
            assert page.evaluate("miroBrowser.fileNode.nodeEl.getAttribute('data-miro-source-kind')") == "media"
            assert page.evaluate("miroBrowser.edge.edgeEl.getAttribute('data-miro-source-kind')") == "connector"
            assert page.evaluate("miroBrowser.edge.edgeEl.getAttribute('data-miro-source-end-cap')") == "arrow"
            assert page.evaluate("getComputedStyle(miroBrowser.content).fontSize") == "19px"
            native_menu = page.locator(".miro-canvas-toolbar__native > .canvas-menu:not(.miro-canvas-toolbar__native-snapshot)")
            native_snapshot = page.locator(".miro-canvas-toolbar__native-snapshot")
            assert native_menu.count() == 1, "Native Canvas menu was not adopted"
            selection_toolbar = page.locator("[data-miro-canvas-toolbar]")
            width_before_pan = selection_toolbar.evaluate("element => element.getBoundingClientRect().width")
            page.evaluate("""() => {
              const event = new PointerEvent('pointerdown', {button:1, pointerId:17, bubbles:true});
              miroBrowser.root.dispatchEvent(event);
              document.querySelector('.miro-canvas-toolbar__native > .canvas-menu:not(.miro-canvas-toolbar__native-snapshot)').replaceChildren();
            }""")
            assert native_snapshot.is_visible(), "Middle-button pan did not preserve the native tool group"
            width_during_pan = selection_toolbar.evaluate("element => element.getBoundingClientRect().width")
            assert abs(width_during_pan - width_before_pan) < 0.5, "Selection toolbar changed width during middle-button pan"
            page.evaluate("document.dispatchEvent(new PointerEvent('pointerup', {button:1, pointerId:17, bubbles:true}))")
            assert not native_snapshot.is_visible(), "Pan snapshot stayed visible after middle-button release"
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
            assert page.locator(".miro-canvas-toolbar:not(.miro-canvas-tools):not(.miro-board-connector-tools)").count() == 1
            assert not page.evaluate("document.querySelector('.miro-canvas-toolbar').hidden"), (
                "Selection toolbar stayed hidden for a selected node"
            )
            size = page.get_by_label("Font size", exact=True)
            size.fill("28")
            size.dispatch_event("change")
            assert page.evaluate("miroBrowser.runtime.data.miroCanvas.localOverrides.n1.typography.fontSize") == 28
            assert page.evaluate("getComputedStyle(miroBrowser.content).fontSize") == "28px"
            page.get_by_label("Fill color", exact=True).click()
            color = page.get_by_label("Custom fill color", exact=True)
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
            edge_count = page.evaluate("miroBrowser.runtime.edges.size")
            assert page.locator(".miro-canvas-handle--connect").count() == 4
            handle_box = page.locator('.miro-canvas-handle--right[data-handle-position="0.5"]').bounding_box()
            target_box = page.evaluate("() => { const r = miroBrowser.fileNode.nodeEl.getBoundingClientRect(); return {x:r.x,y:r.y}; }")
            assert handle_box is not None
            page.mouse.move(handle_box["x"] + handle_box["width"] / 2, handle_box["y"] + handle_box["height"] / 2)
            page.mouse.down()
            page.mouse.move(target_box["x"] + 20, target_box["y"] + 20)
            page.mouse.up()
            assert page.evaluate("miroBrowser.runtime.edges.size") == edge_count + 1
            precise = page.evaluate("""() => {
              const edge = [...miroBrowser.runtime.edges.values()].at(-1).getData();
              return miroBrowser.runtime.data.miroCanvas.localOverrides[edge.id].connectorAnchors;
            }""")
            # The gesture starts at the explicitly selected right-side midpoint.
            assert precise["from"]["v"] == 0.5 and precise["to"]["v"] != 0.5
            page.evaluate("miroBrowser.runtime.undo(); miroBrowser.session.refresh()")
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
            assert page.evaluate("miroBrowser.node.nodeEl.style.rotate") == ""
            assert page.evaluate("miroBrowser.node.nodeEl.style.transform") == "rotate(30deg)"
            assert page.evaluate("miroBrowser.getHistoryLength()") == history_before_geometry + 1
            page.evaluate("miroBrowser.node.nodeEl.style.transform = 'translate(20px, 0px)'; miroBrowser.session.refresh()")
            for _ in range(5):
                page.evaluate("miroBrowser.runtime.selection.clear(); miroBrowser.session.refresh(); miroBrowser.runtime.selection.add(miroBrowser.node); miroBrowser.session.refresh()")
                assert page.evaluate("miroBrowser.node.nodeEl.style.rotate") == ""
                assert page.evaluate("miroBrowser.node.nodeEl.style.transform") == "translate(20px, 0px) rotate(30deg)"
            page.evaluate("miroBrowser.runtime.undo(); miroBrowser.session.refresh(); miroBrowser.m2.refresh()")
            assert page.evaluate("miroBrowser.node.nodeEl.style.rotate") == ""
            page.evaluate("miroBrowser.runtime.redo(); miroBrowser.session.refresh(); miroBrowser.m2.refresh()")
            assert page.evaluate("miroBrowser.node.nodeEl.style.transform").endswith("rotate(30deg)")
            m2.get_by_role("button", name="Bring to front", exact=True).click()
            assert page.evaluate("miroBrowser.runtime.data.miroCanvas.zOrder.at(-1)") == "n1"
            assert page.evaluate("miroBrowser.sourceUnchanged()")
            page.evaluate("miroBrowser.runtime.undo(); miroBrowser.runtime.undo(); miroBrowser.session.refresh(); miroBrowser.m2.refresh()")
            assert page.evaluate("miroBrowser.node.nodeEl.style.rotate") == ""

            node_count = page.evaluate("miroBrowser.runtime.nodes.size")
            m2.get_by_label("Shape kind", exact=True).select_option("rhombus")
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
            page.evaluate("miroBrowser.session.refresh()")
            marker = page.locator(f'.miro-canvas-comment-marker[data-comment-id="{thread_id}"]')
            assert marker.count() == 1, "Comment was saved without its Canvas marker"
            assert card.locator('[data-comment-time="created"]').count() == 1, "Comment creation time is missing"
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
            assert card.locator('[data-comment-region="replies"] [data-comment-time="created"]').count() == 1
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
            assert page.locator('.miro-canvas-dock[data-miro-canvas-has-selection="false"]').count() == 1
            assert not page.locator(".miro-canvas-panel__selection-only").first.is_visible()
            output = REPO / "tools/obsidian_oracle/.out/m1-browser.png"
            output.parent.mkdir(parents=True, exist_ok=True)
            m2.evaluate("element => element.scrollTop = 0")
            page.evaluate("window.scrollTo(0, 0)")
            page.screenshot(path=str(output))
            left_before_dispose = page.evaluate("miroBrowser.node.nodeEl.style.left")
            page.evaluate("miroBrowser.dispose()")
            assert page.locator(".miro-canvas-dock").count() == 0
            assert page.locator(".miro-canvas-dock__map").count() == 0
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
