/**
 * Floating, selection-scoped formatting toolbar.
 *
 * The native Canvas remains the editor.  This module only builds detached DOM
 * and reports explicit user actions to its host.  Typography and colors reuse
 * the appearance pipeline; shape, border and connector settings are reported
 * separately because only `CanvasAuthoring` can write them.  The toolbar owns
 * no geometry: the host supplies an already-resolved viewport placement.
 *
 * The layout follows Miro's logic in Obsidian's own look: one compact row of
 * small pictures, each opening a popover of further pictures, with the words
 * kept for hover hints.  A node and a connector get different rows, and a
 * control that does not apply to the selection is removed rather than shown
 * disabled.  Interface icons come from Obsidian through the host's `setIcon`;
 * shapes, line ends and line kinds are drawn here, because no icon set has
 * them.
 */

import {
  APPEARANCE_ACTIONS,
  type AppearanceAction,
  type ColorSlot,
  type PaletteColor,
  type TextAlignment,
  type TypographySettings,
  type VerticalAlign,
} from "./appearance";
import {
  CAP_LABELS,
  CAP_PATHS,
  ROUTE_ICON_PATHS,
  ROUTE_LABELS,
  STROKE_LABELS,
  capFilled,
  capReach,
  strokeDash,
  type ConnectorCap,
  type ConnectorRoute,
  type ConnectorStroke,
} from "./connector-style";
import {
  SHAPE_CATALOG,
  shapeCatalogEntry,
  shapeCatalogLabel,
  type ShapeCatalogEntry,
  type ShapeKind,
  type ShapeSection,
} from "./shape-catalog";
import { shapePath } from "./shape-geometry";
import {
  CONNECTOR_CAPS,
  CONNECTOR_ROUTES,
  CONNECTOR_STROKES,
  type LocalConnectorSettings,
} from "./source-model";

export type SelectionKind = "shape" | "text" | "sticky" | "edge" | "frame" | "media";
export type BorderStyle = "solid" | "dashed" | "dotted" | "none";
export type { ShapeKind };

/** Viewport pixels for the top-center of the selection, resolved by the host. */
export interface SelectionToolbarPlacement {
  readonly x: number;
  readonly y: number;
}

export interface SelectionToolbarStyle {
  readonly shape?: ShapeKind;
  readonly borderStyle?: BorderStyle;
  readonly borderWidth?: number;
  readonly connector?: LocalConnectorSettings;
}

export interface SelectionToolbarState extends SelectionToolbarStyle {
  readonly selectedIds: readonly string[];
  readonly kinds: readonly SelectionKind[];
  /** False in review mode or on a locked selection; the lock toggle stays live. */
  readonly editable: boolean;
  readonly locked: boolean;
  readonly reviewMode: boolean;
  readonly blockedReason?: string;
  readonly typography: TypographySettings;
  readonly colors: Readonly<Partial<Record<ColorSlot, string | null>>>;
  readonly palette: readonly PaletteColor[];
  /** Replaces the palette for the fill colour, as Miro does for a sticky note. */
  readonly fillPalette?: readonly PaletteColor[];
  readonly recentColors: readonly string[];
  readonly placement?: SelectionToolbarPlacement;
  /** The web address a single selected link opens; it shows the open button. */
  readonly link?: string;
}

/** A style patch never carries the target id: the host owns the selection. */
export type SelectionStylePatch = SelectionToolbarStyle;

export interface SelectionToolbarActions {
  readonly onAppearance: (action: AppearanceAction) => void;
  readonly onStyle: (patch: SelectionStylePatch) => void;
  readonly onLock: (locked: boolean) => void;
  /** Opens the selected link outside the board. */
  readonly onOpenLink?: () => void;
}

export interface SelectionToolbarOptions {
  readonly document?: Document;
  readonly className?: string;
  readonly title?: string;
  /** Draws a named Obsidian icon into an element; without it buttons fall back to glyphs. */
  readonly setIcon?: (element: HTMLElement, icon: string) => void;
}

const MIN_FONT_SIZE = 6;
const MAX_FONT_SIZE = 256;
const MAX_BORDER_WIDTH = 100;
/** The border and line sliders cover the widths people pick. */
const BORDER_SLIDER_MAX = 20;
const LINE_SLIDER_MAX = 24;
const FONT_FAMILIES = [
  "Open Sans", "Inter", "Roboto", "Noto Sans", "Arial", "Georgia",
  "Times New Roman", "Courier New", "system-ui", "sans-serif",
] as const;
const ALIGNMENTS: readonly { readonly value: TextAlignment; readonly icon: string; readonly label: string }[] = [
  { value: "left", icon: "align-left", label: "Align left" },
  { value: "center", icon: "align-center", label: "Align center" },
  { value: "right", icon: "align-right", label: "Align right" },
  { value: "justify", icon: "align-justify", label: "Justify" },
];
const VERTICAL_ALIGNMENTS: readonly { readonly value: VerticalAlign; readonly icon: string; readonly label: string }[] = [
  { value: "top", icon: "align-vertical-justify-start", label: "Align top" },
  { value: "center", icon: "align-vertical-justify-center", label: "Align middle" },
  { value: "bottom", icon: "align-vertical-justify-end", label: "Align bottom" },
];
const FORMATS: readonly {
  readonly format: "bold" | "italic" | "underline" | "strike";
  readonly icon: string;
  readonly glyph: string;
  readonly label: string;
}[] = [
  { format: "bold", icon: "bold", glyph: "B", label: "Bold" },
  { format: "italic", icon: "italic", glyph: "I", label: "Italic" },
  { format: "underline", icon: "underline", glyph: "U", label: "Underline" },
  { format: "strike", icon: "strikethrough", glyph: "S", label: "Strikethrough" },
];
const BORDER_STYLES: readonly { readonly value: BorderStyle; readonly label: string }[] = [
  { value: "solid", label: "Solid border" },
  { value: "dashed", label: "Dashed border" },
  { value: "dotted", label: "Dotted border" },
  { value: "none", label: "No border" },
];
const SHAPE_SECTIONS: readonly { readonly section: ShapeSection; readonly title: string }[] = [
  { section: "basic", title: "Basic" },
  { section: "flowchart", title: "Flowchart" },
];
/** Hover text for a picture should not make a person wait a second for it. */
const PICTURE_TOOLTIP_DELAY = "150";
const BUTTON_TOOLTIP_DELAY = "400";
const SVG_NS = "http://www.w3.org/2000/svg";

