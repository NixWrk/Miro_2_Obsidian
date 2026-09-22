import { type CanvasAnchor, type AnchorGeometry, type AnchorPoint } from "./anchors";
import { boardConnectors, connectorRoutes, readBoardConnector, translateConnector, type BoardConnector } from "./board-connectors";
import { CAP_PATHS, capFilled, strokeDash } from "./connector-style";
import { routePath } from "./connector-route";
import { blockArrowOutline } from "./free-line";

interface Host {
  document(): unknown;
  geometry(): AnchorGeometry;
  screen(p: AnchorPoint): AnchorPoint;
  board(p: AnchorPoint): AnchorPoint | undefined;
  landing(p: AnchorPoint, id: string): CanvasAnchor | undefined;
  editable(ids: string[]): boolean;
  write(items: BoardConnector[], remove?: string[], expected?: BoardConnector): boolean;
  deselectNative(): void;
  id(): string;
  clipboard(action:"copy"|"cut"|"paste"):void;
  removeSelection(): void;
  moveSelection(event: PointerEvent): boolean;
  selectionChanged(): void;
}
const NS = "http://www.w3.org/2000/svg";
const MIME = "application/x-miro-board-connectors";
/** Screen-space overlay; no fake Canvas nodes, and no native graph mutation while rendering. */
export class ConnectorLayer {
  private svg: SVGSVGElement;
  private toolbar: HTMLDivElement;
  private selected = new Set<string>();
  private dragEnd?: () => void;
  private disposed = false;
  private preview?: BoardConnector;
  private cleanups: (() => void)[] = [];
  constructor(private root: HTMLElement, private host: Host) {
    const doc = root.ownerDocument;
    this.svg = doc.createElementNS(NS, "svg");
    this.svg.classList.add("miro-board-connectors");
    this.toolbar = doc.createElement("div"); this.toolbar.className = "miro-canvas-toolbar miro-board-connector-tools";
    this.root.append(this.svg, this.toolbar);
    const listen = (type: string, handler: EventListener) => {
      root.addEventListener(type, handler, true); this.cleanups.push(() => root.removeEventListener(type, handler, true));
    };
    listen("pointerdown", event => {
      if(!(event as PointerEvent).shiftKey && (event.target as Element)?.closest?.(".canvas-node") && this.selected.size && this.host.moveSelection(event as PointerEvent))return;
      if ((event as PointerEvent).button===0 && !(event as PointerEvent).shiftKey && !this.svg.contains(event.target as Node) && !(event.target as Element)?.closest?.(".miro-canvas-toolbar,.miro-canvas-tools,.miro-canvas-comment-markers")) { this.selected.clear(); this.render();this.host.selectionChanged(); }
    });
    listen("keydown", event => {
      const key = event as KeyboardEvent;
      if (!this.selected.size || (event.target as Element)?.closest?.("input,textarea,[contenteditable=true],.cm-editor")) return;
      if (key.key === "Delete" || key.key === "Backspace") {
        key.preventDefault(); key.stopImmediatePropagation(); this.remove();
      }
    });
    listen("copy", event => this.copy(event as ClipboardEvent));
    listen("cut", event => this.copy(event as ClipboardEvent));
    listen("paste", event => this.paste(event as ClipboardEvent));
  }
  private copy(event: ClipboardEvent): void {
    if ((event.target as Element)?.closest?.("input,textarea,[contenteditable=true],.cm-editor")) return;
    if (!this.selected.size || !event.clipboardData) return;
    if (event.type === "cut" && !this.host.editable([...this.selected])) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    const all = boardConnectors(this.host.document()), routes = connectorRoutes(all, this.host.geometry());
    const items = all.filter(c => this.selected.has(c.id)).map(c => {
      const route = routes.get(c.id);
      const end = (a: CanvasAnchor, p: AnchorPoint | undefined): CanvasAnchor => a.type === "edge" && this.selected.has(a.edgeId) ? a : p ? {type:"free",x:p.x,y:p.y} : a;
      return {...c, from:end(c.from,route?.start), to:end(c.to,route?.end)};
    });
    const text = JSON.stringify({miroBoardConnectors:1,items});
    event.clipboardData.setData(MIME,text); event.clipboardData.setData("text/plain",text);
    event.preventDefault(); event.stopImmediatePropagation();
    if (event.type === "cut") this.remove();
  }
  private paste(event: ClipboardEvent): void {
    if (!event.clipboardData || (event.target as Element)?.closest?.("input,textarea,[contenteditable=true],.cm-editor")) return;
    try {
      const value = JSON.parse(event.clipboardData.getData(MIME) || event.clipboardData.getData("text/plain"));
      if (value?.miroBoardConnectors !== 1 || !Array.isArray(value.items) || value.items.length > 10000 || !value.items.every((c: unknown) => readBoardConnector(c))) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (!this.host.editable([])) return;
      const ids = new Map<string,string>(value.items.map((c:BoardConnector) => [c.id,this.host.id()]));
      const items = value.items.map((c:BoardConnector) => {
        const moved = translateConnector(c,40,40,ids.get(c.id)!);
        const end = (a:CanvasAnchor):CanvasAnchor => a.type === "edge" && ids.has(a.edgeId) ? {...a,edgeId:ids.get(a.edgeId)!} : a;
        return {...moved,from:end(moved.from),to:end(moved.to)};
      });
      if (this.host.write(items)) {this.host.deselectNative(); this.selected = new Set(ids.values()); this.render();}
    } catch { /* Not our clipboard. */ }
  }
  private remove(): void {
    this.host.removeSelection();
  }
  render(force = false): void {
    if (this.disposed || this.dragEnd && !force) return;
    const connectors = boardConnectors(this.host.document()).map(c=>this.preview?.id===c.id?this.preview:c);
    for (const id of this.selected) if (!connectors.some(c => c.id === id)) this.selected.delete(id);
    const routes = connectorRoutes(connectors, this.host.geometry());
    const doc = this.root.ownerDocument;
    this.svg.replaceChildren(); this.toolbar.replaceChildren(); this.toolbar.hidden = true;
    const defs = doc.createElementNS(NS,"defs"); this.svg.append(defs);
    for (const c of connectors) {
      const route = routes.get(c.id); if (!route) continue;
      const path = doc.createElementNS(NS,"path");
      path.setAttribute("d",routePath(route.start,route.segments,p=>this.host.screen(p)));
      const origin=this.host.screen({x:0,y:0}), unit=this.host.screen({x:1,y:0});
      const scale=Math.hypot(unit.x-origin.x,unit.y-origin.y);
      path.setAttribute("fill","none"); path.setAttribute("stroke",c.color); path.setAttribute("stroke-width",String(c.width*scale));
      path.setAttribute("stroke-dasharray",strokeDash(c.strokeStyle));
      if (c.block) {
        const reverse = c.startCap !== "none" && c.endCap === "none";
        const outline=blockArrowOutline(reverse ? route.end : route.start,reverse ? route.start : route.end,c.width).map(p=>this.host.screen(p));
        path.setAttribute("d",outline.map((p,i)=>`${i?"L":"M"}${p.x} ${p.y}`).join(" ")+" Z");
        path.setAttribute("fill",c.color); path.setAttribute("stroke-width","1");
      }
      for (const end of ["start","end"] as const) {
        if (c.block) continue;
        const cap = end === "start" ? c.startCap : c.endCap;
        if (!CAP_PATHS[cap]) continue;
        const marker = doc.createElementNS(NS,"marker"), glyph = doc.createElementNS(NS,"path");
        const id = `miro-cap-${this.host.id()}`;
        marker.setAttribute("id",id); marker.setAttribute("viewBox","-16 -8 18 16");
        marker.setAttribute("refX","0"); marker.setAttribute("refY","0"); marker.setAttribute("markerWidth","14"); marker.setAttribute("markerHeight","14"); marker.setAttribute("orient","auto-start-reverse");
        glyph.setAttribute("d",CAP_PATHS[cap]!); glyph.setAttribute("stroke",c.color); glyph.setAttribute("fill",capFilled(cap)?c.color:"none"); marker.append(glyph); defs.append(marker);
        path.setAttribute(`marker-${end}`,`url(#${id})`);
      }
      this.svg.append(path);
      const hit = path.cloneNode(false) as SVGPathElement;
      hit.removeAttribute("marker-start"); hit.removeAttribute("marker-end"); hit.setAttribute("fill",c.block ? "transparent" : "none"); hit.setAttribute("stroke","transparent"); hit.setAttribute("stroke-width",String(Math.max(14,c.width*scale+8))); hit.classList.add("miro-board-connector-hit");
      hit.setAttribute("aria-label",`Connector ${c.id}`); hit.setAttribute("data-connector-id",c.id);
      hit.addEventListener("pointerdown", e => {
        if (e.button !== 0) return;
        e.preventDefault(); e.stopImmediatePropagation();
        if (!e.shiftKey && !this.selected.has(c.id)) {this.host.deselectNative();this.selected.clear();}
        if(e.shiftKey && this.selected.has(c.id)){this.selected.delete(c.id);this.render();this.host.selectionChanged();return;}
        this.selected.add(c.id); this.root.focus(); this.render();this.host.selectionChanged();
        this.drag(e,c);
      });
      hit.addEventListener("contextmenu", e => {e.preventDefault(); e.stopPropagation(); this.selected = new Set([c.id]); this.root.focus(); this.render();this.host.selectionChanged();});
      this.svg.append(hit);
      if (this.selected.has(c.id)) for (const end of ["from","to"] as const) {
        const at = this.host.screen(end === "from" ? route.start : route.end);
        const grip = doc.createElementNS(NS,"circle"); grip.setAttribute("cx",String(at.x)); grip.setAttribute("cy",String(at.y)); grip.setAttribute("r","6"); grip.classList.add("miro-board-connector-grip"); grip.setAttribute("data-end",end);
        grip.addEventListener("pointerdown", e => { if(e.button!==0)return; e.preventDefault(); e.stopImmediatePropagation(); this.drag(e,c,end); }); this.svg.append(grip);
      }
    }
  }
  private drag(event:PointerEvent, c:BoardConnector, end?:"from"|"to"):void {
    if(!end && this.host.moveSelection(event))return;
    if (!this.host.editable([c.id])) return;
    const first=this.host.board({x:event.clientX,y:event.clientY}), view=this.root.ownerDocument.defaultView;
    if(!first || !view) return;
    let next=c, changed=false;
    const move=(e:PointerEvent)=>{
      if(e.pointerId!==event.pointerId) return;
      const at=this.host.board({x:e.clientX,y:e.clientY}); if(!at)return;
      changed ||= Math.hypot(e.clientX-event.clientX,e.clientY-event.clientY)>3;
      if(end) {const anchor=this.host.landing({x:e.clientX,y:e.clientY},c.id); next=anchor?{...c,[end]:anchor}:c;}
      else next=translateConnector(c,at.x-first.x,at.y-first.y);
      this.preview=next;this.render(true);
    };
    const cleanup=()=>{view.removeEventListener("pointermove",move,true); view.removeEventListener("pointerup",up,true); view.removeEventListener("pointercancel",cancel,true); view.removeEventListener("blur",cancel); this.dragEnd=undefined;this.preview=undefined;};
    const cancel=()=>{cleanup();this.render();};
    const up=(e:PointerEvent)=>{if(e.pointerId!==event.pointerId)return; move(e);cleanup();if(changed&&next!==c&&this.host.editable([c.id]))this.host.write([next],[],c);this.render();};
    view.addEventListener("pointermove",move,true);view.addEventListener("pointerup",up,true);view.addEventListener("pointercancel",cancel,true);view.addEventListener("blur",cancel);this.dragEnd=cancel;
  }
  dispose():void {this.disposed=true;this.dragEnd?.();this.cleanups.forEach(fn=>fn());this.svg.remove();this.toolbar.remove();}
  reset():void {this.dragEnd?.();this.selected.clear();this.render();}
  selection(): readonly string[] {return [...this.selected];}
  select(ids: readonly string[]): void {this.selected=new Set(ids);this.render();this.host.selectionChanged();}
}
