/**
 * Draws the connectors a board keeps of its own - those with an end native
 * Canvas cannot hold - on the board itself.
 *
 * The layer is one SVG inside native Canvas's moving layer, in board units,
 * so it pans and zooms with everything else for nothing.  A connector is
 * drawn again only when it, its route or its selection changes; a card
 * dragged on a large board redraws the few lines that hold on to it.  It wears
 * native Canvas's own edge classes, so a line held by nothing is grabbed,
 * hovered and selected exactly as an edge between cards is.
 *
 * It only draws and says what was pressed.  Grips, the toolbar, labels and
 * the clipboard are the ones native edges use; the session serves both.
 */

import type { AnchorGeometry, AnchorPoint } from "./anchors";
import { boardConnectors, connectorEndCap, connectorRoutes, type BoardConnector } from "./board-connectors";
import type { PlannedRoute } from "./connector-route";
import { CAP_PATHS, capFilled, headMarkerAttributes, strokeDash } from "./connector-style";
import { blockArrowOutline } from "./free-line";

const SVG = "http://www.w3.org/2000/svg";
/** Arrowheads are drawn at the size native Canvas draws its own. */
const CAP_SCALE = 0.6;

export interface ConnectorLayerHost {
  readonly document: () => unknown;
  readonly geometry: () => AnchorGeometry;
  /** A press landed on a connector's course. */
  readonly press: (event: PointerEvent, id: string) => void;
  /** The selection was set: everything that shows it follows. */
  readonly selected?: () => void;
}

export class ConnectorLayer {
  public readonly element: SVGSVGElement;
  private readonly selected = new Set<string>();
  private previewed: BoardConnector | undefined;
  private routes = new Map<string, PlannedRoute>();
  /** Each connector drawn, and what it was drawn from. */
  private readonly drawn = new Map<string, { readonly group: SVGGElement; readonly signature: string }>();
  /** What the layer was last drawn from; the same again draws nothing. */
  private painted: { readonly document: unknown; readonly geometry: AnchorGeometry; readonly selection: string } | undefined;
  private readonly listeners: (() => void)[] = [];

  public constructor(private readonly document: Document, private readonly host: ConnectorLayerHost) {
    this.element = document.createElementNS(SVG, "svg");
    this.element.setAttribute("class", "canvas-edges miro-board-connectors");
    // As native Canvas's edge style has it, should a page lack that style:
    // only a line takes presses, never the layer around it.
    this.element.setAttribute("pointer-events", "none");
    const press = (event: Event): void => {
      const id = (event.target as Element | null)?.closest?.("[data-connector-id]")?.getAttribute("data-connector-id");
      if (typeof id === "string") this.host.press(event as PointerEvent, id);
    };
    this.element.addEventListener("pointerdown", press);
    this.listeners.push(() => this.element.removeEventListener("pointerdown", press));
  }

  /** The connectors selected now, which native Canvas knows nothing of. */
  public selection(): readonly string[] {
    return [...this.selected];
  }

  public select(ids: readonly string[]): void {
    this.selected.clear();
    for (const id of ids) this.selected.add(id);
    this.render();
    this.host.selected?.();
  }

  public reset(): void {
    this.previewed = undefined;
    this.select([]);
  }

  /** Draw a connector being dragged where it is going, in place of where it is; nothing puts it back. */
  public preview(connector: BoardConnector | undefined): void {
    this.previewed = connector;
    this.render(true);
  }

  /** The route a connector was last drawn along. */
  public routeOf(id: string): PlannedRoute | undefined {
    return this.routes.get(id);
  }

  /** Draw the connectors, unless nothing they are drawn from has changed. */
  public render(force = false): void {
    const document = this.host.document(), geometry = this.host.geometry();
    const connectors = boardConnectors(document).map((connector) => (this.previewed?.id === connector.id ? this.previewed : connector));
    for (const id of this.selected) if (!connectors.some((connector) => connector.id === id)) this.selected.delete(id);
    const selection = [...this.selected].sort().join("\u0000");
    const painted = this.painted;
    if (!force && this.previewed === undefined && painted !== undefined
      && painted.document === document && painted.geometry === geometry && painted.selection === selection) return;
    this.routes = new Map();
    for (const connector of connectors) {
      // The anchoring geometry has planned every route already; only one
      // being dragged is planned here, where it is going.
      const route = connector === this.previewed
        ? connectorRoutes([connector], geometry).get(connector.id)
        : plannedRoute(geometry.edges?.[connector.id]);
      if (route !== undefined) this.routes.set(connector.id, route);
    }
    const svg = this.element;
    const kept = new Set<string>();
    for (const connector of connectors) {
      const route = this.routes.get(connector.id);
      if (route === undefined) continue;
      kept.add(connector.id);
      const signature = `${route.path}|${this.selected.has(connector.id)}|${JSON.stringify(connector)}`;
      const known = this.drawn.get(connector.id);
      if (known?.signature === signature) continue;
      const group = this.draw(connector, route);
      if (known === undefined) svg.appendChild(group);
      else svg.replaceChild(group, known.group);
      this.drawn.set(connector.id, { group, signature });
    }
    for (const [id, known] of this.drawn) {
      if (kept.has(id)) continue;
      svg.removeChild(known.group);
      this.drawn.delete(id);
    }
    this.painted = this.previewed === undefined ? { document, geometry, selection } : undefined;
  }