/** Colour popovers: which appearance slot each one writes and how its button looks. */
const COLOR_SLOTS: readonly {
  readonly slot: ColorSlot;
  readonly label: string;
  readonly valueLabel: string;
  readonly look: "text" | "fill" | "ring";
  readonly forEdge: boolean;
}[] = [
  { slot: "text", label: "Text color", valueLabel: "Text color", look: "text", forEdge: false },
  { slot: "fill", label: "Fill color", valueLabel: "Fill color", look: "fill", forEdge: false },
  { slot: "border", label: "Border", valueLabel: "Border color", look: "ring", forEdge: false },
  { slot: "edge", label: "Line color", valueLabel: "Line color", look: "fill", forEdge: true },
];
/** Transparent text or a transparent line only hides the element; a fill or a border may go. */
const TRANSPARENT_SLOTS: ReadonlySet<ColorSlot> = new Set<ColorSlot>(["fill", "border"]);

function hasDocument(value: unknown): value is Document {
  return value !== null && typeof value === "object"
    && typeof (value as { createElement?: unknown }).createElement === "function";
}

function append<T extends Node>(parent: Node, child: T): T {
  parent.appendChild(child);
  return child;
}

function make<K extends keyof HTMLElementTagNameMap>(
  document: Document, tag: K, className?: string, label?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className !== undefined) element.className = className;
  if (label !== undefined) element.textContent = label;
  return element;
}

/**
 * Only `aria-label` is set: Obsidian renders its own tooltip from it, so a
 * `title` on the same element would show a second, native tooltip beside it.
 */
function makeButton(document: Document, title: string, className = ""): HTMLButtonElement {
  const button = make(document, "button", `miro-canvas-toolbar__button ${className}`.trim());
  button.type = "button";
  button.setAttribute("aria-label", title);
  button.setAttribute("data-tooltip-delay", BUTTON_TOOLTIP_DELAY);
  return button;
}

/** One choice among several: it carries its value and shows whether it is the current one. */
function makeChoice(document: Document, title: string, value: string, className = ""): HTMLButtonElement {
  const button = makeButton(document, title, className);
  button.setAttribute("data-value", value);
  button.setAttribute("aria-pressed", "false");
  return button;
}

function makeNumber(
  document: Document, title: string, min: number, max: number, className = "",
): HTMLInputElement {
  const input = make(document, "input", `miro-canvas-toolbar__number ${className}`.trim());
  input.type = "number";
  input.min = String(min);
  input.max = String(max);
  input.step = "1";
  input.setAttribute("aria-label", title);
  return input;
}

function makeRange(document: Document, title: string, min: number, max: number): HTMLInputElement {
  const input = make(document, "input", "miro-canvas-toolbar__range");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = "1";
  input.setAttribute("aria-label", title);
  return input;
}

