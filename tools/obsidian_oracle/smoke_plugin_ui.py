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
                toolbar.get_by_role('button', name='Add or edit line label', exact=True).click()
                label_editor = page.locator('.miro-canvas-connector-label[data-connector-id="menu-line"] .canvas-path-label')
                assert label_editor.get_attribute('contenteditable') == 'true', 'Drawn arrow has no label editor'
                label_editor.fill('First label')
                label_editor.press('Enter')
                assert page.evaluate("miroBrowser.runtime.getData().miroCanvas.connectors['menu-line'].label") == 'First label'
                page.evaluate("""() => {
                  const b=miroBrowser;
                  b.root.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
                }""")
                assert label_editor.get_attribute('contenteditable') == 'true', 'Selected independent arrow has no label editor'
                label_editor.fill('Moving label')
                label_editor.press('Enter')
                assert page.evaluate("miroBrowser.runtime.getData().miroCanvas.connectors['menu-line'].label") == 'Moving label'
                assert page.locator('.miro-canvas-connector-label[data-connector-id="menu-line"]').text_content() == 'Moving label'
                page.evaluate("""() => {
                  const b=miroBrowser,s=b.session;
                  const labelAt=()=>{const r=b.root.querySelector('.miro-canvas-connector-label[data-connector-id="menu-line"]').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};};
                  const label=b.root.querySelector('.miro-canvas-connector-label[data-connector-id="menu-line"]'),{x,y}=labelAt();
                  label.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:455,clientX:x,clientY:y,bubbles:true,cancelable:true}));
                  window.dispatchEvent(new PointerEvent('pointermove',{pointerId:455,clientX:x+90,clientY:y}));
                  window.dispatchEvent(new PointerEvent('pointerup',{pointerId:455,clientX:x+90,clientY:y}));
                  const c=b.runtime.getData().miroCanvas.connectors['menu-line'];
                  if(!(c.labelT>0.5))throw Error('Dragging label did not change its route position: '+JSON.stringify({labelT:c.labelT,x,y,board:s.boardPoint({x:x+90,y})}));
                  const beforeX=labelAt().x;
                  const hit=b.root.querySelector('.miro-board-connector-hit[data-connector-id="menu-line"]');
                  const body=s.viewportPoint({x:-100,y:100});
                  hit.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:456,clientX:body.x,clientY:body.y,bubbles:true,cancelable:true}));
                  window.dispatchEvent(new PointerEvent('pointermove',{pointerId:456,clientX:body.x+40,clientY:body.y,bubbles:true}));
                  window.dispatchEvent(new PointerEvent('pointerup',{pointerId:456,clientX:body.x+40,clientY:body.y,bubbles:true}));
                  const afterX=labelAt().x;
                  if(Math.abs(afterX-beforeX-40)>1)throw Error('Connector body moved without its label');
                  b.runtime.undo();s.refresh();
                }""")
                page.evaluate("""() => {
                  const b=miroBrowser,s=b.session;
                  s.writeBoardConnectors([{id:'menu-line-2',from:{type:'free',x:-150,y:140},to:{type:'free',x:90,y:140},route:'straight',color:'#334455',width:2,startCap:'none',endCap:'arrow'}]);
                  s.connectorLayer.select(['menu-line','menu-line-2']);s.refresh();
                  const labelX=()=>b.root.querySelector('.miro-canvas-connector-label[data-connector-id="menu-line"]').getBoundingClientRect().left;
                  const before=labelX();
                  const frame=b.root.querySelector('.miro-canvas-mixed-selection-frame');
                  if(!frame)throw Error('Two selected arrows have no group frame');
                  const r=frame.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
                  frame.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:457,clientX:x,clientY:y,bubbles:true,cancelable:true}));
                  window.dispatchEvent(new PointerEvent('pointermove',{pointerId:457,clientX:x+35,clientY:y+10}));
                  const during=labelX();
                  if(Math.abs(during-before-35)>1)throw Error('Arrow label lagged behind group drag');
                  window.dispatchEvent(new PointerEvent('pointerup',{pointerId:457,clientX:x+35,clientY:y+10}));
                  const after=labelX();
                  if(Math.abs(after-before-35)>1)throw Error('Arrow label reverted after group drag');
                  b.runtime.undo();s.refresh();
                  s.writeBoardConnectors([],['menu-line-2']);
                  s.connectorLayer.select(['menu-line']);s.refresh();
                }""")
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
                connector_layout = panel.evaluate("""el => ({width:el.clientWidth,scroll:el.scrollWidth,
                  centers:[...el.children].map(child=>{const r=child.getBoundingClientRect();return r.top+r.height/2})})""")
                assert connector_layout['scroll'] <= connector_layout['width'] + 1, connector_layout
                assert max(connector_layout['centers']) - min(connector_layout['centers']) < 2, connector_layout
                tools_bar = page.locator('.miro-canvas-tools')
                connector_width = tools_bar.bounding_box()['width']
                positions = panel.locator(':scope > [data-shape]').evaluate_all("els=>els.map(e=>e.getBoundingClientRect().top)")
                assert len(positions) == 7 and max(positions) - min(positions) < 1, 'Types must be directly available in one row'
                assert panel.locator('.miro-canvas-toolbar__panel').count() == 0
                tools_bar.get_by_role('button', name='Pen P', exact=True).click()
                assert abs(tools_bar.bounding_box()['width'] - connector_width) < 1, 'Drawing/connector widths differ'
                if args.screenshots:
                    page.screenshot(path=str(args.screenshots / 'drawing-controls.png'))
                drawing_layout = tools_bar.locator('.miro-canvas-tools__drawing').evaluate("""el => ({width:el.clientWidth,scroll:el.scrollWidth,
                  centers:[...el.children].map(child=>{const r=child.getBoundingClientRect();return r.top+r.height/2})})""")
                assert drawing_layout['scroll'] <= drawing_layout['width'] + 1, drawing_layout
                assert max(drawing_layout['centers']) - min(drawing_layout['centers']) < 2, drawing_layout
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
                # Drag an existing end while the creation tool is still armed: the
                # grips are the ones native edges use.
                before_end = page.evaluate("miroBrowser.runtime.getData().miroCanvas.connectors['menu-line'].from")
                box = page.evaluate("document.querySelector('.miro-canvas-handles [data-connector-end=from]').getBoundingClientRect().toJSON()")
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
                assert page.locator('.miro-canvas-handles [data-connector-end]:visible').count() == 2
                # Non-unit zoom and an offset camera must use the same endpoint origin.
                page.evaluate("miroBrowser.runtime.setViewport(60,30,1);miroBrowser.session.followViewport()")
                box = page.evaluate("document.querySelector('.miro-canvas-handles [data-connector-end=from]').getBoundingClientRect().toJSON()")
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
                page.evaluate("miroBrowser.runtime.setViewport(0,0,0);miroBrowser.session.followViewport()")
                page.evaluate("""() => {
                  const b=miroBrowser,s=b.session,path=b.root.querySelector('.miro-board-connector-hit');
                  if(!path)throw Error('Pan test has no connector');
                  const before=path.getBoundingClientRect(),origin=s.viewportPoint({x:0,y:0});
                  b.runtime.setViewport(40,25,0);s.followViewport();
                  const after=b.root.querySelector('.miro-board-connector-hit').getBoundingClientRect(),next=s.viewportPoint({x:0,y:0});
                  if(path!==b.root.querySelector('.miro-board-connector-hit'))throw Error('Pure pan rebuilt connector DOM');
                  if(Math.abs(after.left-before.left-(next.x-origin.x))>1||Math.abs(after.top-before.top-(next.y-origin.y))>1)
                    throw Error('Pure pan left the connector behind the canvas: '+JSON.stringify({before:before.toJSON(),after:after.toJSON(),canvas:b.runtime.canvasEl.style.transform}));
                  b.runtime.setViewport(0,0,0);s.followViewport();
                }""")
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
                  const s=b.session,originalRefresh=s.refresh.bind(s),originalSelect=s.connectorLayer.select.bind(s.connectorLayer);
                  let refreshes=0,selections=0;
                  s.refresh=()=>{refreshes++;return originalRefresh();};
                  s.connectorLayer.select=(...args)=>{selections++;return originalSelect(...args);};
                  for(let i=1;i<=30;i++)window.dispatchEvent(new PointerEvent('pointermove',
                    {pointerId:45,clientX:start.x+(end.x-start.x)*i/30,clientY:start.y+(end.y-start.y)*i/30,bubbles:true}));
                  if(b.root.getAttribute('data-miro-rectangle-selecting')!=='true')throw Error('Marquee active state is missing');
                  if(refreshes!==0||selections!==0)throw Error('Marquee rebuilt the plugin on pointermove: '+JSON.stringify({refreshes,selections}));
                  window.dispatchEvent(new PointerEvent('pointerup',{pointerId:45,clientX:end.x,clientY:end.y,bubbles:true}));
                  s.refresh=originalRefresh;s.connectorLayer.select=originalSelect;
                  await Promise.resolve();b.session.readInteractionState();
                  if(b.root.hasAttribute('data-miro-rectangle-selecting'))throw Error('Marquee active state survived release');
                  if(b.session.selectedIds.includes('menu-line'))throw Error('A small marquee selected a long crossing connector');
                  if(b.getSaves()!==saves)throw Error('Selection wrote history');
                  b.session.resetTools();b.session.commentDraft={type:'free',x:200,y:180};b.session.createComment('First press drag');b.session.closeCommentThread();b.select('n1');b.root.focus();
                }""")
                page.evaluate("""() => {
                  const b=miroBrowser,s=b.session,c=b.runtime.getData().miroCanvas.connectors['menu-line'];
                  const at=s.viewportPoint(c.from),first={x:at.x-12,y:at.y-12},last={x:at.x+12,y:at.y+12};
                  b.root.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:245,clientX:first.x,clientY:first.y,bubbles:true,cancelable:true}));
                  window.dispatchEvent(new PointerEvent('pointermove',{pointerId:245,clientX:last.x,clientY:last.y}));
                  window.dispatchEvent(new PointerEvent('pointerup',{pointerId:245,clientX:last.x,clientY:last.y}));
                  const mask=s.selectedRouteEnds.get('menu-line');
                  if(!mask?.from||mask.to||!s.selectedIds.includes('menu-line'))throw Error('Marquee did not select only the near endpoint');
                  const frame=b.root.querySelector('.miro-canvas-mixed-selection-frame'),r=frame?.getBoundingClientRect();
                  if(!r||r.width>60||r.height>60)throw Error('Partial connector selection framed the far end');
                  const before=b.runtime.getData(),x=r.left+r.width/2,y=r.top+r.height/2;
                  frame.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:247,clientX:x,clientY:y,bubbles:true,cancelable:true}));
                  window.dispatchEvent(new PointerEvent('pointermove',{pointerId:247,clientX:x+30,clientY:y+15}));
                  window.dispatchEvent(new PointerEvent('pointerup',{pointerId:247,clientX:x+30,clientY:y+15}));
                  const after=b.runtime.getData();
                  if(after.miroCanvas.connectors['menu-line'].from.x!==before.miroCanvas.connectors['menu-line'].from.x+30
                    ||after.miroCanvas.connectors['menu-line'].to.x!==before.miroCanvas.connectors['menu-line'].to.x)
                    throw Error('Partial selection moved the far endpoint');
                  const second=b.root.querySelector('.miro-canvas-mixed-selection-frame')?.getBoundingClientRect();
                  if(!second||!s.selectedRouteEnds.get('menu-line')?.from)throw Error('Partial endpoint selection vanished after first move');
                  const sx=second.left+second.width/2,sy=second.top+second.height/2;
                  b.root.querySelector('.miro-canvas-mixed-selection-frame').dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:250,clientX:sx,clientY:sy,bubbles:true,cancelable:true}));
                  window.dispatchEvent(new PointerEvent('pointermove',{pointerId:250,clientX:sx+10,clientY:sy+5}));
                  window.dispatchEvent(new PointerEvent('pointerup',{pointerId:250,clientX:sx+10,clientY:sy+5}));
                  const twice=b.runtime.getData().miroCanvas.connectors['menu-line'];
                  if(twice.from.x!==before.miroCanvas.connectors['menu-line'].from.x+40||twice.to.x!==before.miroCanvas.connectors['menu-line'].to.x)
                    throw Error('Second partial drag moved the far endpoint');
                  b.runtime.undo();b.runtime.undo();s.resetTools();
                }""")
                page.evaluate("""() => {
                  const b=miroBrowser,s=b.session,route=s.landingGeometry().geometry.edges.e1;
                  const at=s.viewportPoint(route.start),first={x:at.x-10,y:at.y-10},last={x:at.x+10,y:at.y+10};
                  b.root.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:248,clientX:first.x,clientY:first.y,bubbles:true,cancelable:true}));
                  window.dispatchEvent(new PointerEvent('pointermove',{pointerId:248,clientX:last.x,clientY:last.y}));
                  window.dispatchEvent(new PointerEvent('pointerup',{pointerId:248,clientX:last.x,clientY:last.y}));
                  const mask=s.selectedRouteEnds.get('e1');
                  if(!mask?.from||mask.to)throw Error('Native edge near end was not selected separately');
                  const frame=b.root.querySelector('.miro-canvas-mixed-selection-frame'),r=frame?.getBoundingClientRect();
                  if(!r||r.width>60||r.height>60)throw Error('Native partial edge frame includes its far end');
                  const before=b.runtime.getData(),x=r.left+r.width/2,y=r.top+r.height/2;
                  frame.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:249,clientX:x,clientY:y,bubbles:true,cancelable:true}));
                  window.dispatchEvent(new PointerEvent('pointermove',{pointerId:249,clientX:x+25,clientY:y+15}));
                  window.dispatchEvent(new PointerEvent('pointerup',{pointerId:249,clientX:x+25,clientY:y+15}));
                  const after=b.runtime.getData(),anchor=after.miroCanvas.localOverrides.e1?.connectorAnchors?.from;
                  if(anchor?.type!=='free'||Math.abs(anchor.x-route.start.x-25)>1||Math.abs(anchor.y-route.start.y-15)>1
                    ||after.miroCanvas.localOverrides.e1?.connectorAnchors?.to!==undefined)
                    throw Error('Native partial edge moved or detached the wrong end: '+JSON.stringify(anchor));
                  b.runtime.undo();s.resetTools();
                  if(JSON.stringify(b.runtime.getData())!==JSON.stringify(before))throw Error('Native endpoint drag undo failed');
                }""")
                page.evaluate("""() => {
                  const b=miroBrowser,s=b.session;s.resetTools();
                  // The synthetic host places native DOM nodes directly in the root,
                  // while plugin routes use the centered Canvas viewport transform.
                  // The marquee deliberately spans both painted coordinate systems.
                  const start={x:10,y:20},end=s.viewportPoint({x:400,y:330});
                  const nativeBox=b.root.appendChild(document.createElement('div'));nativeBox.className='canvas-selection';
                  b.root.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:246,clientX:start.x,clientY:start.y,bubbles:true,cancelable:true}));
                  window.dispatchEvent(new PointerEvent('pointermove',{pointerId:246,clientX:end.x,clientY:end.y,bubbles:true}));
                  const marquee=b.root.querySelector('.miro-canvas-rectangle-marquee');
                  if(!marquee||marquee.hidden||getComputedStyle(nativeBox).visibility!=='hidden')throw Error('Two live rectangle frames are visible');
                  window.dispatchEvent(new PointerEvent('pointerup',{pointerId:246,clientX:end.x,clientY:end.y,bubbles:true}));
                  if(b.root.querySelector('.miro-canvas-rectangle-marquee'))throw Error('Live marquee survived release');
                  if(!s.selectedIds.includes('n1')||!s.selectedIds.includes('menu-line')||!s.selectedIds.includes('e1'))
                    throw Error('Rectangle failed to select node, independent connector, or native edge: '+s.selectedIds);
                  const comment=s.commentThreads()[0],key=comment.origin+':'+comment.id;
                  if(!s.selectedCommentKeys.has(key))throw Error('Rectangle failed to select comment');
                  const frame=b.root.querySelector('.miro-canvas-mixed-selection-frame');
                  if(!frame||getComputedStyle(nativeBox).visibility!=='hidden')throw Error('Mixed selection shows two frames');
                  const marker=b.root.querySelector('.miro-canvas-comment-marker'),pin=marker?.getBoundingClientRect(),outline=frame.getBoundingClientRect();
                  if(!pin||outline.left>pin.left||outline.right<pin.right||outline.top>pin.top||outline.bottom<pin.bottom)
                    throw Error('Mixed frame excludes selected comment avatar');
                  const line=b.root.querySelector('.miro-board-connector-hit[data-connector-id="menu-line"]')?.getBoundingClientRect();
                  if(!line||outline.left>line.left||outline.right<line.right||outline.top>line.top||outline.bottom<line.bottom)
                    throw Error('Mixed frame excludes a selected connector');
                  const before=b.runtime.getData(),saves=b.getSaves(),r=frame.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
                  frame.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:247,clientX:x,clientY:y,bubbles:true,cancelable:true}));
                  window.dispatchEvent(new PointerEvent('pointermove',{pointerId:247,clientX:x+25,clientY:y+15}));
                  window.dispatchEvent(new PointerEvent('pointerup',{pointerId:247,clientX:x+25,clientY:y+15}));
                  const after=b.runtime.getData();
                  if(after.nodes.find(n=>n.id==='n1').x!==before.nodes.find(n=>n.id==='n1').x+25
                    ||after.miroCanvas.connectors['menu-line'].from.x!==before.miroCanvas.connectors['menu-line'].from.x+25
                    ||after.miroCanvas.commentPlaces[key].x!==225||after.miroCanvas.commentPlaces[key].y!==195)
                    throw Error('Group frame did not move node, connector, and comment together');
                  if(b.getSaves()!==saves+1)throw Error('Mixed move wrote multiple undo steps');
                  b.runtime.undo();s.refresh();
                  if(JSON.stringify(b.runtime.getData())!==JSON.stringify(before))throw Error('Mixed move undo did not restore all items');
                  nativeBox.remove();s.resetTools();b.select('n1');
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
                marker.click()
                card = page.locator('.miro-canvas-thread')
                assert card.get_by_role('button', name='Delete comment', exact=True).is_visible()
                assert not card.get_by_role('button', name='Remove imported comment from board', exact=True).is_visible()
                card.get_by_role('button', name='Close', exact=True).click()
                page.evaluate("""() => {
                  const b=miroBrowser,s=b.session;s.resetTools();s.connectorLayer.select(['menu-line']);
                  const first=b.runtime.getData().miroCanvas.connectors['menu-line'];
                  const press=()=>{
                    const grip=document.querySelector('.miro-canvas-handles [data-connector-end=from]');
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
                  if(!['none','transparent'].includes(hit.getAttribute('fill')))throw Error('Hit overlay paints over block arrow');
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
                    if(Math.abs(c.from.x-old.from.x-70)>1||Math.abs(c.from.y-old.from.y-35)>1)throw Error('Group drag snapped back: '+id+' '+JSON.stringify({now:c.from,before:old.from,diagnostics:b.session.transientDiagnostics.slice(-3)}));
                  }
                  if(b.getSaves()!==b.groupSaves+1)throw Error('Group drag was not one save');
                  b.runtime.undo();b.session.refresh();
                  if(JSON.stringify(b.runtime.getData())!==JSON.stringify(b.groupBefore))throw Error('Group undo failed');
                  b.runtime.redo();b.session.refresh();
                  if(b.runtime.getData().miroCanvas.connectors['group-b'].from.x!==-280)throw Error('Group redo failed');
                }""")
                page.evaluate("""() => {
                  const b=miroBrowser,s=b.session;s.resetTools();
                  for(const route of ['straight','curved','elbowed']) {
                    const c={id:'reshape-'+route,from:{type:'node',nodeId:'n1',u:1,v:0.5},to:{type:'node',nodeId:'file',u:0,v:0.5},route,color:'#223344',width:2,startCap:'none',endCap:'arrow'};
                    s.writeBoardConnectors([c]);s.connectorLayer.select([c.id]);s.armTool('connector');
                    const grip=b.root.querySelector('[data-route-grip]');
                    if(!grip)throw Error('Missing body grips: '+route);
                    const r=grip.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;
                    const hit=b.root.querySelector('[data-connector-id="'+c.id+'"]'),saves=b.getSaves();
                    const shown=()=>b.root.querySelector('.miro-canvas-handles__preview path')?.getAttribute('d')??'';
                    const before=shown();
                    // Press the path itself, not the grip: attached bodies must bend too.
                    hit.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:98,clientX:x,clientY:y,bubbles:true}));
                    window.dispatchEvent(new PointerEvent('pointermove',{pointerId:98,clientX:x+40,clientY:y+50}));
                    if(shown()===before)throw Error('Body preview did not change: '+route);
                    s.refresh();
                    if(b.getSaves()!==saves)throw Error('Body preview saved early');
                    window.dispatchEvent(new PointerEvent('pointerup',{pointerId:98,clientX:x+40,clientY:y+50}));
                    const next=b.runtime.getData().miroCanvas.connectors[c.id];
                    if(!next.waypoints.length||JSON.stringify(next.from)!==JSON.stringify(c.from)||JSON.stringify(next.to)!==JSON.stringify(c.to))throw Error('Reshape lost endpoint anchors');
                    if(b.getSaves()!==saves+1)throw Error('Reshape was not one history step');
                    b.runtime.undo();s.refresh();
                    if(b.runtime.getData().miroCanvas.connectors[c.id].waypoints)throw Error('Reshape undo failed');
                    b.runtime.redo();s.refresh();
                    if(!b.runtime.getData().miroCanvas.connectors[c.id].waypoints.length)throw Error('Reshape redo failed');
                  }
                }""")
                # Latest user regressions: author controls, comment anchors, circular ink,
                # independent cap sizing and rotation previews must work together.
                page.evaluate("""() => {
                  const b=miroBrowser,s=b.session;s.resetTools();s.armTool('pen');
                  const picker=b.root.querySelector('[aria-label="New drawing color"]');
                  const r=picker.getBoundingClientRect();
                  if(Math.abs(r.width-r.height)>1||r.width>24)throw Error('Custom color is not circular');
                  s.resetTools();
                  const at={x:-200,y:-180};s.composeComment(at,s.viewportPoint(at));
                }""")
                card = page.locator('.miro-canvas-thread')
                card.get_by_label('Author name', exact=True).fill('Before posting')
                card.get_by_label('Reply', exact=True).fill('Author and connector regression')
                card.get_by_role('button', name='Send reply', exact=True).click()
                card.get_by_label('Edit author name', exact=True).fill('After posting')
                page.evaluate('miroBrowser.session.refresh()')
                assert card.get_by_label('Edit author name', exact=True).input_value() == 'After posting'
                card.get_by_label('Edit author name', exact=True).press('Enter')
                page.evaluate('miroBrowser.colorSaves=miroBrowser.getSaves()')
                card.get_by_label('Comment color', exact=True).evaluate("""el => {
                  el.focus();
                  for(const value of ['#405080','#664499','#3f66aa']){
                    el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));
                  }
                }""")
                page.evaluate('miroBrowser.session.refresh()')
                assert card.get_by_label('Comment color', exact=True).input_value() == '#3f66aa'
                assert page.evaluate('miroBrowser.getSaves()===miroBrowser.colorSaves'), 'Picker movement wrote to the board'
                assert page.evaluate("""() => {
                  const b=miroBrowser,t=b.session.commentThreads().find(t=>t.text==='Author and connector regression');
                  return b.root.querySelector('[data-comment-id="'+t.id+'"]').style.getPropertyValue('--miro-avatar')==='#3f66aa';
                }"""), 'Comment pin did not preview the color immediately'
                card.get_by_label('Comment color', exact=True).evaluate("el => el.dispatchEvent(new Event('change',{bubbles:true}))")
                assert page.evaluate('miroBrowser.getSaves()===miroBrowser.colorSaves+1'), 'Color selection did not save exactly once'
                card.get_by_role('button', name='Lock comment', exact=True).click()
                assert card.get_by_role('button', name='Delete comment', exact=True).is_disabled()
                assert card.get_by_label('Resolve', exact=True).is_disabled()
                assert card.get_by_label('Comment color', exact=True).is_disabled()
                assert card.get_by_label('Edit author name', exact=True).count() == 0
                assert card.locator('.miro-canvas-thread__composer').is_hidden()
                assert card.locator('.miro-canvas-thread__note').inner_text().startswith('Locked comment')
                assert page.evaluate("""() => {
                  const b=miroBrowser,t=b.session.commentThreads().find(t=>t.text==='Author and connector regression');
                  return b.root.querySelector('.miro-canvas-comment-marker[data-comment-id="'+t.id+'"]')?.getAttribute('data-comment-locked')==='true';
                }"""), 'Comment pin does not indicate its locked state'
                page.evaluate("""() => {
                  const b=miroBrowser,s=b.session;
                  const thread=s.commentThreads().find(t=>t.text==='Author and connector regression');
                  if(thread.author.name!=='After posting')throw Error('Author rename was not saved');
                  if(thread.color!=='#3f66aa'||thread.locked!==true)throw Error('Comment color or lock was not saved');
                  if(b.runtime.getData().miroCanvas.commentDecorations['local:'+thread.id]?.color!=='#3f66aa')
                    throw Error('Colour existed only in the card and not in board metadata');
                  const original=JSON.stringify(b.runtime.getData().miroCanvas.commentPlaces??{});
                  s.moveCommentThread(thread.id,'local',s.viewportPoint({x:400,y:500}));
                  if(JSON.stringify(b.runtime.getData().miroCanvas.commentPlaces??{})!==original)throw Error('Locked comment moved');
                  b.pinId=thread.id;
                  s.connectorHeadSize=30;s.connectorWidth=2;s.updateQuickTools();
                }""")
                card.get_by_role('button', name='Unlock comment', exact=True).click()
                assert card.locator('.miro-canvas-thread__composer').is_visible()
                assert card.get_by_label('Resolve', exact=True).is_enabled()
                assert page.evaluate("""() => {
                  const b=miroBrowser;
                  return b.root.querySelector('.miro-canvas-comment-marker[data-comment-id="'+b.pinId+'"]')?.getAttribute('data-comment-locked')==='false';
                }"""), 'Comment pin did not clear its locked state'
                card.get_by_label('Reply', exact=True).fill('Temporary reply')
                card.get_by_role('button', name='Send reply', exact=True).click()
                assert card.get_by_role('button', name='Delete reply', exact=True).is_visible()
                page.evaluate("""() => {const b=miroBrowser,card=b.session.commentCard,h=card.host,original=h.onDeleteReply;b.replyCardBefore={thread:card.thread?.id,immutable:card.thread?.immutable,origin:card.thread?.origin,open:b.session.openThread};h.onDeleteReply=(...args)=>{b.replyDeleteCalled=args;original(...args);};}""")
                card.get_by_role('button', name='Delete reply', exact=True).click()
                page.evaluate("""() => {
                  const b=miroBrowser,s=b.session;
                  if(s.commentThreads().find(t=>t.id===b.pinId).replies.length!==0)throw Error('Deleting one reply failed: '+JSON.stringify({called:b.replyDeleteCalled,cardBefore:b.replyCardBefore,cardAfter:{thread:s.commentCard.thread?.id,open:s.openThread},replies:s.commentThreads().find(t=>t.id===b.pinId).replies,locked:s.commentLocked(b.pinId,'local'),status:s.transientDiagnostics}));
                  s.closeCommentThread();s.armTool('connector');s.toolShape='arrow';
                }""")
                pin = page.locator('.miro-canvas-comment-marker[data-comment-id="' + page.evaluate('miroBrowser.pinId') + '"]')
                box = pin.bounding_box()
                assert box is not None
                page.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
                page.mouse.down()
                target = page.evaluate('miroBrowser.session.viewportPoint({x:40,y:180})')
                page.mouse.move(target['x'], target['y'], steps=6)
                page.mouse.up()
                page.evaluate("""() => {
                  const b=miroBrowser,s=b.session;
                  const c=Object.values(b.runtime.getData().miroCanvas.connectors).find(c=>c.from.type==='comment'&&c.from.commentId===b.pinId);
                  if(!c||c.to.type!=='node'||c.to.nodeId!=='n1')throw Error('Cannot drag arrow from comment to node');
                  if(c.headSize!==30)throw Error('Creation lost head size');
                  s.resetTools();s.connectorLayer.select([c.id]);s.readInteractionState();s.applyElementStyle({connector:{width:8}});
                  if(b.runtime.getData().miroCanvas.connectors[c.id].headSize!==30)throw Error('Width overwrote head size');
                  const visible=()=>b.root.querySelector('[data-connector-id="'+c.id+'"]').previousElementSibling;
                  const markerId=visible().getAttribute('marker-end').slice(5,-1);
                  const marker=document.getElementById(markerId);
                  if(marker.getAttribute('markerUnits')!=='userSpaceOnUse')throw Error('Head still scales with width');
                  s.writeBoardConnectors([{id:'attached-free',from:{type:'node',nodeId:'n1',u:1,v:0.5},
                    to:{type:'free',x:500,y:140},waypoints:[{x:350,y:75}],route:'curved',
                    color:'#abcdef',width:2,startCap:'none',endCap:'arrow'}]);
                  const freeBefore=JSON.stringify(b.runtime.getData().miroCanvas.connectors['attached-free']);
                  const routeBefore=s.landingGeometry().geometry.edges['attached-free'];
                  const before=visible().getAttribute('d'),saves=b.getSaves();
                  s.previewRotation('n1',90);
                  if(visible().getAttribute('d')===before)throw Error('Connector did not follow rotation preview');
                  const routeDuring=s.landingGeometry().geometry.edges['attached-free'];
                  if(routeDuring.start.x===routeBefore.start.x&&routeDuring.start.y===routeBefore.start.y)
                    throw Error('Attached endpoint ignored node rotation');
                  if(routeDuring.end.x!==routeBefore.end.x||routeDuring.end.y!==routeBefore.end.y)
                    throw Error('Free endpoint rotated rigidly with node');
                  if(b.getSaves()!==saves)throw Error('Rotation preview saved early');
                  s.cancelHandleRotation();
                  if(visible().getAttribute('d')!==before)throw Error('Cancelled rotation left connector rotated');
                  s.setElementRotation('n1',90);s.refresh();
                  if(visible().getAttribute('d')===before)throw Error('Committed rotation missed connector');
                  if(JSON.stringify(b.runtime.getData().miroCanvas.connectors['attached-free'])!==freeBefore)
                    throw Error('Node rotation rewrote free connector geometry');
                  b.runtime.undo();s.refresh();
                  if(visible().getAttribute('d')!==before)throw Error('Rotation undo missed connector');
                  const pinMarker=b.root.querySelector('.miro-canvas-comment-marker[data-comment-id="'+b.pinId+'"]');
                  const r=pinMarker.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
                  const pinBefore=JSON.stringify(b.runtime.getData()),pathBefore=visible().getAttribute('d'),pinSaves=b.getSaves();
                  const press=pointerId=>pinMarker.dispatchEvent(new PointerEvent('pointerdown',
                    {button:0,pointerId,clientX:x,clientY:y,bubbles:true,cancelable:true}));
                  const move=pointerId=>window.dispatchEvent(new PointerEvent('pointermove',
                    {pointerId,clientX:x+35,clientY:y+22,bubbles:true}));
                  press(87);move(87);
                  if(visible().getAttribute('d')===pathBefore)throw Error('Arrow lagged behind comment drag');
                  if(JSON.stringify(b.runtime.getData())!==pinBefore||b.getSaves()!==pinSaves)
                    throw Error('Comment drag preview wrote to the board');
                  window.dispatchEvent(new PointerEvent('pointercancel',{pointerId:87,bubbles:true}));
                  if(visible().getAttribute('d')!==pathBefore)throw Error('Cancelled pin drag left arrow displaced');
                  press(88);move(88);
                  window.dispatchEvent(new PointerEvent('pointerup',
                    {pointerId:88,clientX:x+35,clientY:y+22,bubbles:true}));
                  if(visible().getAttribute('d')===pathBefore)throw Error('Committed pin drag lost arrow movement');
                  if(b.getSaves()!==pinSaves+1)throw Error('Pin drag did not commit once');
                  const pinPoint=s.landingGeometry().geometry.comments['local:'+b.pinId];
                  s.moveCommentThread(b.pinId,'local',s.viewportPoint({x:pinPoint.x+30,y:pinPoint.y+20}));
                  const after=s.landingGeometry().geometry.edges[c.id];
                  if(Math.abs(after.start.x-pinPoint.x-30)>1)throw Error('Connector did not follow moved comment');
                  s.openCommentThread(b.pinId,'local');
                  b.pinConnector=c.id;
                }""")
                card.get_by_role('button', name='Delete comment', exact=True).click()
                page.evaluate("""() => {
                  const b=miroBrowser,s=b.session,c=b.runtime.getData().miroCanvas.connectors[b.pinConnector];
                  if(c.from.type!=='free')throw Error('Deleting comment left dangling arrow');
                  b.runtime.undo();s.refresh();
                  if(b.runtime.getData().miroCanvas.connectors[c.id].from.type!=='comment')throw Error('Undo did not restore comment attachment');
                }""")
                page.evaluate("""() => {
                  const b=miroBrowser,s=b.session;b.runtime.importData(b.initial);s.refresh();
                  s.writeBoardConnectors([{id:'mixed-line',route:'straight',color:'#abcdef',width:2,startCap:'none',endCap:'arrow',
                    from:{type:'free',x:-300,y:-150},to:{type:'free',x:-150,y:-90}}]);
                  b.select('n1');s.connectorLayer.select(['mixed-line']);s.refresh();
                  b.root.style.setProperty('--interactive-accent','#8038ff');
                  const frame=b.root.querySelector('.miro-canvas-mixed-selection-frame');
                  if(!frame)throw Error('Mixed selection has no shared frame');
                  const nativeBox=b.root.appendChild(document.createElement('div'));
                  nativeBox.className='canvas-selection';
                  if(!b.root.classList.contains('miro-canvas-mixed-selection--independent')
                    ||getComputedStyle(nativeBox).visibility!=='hidden'
                    ||getComputedStyle(frame).borderTopWidth==='0px')
                    throw Error('Independent connector selection must use only the shared visible frame: '+JSON.stringify({root:b.root.className,native:getComputedStyle(nativeBox).visibility,shared:getComputedStyle(frame).borderTopWidth}));
                  nativeBox.remove();
                  const f=frame.getBoundingClientRect(),n=b.node.nodeEl.getBoundingClientRect();
                  const a=s.viewportPoint({x:-300,y:-150}),z=s.viewportPoint({x:-150,y:-90});
                  if(f.left>Math.min(a.x,z.x)-5||f.right<n.right+5||f.top>Math.min(a.y,z.y)-5||f.bottom<n.bottom+5)
                    throw Error('Mixed frame excludes a selected element');
                  b.mixedBefore=b.runtime.getData();b.mixedSaves=b.getSaves();
                  b.root.addEventListener('pointerdown',e=>{b.mixedDown={target:e.target.className,ids:[...s.selectedIds],layer:s.connectorLayer.selection()};},true);
                }""")
                frame = page.locator('.miro-canvas-mixed-selection-frame')
                bounds = frame.bounding_box()
                assert bounds is not None
                page.mouse.move(bounds['x'] + 1, bounds['y'] + bounds['height'] / 2)
                page.mouse.down()
                page.mouse.move(bounds['x'] + 61, bounds['y'] + bounds['height'] / 2 + 30, steps=5)
                page.mouse.up()
                page.evaluate("""() => {
                  const b=miroBrowser,s=b.session,d=b.runtime.getData(),old=b.mixedBefore;
                  const node=d.nodes.find(n=>n.id==='n1'),before=old.nodes.find(n=>n.id==='n1');
                  const line=d.miroCanvas.connectors['mixed-line'],prior=old.miroCanvas.connectors['mixed-line'];
                  if(node.x!==before.x+60||node.y!==before.y+30||line.from.x!==prior.from.x+60||line.from.y!==prior.from.y+30)
                    throw Error('Dragging shared frame did not move all selected elements: '+JSON.stringify({node:[node.x,node.y],before:[before.x,before.y],line:line.from,prior:prior.from,selected:s.selectedIds,down:b.mixedDown,saves:[b.getSaves(),b.mixedSaves]}));
                  if(b.getSaves()!==b.mixedSaves+1)throw Error('Mixed frame drag wrote more than one history step');
                  b.runtime.undo();s.refresh();
                  if(JSON.stringify(b.runtime.getData())!==JSON.stringify(old))throw Error('Mixed frame undo failed');
                  b.runtime.redo();s.refresh();
                  if(b.runtime.getData().miroCanvas.connectors['mixed-line'].from.x!==prior.from.x+60)throw Error('Mixed frame redo failed');
                  s.connectorLayer.reset();s.refresh();
                  if(b.root.querySelector('.miro-canvas-mixed-selection-frame'))throw Error('Mixed frame remained after connector deselection');
                  b.select('n1','file');s.refresh();
                  const nativeFrame=b.root.querySelector('.miro-canvas-mixed-selection-frame');
                  if(!nativeFrame || getComputedStyle(nativeFrame).pointerEvents!=='auto')
                    throw Error('Marquee-selected native items need a draggable frame interior');
                  const nativeBox=b.root.appendChild(document.createElement('div'));
                  nativeBox.className='canvas-selection';
                  if(b.root.classList.contains('miro-canvas-mixed-selection--independent')
                    ||getComputedStyle(nativeBox).visibility!=='visible'
                    ||getComputedStyle(nativeFrame).borderTopWidth!=='0px')
                    throw Error('Native-only selection has two visible frames');
                  nativeBox.remove();
                  const bounds=nativeFrame.getBoundingClientRect();
                  const x=bounds.left+bounds.width/2,y=bounds.top+bounds.height/2;
                  if(!nativeFrame.contains(document.elementFromPoint(x,y)))
                    throw Error('The interior of the selection frame is not the hit target');
                  b.nativeFrameBefore=b.runtime.getData();
                  const stale=b.runtime.importData.bind(b.runtime);
                  b.runtime.importData=value=>{stale(value);b.runtime.selection.clear();};
                  b.nativeFrameImport=stale;
                }""")
                page.evaluate("""async () => {
                  const b=miroBrowser,s=b.session;
                  for(let drag=1;drag<=2;drag++){
                    const frame=b.root.querySelector('.miro-canvas-mixed-selection-frame');
                    if(!frame)throw Error('Native selection frame vanished after first move');
                    const r=frame.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,id=100+drag;
                    frame.dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:id,clientX:x,clientY:y,bubbles:true,cancelable:true}));
                    window.dispatchEvent(new PointerEvent('pointermove',{pointerId:id,clientX:x+25,clientY:y+15}));
                    window.dispatchEvent(new PointerEvent('pointerup',{pointerId:id,clientX:x+25,clientY:y+15}));
                    await Promise.resolve();
                    const ids=s.selectedIds;
                    if(!ids.includes('n1')||!ids.includes('file'))throw Error('Marquee selection disappeared after move '+drag);
                  }
                  const n=b.runtime.getData().nodes.find(item=>item.id==='n1');
                  const old=b.nativeFrameBefore.nodes.find(item=>item.id==='n1');
                  if(n.x!==old.x+50||n.y!==old.y+30)throw Error('Native frame did not move twice');
                  b.runtime.importData=b.nativeFrameImport;b.select('n1');s.refresh();
                  const nativeBox=b.root.appendChild(document.createElement('div'));
                  nativeBox.className='canvas-selection';
                  const handles=b.root.querySelector('.miro-canvas-handles__frame');
                  if(!handles||handles.getAttribute('data-miro-canvas-turned')!=='false'
                    ||getComputedStyle(handles).outlineStyle!=='none')
                    throw Error('Unrotated node still has two selection outlines');
                  nativeBox.remove();
                }""")
                page.evaluate("""() => {
                  const b=miroBrowser,s=b.session,document=b.runtime.getData();
                  // A labelled native edge shows the plugin's label on the route the plugin
                  // draws, with native Canvas's own label hidden.
                  const ours=()=>b.root.querySelector('.miro-canvas-connector-label[data-connector-id="e1"]');
                  const native=b.runtime.edges.get('e1').labelEl;
                  if(!ours()||native.style.visibility!=='hidden')throw Error('Native edge label is not stood in for');
                  const top=()=>ours().getBoundingClientRect().top;
                  const firstTop=top();
                  const preview=s.previewReshape('e1',{kind:'insert',index:0,x:0,y:0},s.viewportPoint({x:370,y:300}));
                  if(!preview||Math.abs(top()-firstTop)<1)throw Error('First native edge body drag left the label behind');
                  s.connectorLabels.clearPreview('e1');
                  document.miroCanvas??={schemaVersion:1};document.miroCanvas.localOverrides??={};
                  document.miroCanvas.localOverrides.e1={connector:{route:'straight',waypoints:[{x:370,y:250}]}};
                  b.runtime.importData(document);s.refresh();
                  if(!ours()||b.runtime.edges.get('e1').labelEl.style.visibility!=='hidden')throw Error('Reshaped native edge still shows its stale label');
                  const oldTop=top();
                  document.miroCanvas.localOverrides.e1.connector.waypoints=[{x:370,y:300}];
                  b.runtime.importData(document);s.refresh();
                  if(Math.abs(top()-oldTop)<1)throw Error('Native edge label lagged behind body move');
                  const route=s.landingGeometry().geometry.edges.e1.points;
                  const originalTop=top(),zoom=2**b.runtime.zoom;
                  s.connectorLabels.preview('e1',route.map(p=>({x:p.x,y:p.y+22})));
                  s.followViewport();
                  if(Math.abs(top()-originalTop-22*zoom)>1)
                    throw Error('Viewport frame reverted a live route-label preview');
                  s.connectorLabels.clearPreview('e1');s.followViewport();
                  if(Math.abs(top()-originalTop)>1)
                    throw Error('Cancelled route-label preview did not restore position');
                  b.select('e1');
                  ours().dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true}));
                  const editor=ours().querySelector('.canvas-path-label');
                  if(editor.getAttribute('contenteditable')!=='true')throw Error('Reshaped native edge label cannot be edited');
                  editor.textContent='Edited edge';editor.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
                  if(b.runtime.getData().edges.find(e=>e.id==='e1').label!=='Edited edge')throw Error('Native edge label edit was not saved');
                  const r=ours().getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2;
                  ours().dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:459,clientX:x,clientY:y,bubbles:true,cancelable:true}));
                  window.dispatchEvent(new PointerEvent('pointermove',{pointerId:459,clientX:x+20,clientY:y+10}));
                  window.dispatchEvent(new PointerEvent('pointerup',{pointerId:459,clientX:x+20,clientY:y+10}));
                  const t=b.runtime.getData().miroCanvas.localOverrides.e1.connector.labelT;
                  if(typeof t!=='number'||t===0.5)throw Error('Native edge label cannot be moved along body: '+t);
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
                  const pasteAt={x:235,y:140}, screen=b.session.viewportPoint(pasteAt);
                  b.root.dispatchEvent(new PointerEvent('pointermove',{clientX:screen.x,clientY:screen.y,bubbles:true}));
                  const oldIds=new Set(b.runtime.nodes.keys());
                  b.root.dispatchEvent(new ClipboardEvent('paste', {clipboardData:clipboard, bubbles:true, cancelable:true}));
                  check(b.runtime.nodes.size === before + 2, 'Paste did not add nodes');
                  const pasted=b.runtime.getData().nodes.filter(n=>!oldIds.has(n.id));
                  const cx=(Math.min(...pasted.map(n=>n.x))+Math.max(...pasted.map(n=>n.x+n.width)))/2;
                  const cy=(Math.min(...pasted.map(n=>n.y))+Math.max(...pasted.map(n=>n.y+n.height)))/2;
                  check(Math.abs(cx-pasteAt.x)<1&&Math.abs(cy-pasteAt.y)<1,'Paste missed pointer position');
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
                  const dragSpec={kind:'arrow',route:'straight',endCap:'arrow',input:'drag'};
                  const at=b.session.viewportPoint({x:-280,y:-200});
                  const countBefore=Object.keys(b.runtime.getData().miroCanvas.connectors??{}).length;
                  const savesBeforeClick=b.getSaves();
                  b.session.startLine(dragSpec,new PointerEvent('pointerdown',{pointerId:120,button:0,clientX:at.x,clientY:at.y}));
                  window.dispatchEvent(new PointerEvent('pointerup',{pointerId:120,clientX:at.x+2,clientY:at.y+1}));
                  check(Object.keys(b.runtime.getData().miroCanvas.connectors??{}).length===countBefore,'Click created a connector');
                  check(b.getSaves()===savesBeforeClick,'Click wrote connector history');
                  b.session.startLine(dragSpec,new PointerEvent('pointerdown',{pointerId:121,button:0,clientX:at.x,clientY:at.y}));
                  window.dispatchEvent(new PointerEvent('pointermove',{pointerId:121,clientX:at.x+100,clientY:at.y+30}));
                  window.dispatchEvent(new PointerEvent('pointerup',{pointerId:121,clientX:at.x+100,clientY:at.y+30}));
                  check(Object.keys(b.runtime.getData().miroCanvas.connectors??{}).length===countBefore+1,'Drag failed to create connector');
                  b.runtime.undo();b.session.refresh();
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
                  // Native Canvas selects the card it starts to drag.
                  b.select('n1');
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
                  check(b.session.writeBoardConnectors([{id:'chain-bound',from:{type:'edge',edgeId:'live-bound',t:0.5},
                    to:{type:'free',x:750,y:310},route:'straight',color:'#6688aa',width:2,startCap:'none',endCap:'arrow'}]),
                    'Dependent connector could not be created');
                  b.session.resetTools(); b.select('n1'); b.session.connectorLayer.select([id]); b.root.focus();
                  const beforeMixed=b.runtime.getData(), savesBeforeMixed=b.getSaves();
                  const attachedBefore=b.root.querySelector('[data-connector-id="live-bound"]').getAttribute('d');
                  const chainBefore=b.root.querySelector('[data-connector-id="chain-bound"]').getAttribute('d');
                  b.root.querySelector('[data-connector-id="'+id+'"]').dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:94,clientX:500,clientY:400,bubbles:true}));
                  window.dispatchEvent(new PointerEvent('pointermove',{pointerId:94,clientX:560,clientY:420,bubbles:true}));
                  check(b.getSaves()===savesBeforeMixed,'Mixed drag preview wrote history');
                  check(b.node.nodeEl.style.translate==='60px 20px','Mixed drag did not preview node movement');
                  check(b.root.querySelector('[data-connector-id="live-bound"]').getAttribute('d')!==attachedBefore,
                    'Unselected arrow attached to a moving node lagged during group drag');
                  check(b.root.querySelector('[data-connector-id="chain-bound"]').getAttribute('d')!==chainBefore,
                    'Connector-to-connector chain lagged during group drag');
                  window.dispatchEvent(new PointerEvent('pointerup',{pointerId:94,clientX:560,clientY:420,bubbles:true}));
                  check(b.runtime.getData().nodes.find(n=>n.id==='n1').x===beforeMixed.nodes.find(n=>n.id==='n1').x+60,'Mixed drag did not move node');
                  check(b.runtime.getData().miroCanvas.connectors[id].from.x===beforeMixed.miroCanvas.connectors[id].from.x+60,'Mixed drag did not move connector');
                  b.runtime.undo(); b.session.refresh();
                  check(JSON.stringify(b.runtime.getData())===JSON.stringify(beforeMixed),'Mixed drag undo was not atomic');
                  b.runtime.setViewport(0,0,1);b.session.refresh();
                  b.select('n1');b.session.connectorLayer.select([id]);
                  const zoomBefore=b.runtime.getData(),zoomPath=b.root.querySelector('[data-connector-id="live-bound"]').getAttribute('d');
                  const zoomSaves=b.getSaves();
                  b.root.querySelector('[data-connector-id="'+id+'"]').dispatchEvent(new PointerEvent('pointerdown',
                    {button:0,pointerId:99,clientX:500,clientY:400,bubbles:true}));
                  window.dispatchEvent(new PointerEvent('pointermove',{pointerId:99,clientX:560,clientY:420,bubbles:true}));
                  check(b.root.querySelector('[data-connector-id="live-bound"]').getAttribute('d')!==zoomPath,
                    'Attached arrow lagged at non-default zoom');
                  check(b.getSaves()===zoomSaves,'Zoomed group preview saved before release');
                  window.dispatchEvent(new PointerEvent('pointercancel',{pointerId:99,bubbles:true}));
                  check(JSON.stringify(b.runtime.getData())===JSON.stringify(zoomBefore),'Cancelled zoomed group drag changed data');
                  check(b.root.querySelector('[data-connector-id="live-bound"]').getAttribute('d')===zoomPath,
                    'Cancelled zoomed group drag left arrow displaced');
                  b.runtime.setViewport(0,0,0);b.session.refresh();
                  b.session.resetTools();b.select('file','image');
                  const attachmentFrame=b.root.querySelector('.miro-canvas-mixed-selection-frame');
                  check(!!attachmentFrame,'Attachment group has no shared frame');
                  const attachmentPath=b.root.querySelector('[data-connector-id="live-bound"]').getAttribute('d');
                  const attachmentBox=attachmentFrame.getBoundingClientRect(),px=attachmentBox.left+attachmentBox.width/2,py=attachmentBox.top+attachmentBox.height/2;
                  attachmentFrame.dispatchEvent(new PointerEvent('pointerdown',
                    {button:0,pointerId:108,clientX:px,clientY:py,bubbles:true,cancelable:true}));
                  window.dispatchEvent(new PointerEvent('pointermove',{pointerId:108,clientX:px+45,clientY:py+20,bubbles:true}));
                  check(b.root.querySelector('[data-connector-id="live-bound"]').getAttribute('d')!==attachmentPath,
                    'Arrow lagged behind a grouped file/image attachment');
                  window.dispatchEvent(new PointerEvent('pointercancel',{pointerId:108,bubbles:true}));
                  check(b.root.querySelector('[data-connector-id="live-bound"]').getAttribute('d')===attachmentPath,
                    'Cancelling attachment drag left its arrow displaced');
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
                  b.session.refresh();
                  const frame=b.root.querySelector('.miro-canvas-mixed-selection-frame');
                  check(!!frame,'Lassoed nodes and connectors have no common frame');
                  const bounds=frame.getBoundingClientRect(),route=b.session.landingGeometry().geometry.edges[id];
                  for(const point of [route.start,route.end]){
                    const at=b.session.viewportPoint(point);
                    check(at.x>=bounds.left&&at.x<=bounds.right&&at.y>=bounds.top&&at.y<=bounds.bottom,
                      'Lasso frame excludes a selected connector');
                  }
                  const lassoBefore=b.runtime.getData(),lassoSaves=b.getSaves();
                  const move={pointerId:96,clientX:bounds.left+bounds.width/2,clientY:bounds.top+bounds.height/2,bubbles:true,cancelable:true};
                  if(getComputedStyle(frame).pointerEvents!=='auto')throw Error('Lasso frame interior cannot be grabbed');
                  frame.dispatchEvent(new PointerEvent('pointerdown',{...move,button:0}));
                  window.dispatchEvent(new PointerEvent('pointermove',{...move,clientX:move.clientX+40,clientY:move.clientY+20}));
                  window.dispatchEvent(new PointerEvent('pointerup',{...move,clientX:move.clientX+40,clientY:move.clientY+20}));
                  const lassoAfter=b.runtime.getData();
                  check(lassoAfter.nodes.find(n=>n.id==='n1').x===lassoBefore.nodes.find(n=>n.id==='n1').x+40,
                    'Lasso frame did not move its node');
                  check(lassoAfter.miroCanvas.connectors[id].from.x===lassoBefore.miroCanvas.connectors[id].from.x+40,
                    'Lasso frame did not move its connector');
                  check(b.getSaves()===lassoSaves+1,'Lasso frame moved in multiple history steps');
                  check(b.session.selectedIds.includes('n1')&&b.session.selectedIds.includes(id),'Lasso selection disappeared after moving');
                  const nextFrame=b.root.querySelector('.miro-canvas-mixed-selection-frame');
                  check(!!nextFrame,'Lasso frame vanished after moving');
                  const nextBounds=nextFrame.getBoundingClientRect();
                  const again={pointerId:97,clientX:nextBounds.left+nextBounds.width/2,clientY:nextBounds.top+nextBounds.height/2,bubbles:true,cancelable:true};
                  nextFrame.dispatchEvent(new PointerEvent('pointerdown',{...again,button:0}));
                  window.dispatchEvent(new PointerEvent('pointermove',{...again,clientX:again.clientX+30,clientY:again.clientY+10}));
                  window.dispatchEvent(new PointerEvent('pointerup',{...again,clientX:again.clientX+30,clientY:again.clientY+10}));
                  check(b.session.selectedIds.includes('n1')&&b.session.selectedIds.includes(id),'Repeated lasso frame drag lost selection');
                  check(b.runtime.getData().nodes.find(n=>n.id==='n1').x===lassoBefore.nodes.find(n=>n.id==='n1').x+70,
                    'Lasso frame could not move its contents twice');
                  check(b.getSaves()===lassoSaves+2,'Repeated lasso drag did not make a separate history step');
                  b.runtime.undo();b.session.refresh();
                  check(b.runtime.getData().nodes.find(n=>n.id==='n1').x===lassoAfter.nodes.find(n=>n.id==='n1').x,
                    'Repeated lasso drag undo did not restore first move');
                  b.runtime.undo();b.session.refresh();
                  check(JSON.stringify(b.runtime.getData())===JSON.stringify(lassoBefore),'Lasso frame undo lost items');
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