  public dispose(): void {
    for (const remove of this.listeners.splice(0)) remove();
    this.element.remove();
  }

  /** One connector: its course, as native Canvas draws an edge's, and the wider copy that takes presses. */
  private draw(connector: BoardConnector, route: PlannedRoute): SVGGElement {
    const group = this.document.createElementNS(SVG, "g");
    // Its arrowheads go with it, and are drawn again with it.
    const defs = group.appendChild(this.document.createElementNS(SVG, "defs"));
    group.setAttribute("class", `miro-board-connector${this.selected.has(connector.id) ? " is-focused" : ""}`);
    group.style.setProperty("--canvas-color", connector.color);
    const course = route.path;
    const line = group.appendChild(this.document.createElementNS(SVG, "path"));
    line.setAttribute("class", "canvas-display-path");
    // The wider, invisible copy on top takes the presses, and says whose they are.
    const hit = group.appendChild(this.document.createElementNS(SVG, "path"));
    hit.setAttribute("class", "canvas-interaction-path miro-board-connector-hit");
    hit.setAttribute("data-connector-id", connector.id);
    hit.setAttribute("d", course);
    // What native Canvas's edge style sets, for a page without it; its rules win.
    hit.setAttribute("fill", "none");
    hit.setAttribute("stroke", "transparent");
    hit.setAttribute("stroke-width", "24");
    hit.setAttribute("pointer-events", "stroke");
    // Inline, as the renderer paints a native edge: the width is the
    // connector's own, in board units, not native Canvas's hairline.
    const style: Record<string, string> = connector.block === true
      ? { d: blockOutline(connector, route), fill: connector.color, stroke: connector.color, "stroke-width": "1", "stroke-linejoin": "round" }
      : {
        d: course, fill: "none", stroke: connector.color, "stroke-width": String(connector.width),
        "stroke-dasharray": strokeDash(connector.strokeStyle),
        "stroke-linecap": connector.strokeStyle === "dotted" ? "round" : "butt",
        ...this.caps(connector, defs),
      };
    for (const [name, value] of Object.entries(style)) {
      // Markers are references, set as attributes; the rest outranks native Canvas's rules.
      if (name === "d" || name.startsWith("marker-")) line.setAttribute(name, value);
      else line.style.setProperty(name, value);
    }
    return group;
  }

  /** Markers for a connector's two ends, sized as native Canvas sizes its own. */
  private caps(connector: BoardConnector, defs: SVGDefsElement): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [end, cap] of [["start", connector.startCap], ["end", connectorEndCap(connector)]] as const) {
      const path = CAP_PATHS[cap];
      if (path === undefined) continue;
      const id = `miro-board-cap-${connector.id}-${end}`;
      const marker = defs.appendChild(this.document.createElementNS(SVG, "marker"));
      for (const [name, value] of Object.entries({
        id, viewBox: "-16 -8 18 16", refX: "0", refY: "0",
        markerWidth: String(18 * CAP_SCALE), markerHeight: String(16 * CAP_SCALE), orient: "auto-start-reverse",
        ...headMarkerAttributes(connector.headSize),
      })) marker.setAttribute(name, value);
      const glyph = marker.appendChild(this.document.createElementNS(SVG, "path"));
      glyph.setAttribute("d", path);
      glyph.setAttribute("fill", capFilled(cap) ? connector.color : "none");
      glyph.setAttribute("stroke", connector.color);
      glyph.setAttribute("stroke-linejoin", "round");
      result[`marker-${end}`] = `url(#${id})`;
    }
    return result;
  }
}

function plannedRoute(value: unknown): PlannedRoute | undefined {
  const route = value as Partial<PlannedRoute> | undefined;
  return typeof route?.path === "string" && Array.isArray(route.segments) ? route as PlannedRoute : undefined;
}

/** A block arrow's outline, from its tail to its one head, as an SVG path. */
function blockOutline(connector: BoardConnector, route: PlannedRoute): string {
  const reverse = connector.startCap !== "none" && connectorEndCap(connector) === "none";
  const tail: AnchorPoint = reverse ? route.end : route.start, tip: AnchorPoint = reverse ? route.start : route.end;
  return blockArrowOutline(tail, tip, connector.width, connector.headSize)
    .map((point, index) => `${index === 0 ? "M" : "L"} ${Math.round(point.x * 100) / 100} ${Math.round(point.y * 100) / 100}`)
    .join(" ") + " Z";
}