function normalizedHex(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/u.test(text)) return text;
  if (/^#[0-9a-f]{3}$/u.test(text)) return `#${text[1]!}${text[1]!}${text[2]!}${text[2]!}${text[3]!}${text[3]!}`;
  return undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function empty(element: Element): void {
  while (element.firstChild !== null) element.removeChild(element.firstChild);
}

/** Press the one choice carrying `value` and release the rest. */
function pressWhere(options: readonly HTMLElement[], value: string): void {
  for (const option of options) {
    option.setAttribute("aria-pressed", option.getAttribute("data-value") === value ? "true" : "false");
  }
}

/** A small drawing, or undefined where the document cannot draw SVG. */
function makeSvg(document: Document, className: string, viewBox: string): SVGSVGElement | undefined {
  if (typeof document.createElementNS !== "function") return undefined;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", viewBox);
  svg.setAttribute("aria-hidden", "true");
  return svg;
}

function addPath(document: Document, svg: SVGSVGElement, d: string, attributes: Readonly<Record<string, string>> = {}): void {
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  for (const [key, value] of Object.entries(attributes)) path.setAttribute(key, value);
  svg.appendChild(path);
}

/** An outline picture of a catalogue entry. */
export function shapePicture(document: Document, item: ShapeCatalogEntry): SVGSVGElement | undefined {
  const d = shapePath(item.kind);
  if (d === undefined) return undefined;
  // Some outlines bulge a little past the 0..100 box, as a cloud does.
  const svg = makeSvg(document, `miro-canvas-shape-icon miro-canvas-shape-icon--${item.aspect}`, "-10 -10 120 120");
  if (svg === undefined) return undefined;
  svg.setAttribute("preserveAspectRatio", "none");
  addPath(document, svg, d, { "vector-effect": "non-scaling-stroke" });
  return svg;
}

/** A short line ending in a cap, drawn at the right end or, for a start, at the left. */
function capPicture(document: Document, cap: string, at: "start" | "end"): SVGSVGElement | undefined {
  const svg = makeSvg(document, "miro-canvas-line-icon", "0 0 32 16");
  if (svg === undefined) return undefined;
  const tip = at === "end" ? 28 : 4;
  const back = capReach(cap) * 0.9;
  addPath(document, svg, at === "end" ? `M4 8H${tip - back}` : `M${tip + back} 8H28`);
  const d = CAP_PATHS[cap];
  if (d !== undefined) {
    addPath(document, svg, d, {
      transform: `translate(${tip} 8) scale(${at === "end" ? 0.9 : -0.9} 0.9)`,
      class: capFilled(cap) ? "is-filled" : "is-outline",
      "vector-effect": "non-scaling-stroke",
    });
  }
  return svg;
}

function routePicture(document: Document, route: ConnectorRoute): SVGSVGElement | undefined {
  const svg = makeSvg(document, "miro-canvas-line-icon miro-canvas-line-icon--square", "0 0 24 24");
  if (svg !== undefined) addPath(document, svg, ROUTE_ICON_PATHS[route]);
  return svg;
}

function strokePicture(document: Document, stroke: ConnectorStroke): SVGSVGElement | undefined {
  const svg = makeSvg(document, "miro-canvas-line-icon", "0 0 32 16");
  if (svg !== undefined) {
    addPath(document, svg, "M3 8H29", { "stroke-dasharray": stroke === "dotted" ? "0.5 4" : strokeDash(stroke) });
  }
  return svg;
}

function borderPicture(document: Document, style: BorderStyle): SVGSVGElement | undefined {
  const svg = makeSvg(document, "miro-canvas-line-icon miro-canvas-line-icon--square", "0 0 24 24");
  if (svg === undefined) return undefined;
  if (style === "none") {
    addPath(document, svg, "M5 5H19V19H5Z", { class: "is-faint", "stroke-dasharray": "2 3" });
    addPath(document, svg, "M4 20L20 4");
    return svg;
  }
  addPath(document, svg, "M5 5H19V19H5Z", {
    "stroke-dasharray": style === "dotted" ? "0.5 3.5" : style === "dashed" ? "4 3" : "none",
  });
  return svg;
}

/** Put one drawing in a button, replacing what it showed; without a drawing the glyph stays. */
function showPicture(button: HTMLElement, key: string, picture: () => Element | undefined, glyph: string): void {
  if (button.getAttribute("data-picture") === key) return;
  button.setAttribute("data-picture", key);
  empty(button);
  const drawn = picture();
  if (drawn === undefined) {
    button.textContent = glyph;
    return;
  }
  button.textContent = "";
  button.appendChild(drawn);
}

interface Popover {
  readonly host: HTMLElement;
  readonly button: HTMLButtonElement;
  readonly panel: HTMLElement;
}

interface ColorRefs {
  readonly popover: Popover;
  readonly input: HTMLInputElement;
  /** Back to Obsidian's own colour for this slot. */
  readonly reset: HTMLButtonElement;
  /** Transparent; only where no colour is a sensible choice. */
  readonly clear: HTMLButtonElement;
  readonly swatches: HTMLElement;
  readonly recent: HTMLElement;
}

interface ToolbarRefs {
  readonly bar: HTMLElement;
  readonly shape: Popover;
  /** One button per catalogue entry, keyed by the entry's kind. */
  readonly shapeOptions: Readonly<Record<string, HTMLButtonElement>>;
  readonly textGroup: HTMLElement;
  readonly font: Popover;
  readonly fontOptions: readonly HTMLButtonElement[];
  readonly fontSize: HTMLInputElement;
  readonly fontSizeDown: HTMLButtonElement;
  readonly fontSizeUp: HTMLButtonElement;
  readonly format: Popover;
  readonly formats: Readonly<Record<string, HTMLButtonElement>>;
  readonly align: Popover;
  readonly alignments: readonly HTMLButtonElement[];
  readonly verticalAlignments: readonly HTMLButtonElement[];
  readonly lineHeight: HTMLInputElement;
  readonly edgeGroup: HTMLElement;
  readonly startCap: Popover;
  readonly endCap: Popover;
  readonly startCaps: readonly HTMLButtonElement[];
  readonly endCaps: readonly HTMLButtonElement[];
  readonly swapEnds: HTMLButtonElement;
  readonly line: Popover;
  readonly routes: readonly HTMLButtonElement[];
  readonly strokes: readonly HTMLButtonElement[];
  readonly lineWidth: HTMLInputElement;
  readonly lineWidthValue: HTMLElement;
  readonly colors: Readonly<Record<string, ColorRefs>>;
  readonly borderStyles: readonly HTMLButtonElement[];
  readonly borderWidth: HTMLInputElement;
  readonly borderWidthValue: HTMLElement;
  readonly lock: HTMLButtonElement;
  readonly openLink: HTMLButtonElement;
  /** Where the host puts the native Canvas menu, so a selection has one menu. */
  readonly nativeSlot: HTMLElement;
  readonly status: HTMLElement;
}

export class SelectionToolbar {
  public readonly element: HTMLElement;
  private readonly document: Document | undefined;
  private readonly actions: SelectionToolbarActions;
  private readonly setIcon: SelectionToolbarOptions["setIcon"];
  private readonly refs: ToolbarRefs | undefined;
  private readonly listeners: Array<() => void> = [];
  private readonly popovers: Popover[] = [];
  private state: SelectionToolbarState | undefined;
  private selectionKey = "";

  public constructor(actions: SelectionToolbarActions, options: SelectionToolbarOptions = {}) {
    this.actions = actions;
    this.setIcon = options.setIcon;
    this.document = options.document ?? (typeof document !== "undefined" ? document : undefined);
    if (!hasDocument(this.document)) {
      this.element = {} as HTMLElement;
      return;
    }
    const root = make(this.document, "div", options.className ?? "miro-canvas-toolbar");
    root.setAttribute("role", "toolbar");
    root.setAttribute("aria-label", options.title ?? "Selected element formatting");
    root.setAttribute("data-miro-canvas-toolbar", "true");
    root.hidden = true;
    this.element = root;
    this.refs = this.build(root);
  }

  /** The place in the toolbar reserved for the native Canvas menu. */
  public get nativeSlot(): HTMLElement | undefined {
    return this.refs?.nativeSlot;
  }

  /** Draw an Obsidian icon, or a glyph where the host has none to give. */
  private icon(element: HTMLElement, name: string, glyph: string): void {
    if (element.getAttribute("data-icon") === name) return;
    element.setAttribute("data-icon", name);
    if (this.setIcon !== undefined) {
      try {
        this.setIcon(element, name);
        return;
      } catch {
        // A host that cannot draw the icon still gets a readable button.
      }
    }
    element.textContent = glyph;
  }

  /** A popover is a button plus a panel that only this toolbar can open. */
  private makePopover(parent: HTMLElement, title: string, className = ""): Popover {
    const document = this.document!;
    const host = append(parent, make(document, "span", "miro-canvas-toolbar__popover"));
    const button = append(host, makeButton(document, title, className));
    button.setAttribute("aria-haspopup", "true");
    button.setAttribute("aria-expanded", "false");
    const panel = append(host, make(document, "div", "miro-canvas-toolbar__panel"));
    panel.hidden = true;
    const popover: Popover = { host, button, panel };
    this.listen(button, "click", () => this.togglePopover(popover));
    this.popovers.push(popover);
    return popover;
  }

  private togglePopover(target: Popover): void {
    const open = target.panel.hidden;
    this.closePopovers();
    if (!open) return;
    target.panel.hidden = false;
    target.button.setAttribute("aria-expanded", "true");
  }

  private closePopovers(): void {
    for (const popover of this.popovers) {
      popover.panel.hidden = true;
      popover.button.setAttribute("aria-expanded", "false");
    }
  }

  /** A block inside a panel, under an optional small heading. */
  private block(panel: HTMLElement, title: string | undefined, className = "miro-canvas-toolbar__row"): HTMLElement {
    const document = this.document!;
    if (title !== undefined) append(panel, make(document, "div", "miro-canvas-toolbar__heading", title));
    return append(panel, make(document, "div", className));
  }

  /** A row of choices drawn as pictures. */
  private choices<T extends string>(
    parent: HTMLElement,
    values: readonly T[],
    label: (value: T) => string,
    picture: (value: T) => Element | undefined,
    glyph: (value: T) => string,
  ): HTMLButtonElement[] {
    return values.map((value) => {
      const option = append(parent, makeChoice(this.document!, label(value), value, "miro-canvas-toolbar__button--picture"));
      option.setAttribute("data-tooltip-delay", PICTURE_TOOLTIP_DELAY);
      showPicture(option, value, () => picture(value), glyph(value));
      return option;
    });
  }

  private build(root: HTMLElement): ToolbarRefs {
    const document = this.document!;
    const bar = append(root, make(document, "div", "miro-canvas-toolbar__bar"));

    // A node's shape: pictures only, every picture once.
    const shape = this.makePopover(bar, "Shape", "miro-canvas-toolbar__button--shape");
    shape.panel.className = `${shape.panel.className} miro-canvas-toolbar__panel--shapes`;
    showPicture(shape.button, SHAPE_CATALOG[0]!.kind, () => shapePicture(document, SHAPE_CATALOG[0]!), "▭");
    const shapeOptions: Record<string, HTMLButtonElement> = {};
    for (const { section, title } of SHAPE_SECTIONS) {
      const grid = this.block(shape.panel, title, "miro-canvas-toolbar__pictures miro-canvas-toolbar__pictures--shapes");
      const items = SHAPE_CATALOG.filter((entry) => entry.section === section);
      const buttons = this.choices(
        grid, items.map((item) => item.kind), (kind) => shapeCatalogLabel(shapeCatalogEntry(kind)!),
        (kind) => shapePicture(document, shapeCatalogEntry(kind)!), (kind) => shapeCatalogEntry(kind)!.name,
      );
      for (const button of buttons) {
        const kind = button.getAttribute("data-value")!;
        button.setAttribute("data-shape", kind);
        shapeOptions[kind] = button;
      }
    }

    // A node's text: family and size, then how the text is set.
    const textGroup = append(bar, make(document, "span", "miro-canvas-toolbar__group"));
    const font = this.makePopover(textGroup, "Font", "miro-canvas-toolbar__button--font");
    const fontList = this.block(font.panel, undefined, "miro-canvas-toolbar__list");
    const fontOptions = FONT_FAMILIES.map((family) => {
      const option = append(fontList, makeChoice(document, family, family, "miro-canvas-toolbar__button--font-option"));
      option.textContent = family;
      // Each family is shown in its own face, so the list is its own preview.
      option.style.setProperty?.("font-family", family);
      return option;
    });
    const stepper = append(textGroup, make(document, "span", "miro-canvas-toolbar__stepper"));
    const fontSize = append(stepper, makeNumber(document, "Font size", MIN_FONT_SIZE, MAX_FONT_SIZE));
    const steps = append(stepper, make(document, "span", "miro-canvas-toolbar__stepper-buttons"));
    const fontSizeUp = append(steps, makeButton(document, "Increase font size", "miro-canvas-toolbar__button--step"));
    const fontSizeDown = append(steps, makeButton(document, "Decrease font size", "miro-canvas-toolbar__button--step"));
    this.icon(fontSizeUp, "chevron-up", "⌃");
    this.icon(fontSizeDown, "chevron-down", "⌄");

    const format = this.makePopover(textGroup, "Text style");
    this.icon(format.button, "bold", "B");
    const formatRow = this.block(format.panel, undefined);
    const formats: Record<string, HTMLButtonElement> = {};
    for (const { format: value, icon, glyph, label } of FORMATS) {
      const toggle = append(formatRow, makeChoice(document, label, value));
      this.icon(toggle, icon, glyph);
      formats[value] = toggle;
    }

    const align = this.makePopover(textGroup, "Alignment");
    this.icon(align.button, ALIGNMENTS[0]!.icon, "≡");
    const alignRow = this.block(align.panel, undefined);
    const alignments = ALIGNMENTS.map(({ value, icon, label }) => {
      const toggle = append(alignRow, makeChoice(document, label, value));
      this.icon(toggle, icon, value.charAt(0).toUpperCase());
      return toggle;
    });
    const verticalRow = this.block(align.panel, undefined);
    const verticalAlignments = VERTICAL_ALIGNMENTS.map(({ value, icon, label }) => {
      const toggle = append(verticalRow, makeChoice(document, label, value));
      this.icon(toggle, icon, value.charAt(0).toUpperCase());
      return toggle;
    });
    const spacingRow = this.block(align.panel, "Line height");
    const lineHeight = append(spacingRow, makeNumber(document, "Line height", 1, 10));
    lineHeight.step = "0.1";

    // A connector: its two ends and the kind of line between them.
    const edgeGroup = append(bar, make(document, "span", "miro-canvas-toolbar__group"));
    const startCap = this.makePopover(edgeGroup, "Line start", "miro-canvas-toolbar__button--cap");
    const swapEnds = append(edgeGroup, makeButton(document, "Swap line ends"));
    this.icon(swapEnds, "arrow-left-right", "⇄");
    const endCap = this.makePopover(edgeGroup, "Line end", "miro-canvas-toolbar__button--cap");
    const caps = (popover: Popover, at: "start" | "end"): HTMLButtonElement[] => this.choices(
      this.block(popover.panel, undefined, "miro-canvas-toolbar__pictures miro-canvas-toolbar__pictures--caps"),
      CONNECTOR_CAPS, (cap) => CAP_LABELS[cap], (cap) => capPicture(document, cap, at), (cap) => (cap === "none" ? "—" : cap),
    );
    const startCaps = caps(startCap, "start");
    const endCaps = caps(endCap, "end");
    const line = this.makePopover(edgeGroup, "Line", "miro-canvas-toolbar__button--line");
    const routes = this.choices(
      this.block(line.panel, undefined), CONNECTOR_ROUTES, (route) => ROUTE_LABELS[route],
      (route) => routePicture(document, route), (route) => route.charAt(0).toUpperCase(),
    );
    const strokes = this.choices(
      this.block(line.panel, undefined), CONNECTOR_STROKES, (stroke) => STROKE_LABELS[stroke],
      (stroke) => strokePicture(document, stroke), (stroke) => stroke.charAt(0).toUpperCase(),
    );
    const lineWidthRow = this.block(line.panel, "Thickness", "miro-canvas-toolbar__row miro-canvas-toolbar__slider");
    const lineWidth = append(lineWidthRow, makeRange(document, "Line thickness", 1, LINE_SLIDER_MAX));
    const lineWidthValue = append(lineWidthRow, make(document, "span", "miro-canvas-toolbar__value"));

    // Colours: text, fill and border for a node, the line colour for a connector.
    const colorGroup = append(bar, make(document, "span", "miro-canvas-toolbar__group"));
    const colors: Record<string, ColorRefs> = {};
    for (const { slot, label, valueLabel, look } of COLOR_SLOTS) {
      const popover = this.makePopover(colorGroup, label, `miro-canvas-toolbar__button--color miro-canvas-toolbar__button--color-${slot}`);
      popover.host.setAttribute("data-color-slot", slot);
      popover.button.setAttribute("data-look", look);
      if (look === "text") this.icon(popover.button, "baseline", "A");
      else append(popover.button, make(document, "span", "miro-canvas-toolbar__swatch-mark"));
      // Obsidian's own colour leads the palette, so any colour can be undone.
      const standard = this.block(popover.panel, undefined, "miro-canvas-toolbar__row miro-canvas-toolbar__standard");
      const reset = append(standard, makeButton(document, "Obsidian color", "miro-canvas-toolbar__button--default"));
      reset.setAttribute("data-color-default", slot);
      reset.setAttribute("aria-pressed", "false");
      append(reset, make(document, "span", "miro-canvas-toolbar__default-mark"));
      append(reset, make(document, "span", "miro-canvas-toolbar__default-label", "Default"));
      const swatches = this.block(popover.panel, undefined, "miro-canvas-toolbar__pictures miro-canvas-toolbar__palette");
      swatches.setAttribute("data-color-palette", slot);
      const recent = this.block(popover.panel, undefined, "miro-canvas-toolbar__pictures miro-canvas-toolbar__palette miro-canvas-toolbar__palette--recent");
      recent.setAttribute("data-color-recent", slot);
      const custom = this.block(popover.panel, undefined);
      const input = append(custom, make(document, "input", "miro-canvas-toolbar__swatch"));
      input.type = "color";
      // Distinct from the popover button's own label so assistive technology
      // and tests can address the value control unambiguously.
      input.setAttribute("aria-label", `Custom ${valueLabel.toLowerCase()}`);
      const clear = append(standard, makeButton(document, "Transparent", "miro-canvas-toolbar__button--transparent"));
      clear.setAttribute("aria-pressed", "false");
      this.icon(clear, "ban", "∅");
      clear.hidden = !TRANSPARENT_SLOTS.has(slot);
      colors[slot] = { popover, input, reset, clear, swatches, recent };
    }
    const borderPanel = colors.border!.popover.panel;
    const borderStyles = this.choices(
      this.block(borderPanel, "Border style"), BORDER_STYLES.map((item) => item.value),
      (value) => BORDER_STYLES.find((item) => item.value === value)!.label,
      (value) => borderPicture(document, value), (value) => value.charAt(0).toUpperCase(),
    );
    const borderWidthRow = this.block(borderPanel, "Border width", "miro-canvas-toolbar__row miro-canvas-toolbar__slider");
    const borderWidth = append(borderWidthRow, makeRange(document, "Border width", 0, BORDER_SLIDER_MAX));
    const borderWidthValue = append(borderWidthRow, make(document, "span", "miro-canvas-toolbar__value"));

    // A link card no longer loads its page, so it is opened from here.
    const openLink = append(bar, makeButton(document, "Open link", "miro-canvas-toolbar__button--open-link"));
    this.icon(openLink, "external-link", "↗");
    openLink.hidden = true;
    const lock = append(bar, makeButton(document, "Lock selection", "miro-canvas-toolbar__button--lock"));
    lock.setAttribute("aria-pressed", "false");
    const nativeSlot = append(bar, make(document, "span", "miro-canvas-toolbar__native"));

    const status = append(root, make(document, "p", "miro-canvas-toolbar__status"));
    status.setAttribute("role", "status");
    status.hidden = true;

    const refs: ToolbarRefs = {
      bar, shape, shapeOptions,
      textGroup, font, fontOptions, fontSize, fontSizeDown, fontSizeUp,
      format, formats, align, alignments, verticalAlignments, lineHeight,
      edgeGroup, startCap, endCap, startCaps, endCaps, swapEnds, line, routes, strokes, lineWidth, lineWidthValue,
      colors, borderStyles, borderWidth, borderWidthValue,
      lock, openLink, nativeSlot, status,
    };
    this.wire(refs);
    return refs;
  }

  private wire(refs: ToolbarRefs): void {
    const valueOf = (option: HTMLElement): string => option.getAttribute("data-value") ?? "";
    for (const item of SHAPE_CATALOG) {
      this.listen(refs.shapeOptions[item.kind]!, "click", () => {
        // The node already shows this picture, maybe under a flowchart name.
        if (shapeCatalogEntry(this.state?.shape) === item) return;
        this.style({ shape: item.kind });
      });
    }
    for (const option of refs.fontOptions) {
      this.listen(option, "click", () => this.appearance({ type: APPEARANCE_ACTIONS.setFontFamily, fontFamily: valueOf(option) }));
    }
    this.listen(refs.fontSize, "change", () => {
      const size = finiteNumber(refs.fontSize.value);
      if (size !== undefined) this.appearance({ type: APPEARANCE_ACTIONS.setFontSize, fontSize: this.clampFontSize(size) });
    });
    this.listen(refs.fontSizeDown, "click", () => this.stepFontSize(-1));
    this.listen(refs.fontSizeUp, "click", () => this.stepFontSize(1));
    for (const { format } of FORMATS) {
      this.listen(refs.formats[format]!, "click", () => this.appearance({
        type: APPEARANCE_ACTIONS.setFormat,
        format: { [format]: this.state?.typography.format[format] !== true },
      }));
    }
    for (const option of refs.alignments) {
      this.listen(option, "click", () => this.appearance({ type: APPEARANCE_ACTIONS.setAlignment, alignment: valueOf(option) }));
    }
    for (const option of refs.verticalAlignments) {
      this.listen(option, "click", () => this.appearance({
        type: APPEARANCE_ACTIONS.setTypography, typography: { verticalAlign: valueOf(option) },
      }));
    }
    this.listen(refs.lineHeight, "change", () => {
      const value = finiteNumber(refs.lineHeight.value);
      if (value !== undefined && value > 0 && value <= 10) {
        this.appearance({ type: APPEARANCE_ACTIONS.setTypography, typography: { lineHeight: value } });
      }
    });
    for (const [key, options] of [["startCap", refs.startCaps], ["endCap", refs.endCaps]] as const) {
      for (const option of options) {
        this.listen(option, "click", () => this.style({
          connector: { [key]: valueOf(option) as ConnectorCap } as LocalConnectorSettings,
        }));
      }
    }
    this.listen(refs.swapEnds, "click", () => {
      const { start, end } = this.caps();
      if (start !== end) this.style({ connector: { startCap: end, endCap: start } });
    });
    for (const option of refs.routes) {
      this.listen(option, "click", () => this.style({ connector: { route: valueOf(option) as ConnectorRoute } }));
    }
    for (const option of refs.strokes) {
      this.listen(option, "click", () => this.style({ connector: { strokeStyle: valueOf(option) as ConnectorStroke } }));
    }
    // A slider shows its value while it moves and writes once, when it is let go.
    this.listen(refs.lineWidth, "input", () => { refs.lineWidthValue.textContent = refs.lineWidth.value; });
    this.listen(refs.lineWidth, "change", () => {
      const width = finiteNumber(refs.lineWidth.value);
      if (width !== undefined && width > 0 && width <= MAX_BORDER_WIDTH) this.style({ connector: { width } });
    });
    for (const { slot } of COLOR_SLOTS) {
      const color = refs.colors[slot]!;
      this.listen(color.input, "change", () => {
        const value = normalizedHex(color.input.value);
        if (value !== undefined) this.appearance({ type: APPEARANCE_ACTIONS.setColor, slot, color: value });
      });
      this.listen(color.clear, "click", () => this.appearance({ type: APPEARANCE_ACTIONS.setColor, slot, color: null }));
      this.listen(color.reset, "click", () => this.appearance({ type: APPEARANCE_ACTIONS.resetColor, slot }));
    }
    for (const option of refs.borderStyles) {
      this.listen(option, "click", () => this.style({ borderStyle: valueOf(option) as BorderStyle }));
    }
    this.listen(refs.borderWidth, "input", () => { refs.borderWidthValue.textContent = refs.borderWidth.value; });
    this.listen(refs.borderWidth, "change", () => {
      const width = finiteNumber(refs.borderWidth.value);
      if (width !== undefined && width >= 0 && width <= MAX_BORDER_WIDTH) this.style({ borderWidth: width });
    });
    // The lock toggle is the one control that stays live on a locked selection,
    // otherwise an accidental lock could never be undone from here.
    this.listen(refs.lock, "click", () => {
      if (this.state === undefined || this.state.reviewMode) return;
      this.actions.onLock(!this.state.locked);
    });
    // Opening a link changes nothing on the board, so review mode allows it.
    this.listen(refs.openLink, "click", () => {
      if (this.state?.link !== undefined) this.actions.onOpenLink?.();
    });
    this.listen(this.element, "keydown", (event) => {
      if ((event as KeyboardEvent).key === "Escape") this.closePopovers();
    });
  }

  private listen(target: EventTarget, type: string, handler: EventListener): void {
    target.addEventListener(type, handler);
    this.listeners.push(() => target.removeEventListener(type, handler));
  }

  private clampFontSize(value: number): number {
    return Math.min(MAX_FONT_SIZE, Math.max(MIN_FONT_SIZE, Math.round(value)));
  }

  private stepFontSize(delta: -1 | 1): void {
    const current = this.state?.typography.fontSize ?? 16;
    this.appearance({ type: APPEARANCE_ACTIONS.setFontSize, fontSize: this.clampFontSize(current + delta) });
  }

  /** The ends a connector shows: no start and an arrow at the end unless it says otherwise. */
  private caps(): { readonly start: ConnectorCap; readonly end: ConnectorCap } {
    return {
      start: this.state?.connector?.startCap ?? "none",
      end: this.state?.connector?.endCap ?? "arrow",
    };
  }

  /** Every emitter funnels through these two guards so an inert toolbar stays inert. */
  private appearance(action: AppearanceAction): void {
    if (this.state?.editable !== true) return;
    this.actions.onAppearance(action);
  }

  private style(patch: SelectionStylePatch): void {
    if (this.state?.editable !== true) return;
    this.actions.onStyle(patch);
  }

  public update(state: SelectionToolbarState): void {
    this.state = state;
    const refs = this.refs;
    if (refs === undefined) return;
    const document = this.document!;
    const root = this.element;
    const visible = state.selectedIds.length > 0 && state.placement !== undefined;
    root.hidden = !visible;
    // A popover must never outlive the selection it was opened for.
    const selectionKey = state.selectedIds.join("\u0000");
    if (!visible || selectionKey !== this.selectionKey) {
      this.selectionKey = selectionKey;
      this.closePopovers();
    }
    if (!visible) return;

    root.style.left = `${state.placement!.x}px`;
    root.style.top = `${state.placement!.y}px`;
    root.setAttribute("data-miro-canvas-editable", state.editable ? "true" : "false");

    const hasEdge = state.kinds.includes("edge");
    const hasNode = state.kinds.some((kind) => kind !== "edge");
    refs.shape.host.hidden = !state.kinds.includes("shape");
    // A connector's label keeps native editing, and a link, file or embed has
    // no text of its own: the text row belongs to nodes that show text.
    refs.textGroup.hidden = !state.kinds.some((kind) => kind !== "edge" && kind !== "media");
    refs.edgeGroup.hidden = !hasEdge;
    for (const { slot, forEdge } of COLOR_SLOTS) {
      refs.colors[slot]!.popover.host.hidden = forEdge ? !hasEdge : !hasNode;
    }

    const shape = shapeCatalogEntry(state.shape);
    for (const item of SHAPE_CATALOG) {
      refs.shapeOptions[item.kind]!.setAttribute("aria-pressed", item === shape ? "true" : "false");
    }
    const shown = shape ?? SHAPE_CATALOG[0]!;
    showPicture(refs.shape.button, shown.kind, () => shapePicture(document, shown), "▭");

    const typography = state.typography;
    refs.font.button.textContent = typography.fontFamily;
    refs.font.button.style.setProperty?.("font-family", typography.fontFamily);
    pressWhere(refs.fontOptions, typography.fontFamily);
    refs.fontSize.value = String(typography.fontSize);
    let styled = false;
    for (const { format } of FORMATS) {
      const on = typography.format[format] === true;
      styled ||= on;
      refs.formats[format]!.setAttribute("aria-pressed", on ? "true" : "false");
    }
    refs.format.button.setAttribute("data-active", styled ? "true" : "false");
    pressWhere(refs.alignments, typography.alignment);
    pressWhere(refs.verticalAlignments, typography.verticalAlign ?? "top");
    const alignment = ALIGNMENTS.find((item) => item.value === typography.alignment) ?? ALIGNMENTS[0]!;
    this.icon(refs.align.button, alignment.icon, "≡");
    refs.lineHeight.value = typography.lineHeight === undefined ? "" : String(typography.lineHeight);

    const { start, end } = this.caps();
    const route = state.connector?.route ?? "curved";
    pressWhere(refs.startCaps, start);
    pressWhere(refs.endCaps, end);
    pressWhere(refs.routes, route);
    pressWhere(refs.strokes, state.connector?.strokeStyle ?? "solid");
    showPicture(refs.startCap.button, `start:${start}`, () => capPicture(document, start, "start"), start === "none" ? "—" : "←");
    showPicture(refs.endCap.button, `end:${end}`, () => capPicture(document, end, "end"), end === "none" ? "—" : "→");
    showPicture(refs.line.button, `route:${route}`, () => routePicture(document, route), "╱");
    const lineWidth = state.connector?.width;
    refs.lineWidth.value = String(Math.min(LINE_SLIDER_MAX, lineWidth ?? 2));
    refs.lineWidthValue.textContent = String(lineWidth ?? 2);

    for (const { slot } of COLOR_SLOTS) {
      const color = normalizedHex(state.colors[slot]);
      const slotRefs = refs.colors[slot]!;
      // Absent is Obsidian's own colour; null is a transparent choice.
      slotRefs.reset.setAttribute("aria-pressed", state.colors[slot] === undefined ? "true" : "false");
      slotRefs.clear.setAttribute("aria-pressed", state.colors[slot] === null ? "true" : "false");
      slotRefs.popover.button.setAttribute("data-color-origin", state.colors[slot] === undefined ? "obsidian" : "board");
      slotRefs.input.value = color ?? "#000000";
      slotRefs.popover.button.setAttribute("data-color-unset", color === undefined ? "true" : "false");
      slotRefs.popover.button.style.setProperty?.("--miro-canvas-swatch", color ?? "transparent");
      const palette = slot === "fill" ? state.fillPalette ?? state.palette : state.palette;
      this.renderSwatches(slotRefs.swatches, slot, palette.map((entry) => entry.color), state.editable, color, palette);
      this.renderSwatches(slotRefs.recent, slot, state.recentColors, state.editable, color);
      slotRefs.recent.hidden = state.recentColors.length === 0;
    }
    pressWhere(refs.borderStyles, state.borderStyle ?? "solid");
    refs.borderWidth.value = String(Math.min(BORDER_SLIDER_MAX, state.borderWidth ?? 1));
    refs.borderWidthValue.textContent = state.borderWidth === undefined ? "" : String(state.borderWidth);

    this.icon(refs.lock, state.locked ? "lock" : "lock-open", state.locked ? "🔒" : "🔓");
    refs.lock.setAttribute("aria-pressed", state.locked ? "true" : "false");
    refs.lock.setAttribute("aria-label", state.locked ? "Unlock selection" : "Lock selection");
    refs.lock.disabled = state.reviewMode;
    refs.openLink.hidden = state.link === undefined || this.actions.onOpenLink === undefined;
    refs.openLink.setAttribute("aria-label", state.link === undefined ? "Open link" : `Open link\n${state.link}`);
    for (const control of this.controls(refs)) {
      control.disabled = !state.editable;
    }
    const reason = state.editable ? undefined : state.blockedReason ?? "This selection is locked.";
    refs.status.hidden = reason === undefined;
    refs.status.textContent = reason ?? "";
  }

  /** Swatches are rebuilt only when the palette they show actually changed. */
  private renderSwatches(
    container: HTMLElement, slot: ColorSlot, colors: readonly string[], editable: boolean, current: string | undefined,
    named: readonly PaletteColor[] = [],
  ): void {
    const wanted = colors.map((color) => normalizedHex(color)).filter((color): color is string => color !== undefined);
    if (container.getAttribute("data-colors") !== wanted.join(",")) {
      container.setAttribute("data-colors", wanted.join(","));
      empty(container);
      for (const color of wanted) {
        const label = named.find((entry) => normalizedHex(entry.color) === color)?.label;
        const button = append(container, makeButton(this.document!, label === undefined ? color : `${label}\n${color}`, "miro-canvas-toolbar__button--swatch"));
        button.setAttribute("data-color", color);
        button.setAttribute("data-tooltip-delay", PICTURE_TOOLTIP_DELAY);
        button.style.setProperty?.("--miro-canvas-swatch", color);
        this.listen(button, "click", () => this.appearance({ type: APPEARANCE_ACTIONS.setColor, slot, color }));
      }
    }
    for (const child of Array.from(container.children ?? []) as HTMLButtonElement[]) {
      child.disabled = !editable;
      child.setAttribute("aria-pressed", child.getAttribute("data-color") === current ? "true" : "false");
    }
  }

  private controls(refs: ToolbarRefs): readonly (HTMLButtonElement | HTMLInputElement)[] {
    return [
      ...Object.values(refs.shapeOptions),
      ...refs.fontOptions, refs.fontSize, refs.fontSizeDown, refs.fontSizeUp,
      ...Object.values(refs.formats), ...refs.alignments, ...refs.verticalAlignments, refs.lineHeight,
      ...refs.startCaps, ...refs.endCaps, refs.swapEnds, ...refs.routes, ...refs.strokes, refs.lineWidth,
      ...Object.values(refs.colors).flatMap((color) => [color.input, color.clear, color.reset]),
      ...refs.borderStyles, refs.borderWidth,
    ];
  }

  public dispose(): void {
    for (const remove of this.listeners.splice(0)) {
      try {
        remove();
      } catch {
        // The host document may already be gone with its pane.
      }
    }
    try {
      this.element.remove?.();
    } catch {
      // A detached toolbar needs no removal.
    }
  }
}
