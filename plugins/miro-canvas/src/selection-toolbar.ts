/**
 * Floating, selection-scoped formatting toolbar.
 *
 * The native Canvas remains the editor.  This module only builds detached DOM
 * and reports explicit user actions to its host.  Typography and colors reuse
 * the appearance pipeline; shape, border and connector settings are reported
 * separately because only `CanvasAuthoring` can write them.  The toolbar owns
 * no geometry: the host supplies an already-resolved viewport placement.
 *
 * The layout follows Miro: one compact row of icon buttons, each opening a
 * popover, with everything rare behind an overflow menu.  Controls that do not
 * apply to the current selection are removed from the row rather than shown
 * disabled.
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
export type { ShapeKind } from "./shape-catalog";

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
  readonly recentColors: readonly string[];
  readonly placement?: SelectionToolbarPlacement;
}

/** A style patch never carries the target id: the host owns the selection. */
export type SelectionStylePatch = SelectionToolbarStyle;

export interface SelectionToolbarActions {
  readonly onAppearance: (action: AppearanceAction) => void;
  readonly onStyle: (patch: SelectionStylePatch) => void;
  readonly onLock: (locked: boolean) => void;
}

export interface SelectionToolbarOptions {
  readonly document?: Document;
  readonly className?: string;
  readonly title?: string;
}

const MIN_FONT_SIZE = 6;
const MAX_FONT_SIZE = 256;
const MAX_BORDER_WIDTH = 100;
const FONT_FAMILIES = [
  "Open Sans", "Inter", "Roboto", "Noto Sans", "Arial", "Georgia",
  "Times New Roman", "Courier New", "system-ui", "sans-serif",
] as const;
const ALIGNMENTS: readonly TextAlignment[] = ["left", "center", "right", "justify"];
const VERTICAL_ALIGNMENTS: readonly VerticalAlign[] = ["top", "center", "bottom"];
const BORDER_STYLES: readonly BorderStyle[] = ["solid", "dashed", "dotted", "none"];
const FORMATS = ["bold", "italic", "underline", "strike"] as const;
const FORMAT_LABELS: Readonly<Record<(typeof FORMATS)[number], string>> = Object.freeze({
  bold: "B", italic: "I", underline: "U", strike: "S",
});
/** Shapes are picked by their picture; the words are in the hover text. */
const SHAPE_SECTIONS: readonly { readonly section: ShapeSection; readonly title: string }[] = [
  { section: "basic", title: "Basic" },
  { section: "flowchart", title: "Flowchart" },
];
/** Hover text for a picture should not make a person wait a second for it. */
const SHAPE_TOOLTIP_DELAY = "150";
const SVG_NS = "http://www.w3.org/2000/svg";
const COLOR_BUTTONS: readonly {
  readonly slot: ColorSlot; readonly label: string; readonly glyph: string; readonly forEdge: boolean;
}[] = [
  { slot: "text", label: "Text color", glyph: "A", forEdge: false },
  { slot: "fill", label: "Fill color", glyph: "▨", forEdge: false },
  { slot: "border", label: "Border color", glyph: "◯", forEdge: false },
  { slot: "edge", label: "Line color", glyph: "◯", forEdge: true },
];

/** Token labels are derived so a new Miro kind never needs a parallel table. */
function tokenLabel(token: string): string {
  const words = token.replace(/^flow_chart_/u, "").replace(/^erd?_/u, "").split("_").join(" ").trim();
  return words.length === 0 ? token : words.charAt(0).toUpperCase() + words.slice(1);
}

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
function makeButton(document: Document, label: string, title: string, className = ""): HTMLButtonElement {
  const button = make(document, "button", `miro-canvas-toolbar__button ${className}`.trim(), label);
  button.type = "button";
  button.setAttribute("aria-label", title);
  return button;
}

function makeSelect(document: Document, title: string, values: readonly string[], className = ""): HTMLSelectElement {
  const select = make(document, "select", `miro-canvas-toolbar__select ${className}`.trim());
  select.setAttribute("aria-label", title);
  for (const value of values) {
    const option = make(document, "option", undefined, tokenLabel(value));
    option.value = value;
    append(select, option);
  }
  return select;
}

/** An outline picture of a catalogue entry, or undefined where the document cannot draw SVG. */
function makeShapeIcon(document: Document, item: ShapeCatalogEntry): Element | undefined {
  const d = shapePath(item.kind);
  if (d === undefined || typeof document.createElementNS !== "function") return undefined;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", `miro-canvas-shape-icon miro-canvas-shape-icon--${item.aspect}`);
  // Some outlines bulge a little past the 0..100 box, as a cloud does.
  svg.setAttribute("viewBox", "-10 -10 120 120");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("vector-effect", "non-scaling-stroke");
  svg.appendChild(path);
  return svg;
}

/** Show one picture inside a button, falling back to its name. */
function showShapeIcon(document: Document, button: HTMLButtonElement, item: ShapeCatalogEntry, fallback: string): void {
  if (button.getAttribute("data-shape-icon") === item.kind) return;
  button.setAttribute("data-shape-icon", item.kind);
  while (button.firstChild !== null) button.removeChild(button.firstChild);
  const icon = makeShapeIcon(document, item);
  if (icon === undefined) {
    button.textContent = fallback;
  } else {
    button.textContent = "";
    button.appendChild(icon);
  }
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

interface Popover {
  readonly host: HTMLElement;
  readonly button: HTMLButtonElement;
  readonly panel: HTMLElement;
}

interface ToolbarRefs {
  readonly bar: HTMLElement;
  readonly shape: Popover;
  /** One button per catalogue entry, keyed by the entry's kind. */
  readonly shapeOptions: Readonly<Record<string, HTMLButtonElement>>;
  readonly textGroup: HTMLElement;
  readonly fontFamily: HTMLSelectElement;
  readonly fontSize: HTMLInputElement;
  readonly fontSizeDown: HTMLButtonElement;
  readonly fontSizeUp: HTMLButtonElement;
  readonly bold: HTMLButtonElement;
  readonly align: Popover;
  readonly alignment: HTMLSelectElement;
  readonly verticalAlign: HTMLSelectElement;
  readonly colors: Readonly<Record<string, Popover>>;
  readonly colorInputs: Readonly<Record<string, HTMLInputElement>>;
  readonly colorClears: Readonly<Record<string, HTMLButtonElement>>;
  readonly colorSwatches: Readonly<Record<string, HTMLElement>>;
  readonly colorRecent: Readonly<Record<string, HTMLElement>>;
  readonly lock: HTMLButtonElement;
  /** Where the host puts the native Canvas menu, so a selection has one menu. */
  readonly nativeSlot: HTMLElement;
  readonly more: Popover;
  readonly formats: Readonly<Record<(typeof FORMATS)[number], HTMLButtonElement>>;
  readonly lineHeight: HTMLInputElement;
  readonly borderGroup: HTMLElement;
  readonly borderStyle: HTMLSelectElement;
  readonly borderWidth: HTMLInputElement;
  readonly connectorGroup: HTMLElement;
  readonly route: HTMLSelectElement;
  readonly strokeStyle: HTMLSelectElement;
  readonly startCap: HTMLSelectElement;
  readonly endCap: HTMLSelectElement;
  readonly connectorWidth: HTMLInputElement;
  readonly status: HTMLElement;
}

export class SelectionToolbar {
  public readonly element: HTMLElement;
  private readonly document: Document | undefined;
  private readonly actions: SelectionToolbarActions;
  private readonly refs: ToolbarRefs | undefined;
  private readonly listeners: Array<() => void> = [];
  private readonly popovers: Popover[] = [];
  private state: SelectionToolbarState | undefined;
  private selectionKey = "";

  public constructor(actions: SelectionToolbarActions, options: SelectionToolbarOptions = {}) {
    this.actions = actions;
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

  /** A popover is a button plus a panel that only this toolbar can open. */
  private makePopover(parent: HTMLElement, glyph: string, title: string, className = ""): Popover {
    const document = this.document!;
    const host = append(parent, make(document, "span", "miro-canvas-toolbar__popover"));
    const button = append(host, makeButton(document, glyph, title, className));
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

  private build(root: HTMLElement): ToolbarRefs {
    const document = this.document!;
    const bar = append(root, make(document, "div", "miro-canvas-toolbar__bar"));

    const shape = this.makePopover(bar, "", "Shape", "miro-canvas-toolbar__button--shape");
    shape.panel.className = `${shape.panel.className} miro-canvas-toolbar__panel--shapes`;
    showShapeIcon(document, shape.button, SHAPE_CATALOG[0]!, "▭");
    // Every picture appears once: a flowchart symbol drawn like a basic shape
    // is that basic shape, and its meaning is in the basic shape's hover text.
    const shapeOptions: Record<string, HTMLButtonElement> = {};
    for (const { section, title } of SHAPE_SECTIONS) {
      append(shape.panel, make(document, "div", "miro-canvas-toolbar__heading", title));
      const grid = append(shape.panel, make(document, "div", "miro-canvas-toolbar__shapes"));
      for (const item of SHAPE_CATALOG.filter((entry) => entry.section === section)) {
        const option = append(grid, makeButton(
          document, "", shapeCatalogLabel(item), "miro-canvas-toolbar__button--shape-option",
        ));
        option.setAttribute("data-shape", item.kind);
        option.setAttribute("data-tooltip-delay", SHAPE_TOOLTIP_DELAY);
        option.setAttribute("aria-pressed", "false");
        showShapeIcon(document, option, item, item.name);
        shapeOptions[item.kind] = option;
      }
    }

    const textGroup = append(bar, make(document, "span", "miro-canvas-toolbar__group"));
    const fontFamily = append(textGroup, makeSelect(document, "Font family", FONT_FAMILIES));
    const stepper = append(textGroup, make(document, "span", "miro-canvas-toolbar__stepper"));
    const fontSize = append(stepper, makeNumber(document, "Font size", MIN_FONT_SIZE, MAX_FONT_SIZE));
    const steps = append(stepper, make(document, "span", "miro-canvas-toolbar__stepper-buttons"));
    const fontSizeUp = append(steps, makeButton(document, "⌃", "Increase font size", "miro-canvas-toolbar__button--step"));
    const fontSizeDown = append(steps, makeButton(document, "⌄", "Decrease font size", "miro-canvas-toolbar__button--step"));
    const bold = append(textGroup, makeButton(document, "B", "Toggle bold", "miro-canvas-toolbar__button--bold"));
    bold.setAttribute("aria-pressed", "false");
    const align = this.makePopover(textGroup, "≡", "Alignment");
    const alignment = append(align.panel, makeSelect(document, "Text alignment", ALIGNMENTS));
    const verticalAlign = append(align.panel, makeSelect(document, "Vertical alignment", VERTICAL_ALIGNMENTS));

    const colors: Record<string, Popover> = {};
    const colorInputs: Record<string, HTMLInputElement> = {};
    const colorClears: Record<string, HTMLButtonElement> = {};
    const colorSwatches: Record<string, HTMLElement> = {};
    const colorRecent: Record<string, HTMLElement> = {};
    for (const { slot, label, glyph } of COLOR_BUTTONS) {
      const popover = this.makePopover(bar, glyph, label, `miro-canvas-toolbar__button--color-${slot}`);
      popover.host.setAttribute("data-color-slot", slot);
      // The palette belongs beside the picker, the way Miro shows it.
      const swatches = append(popover.panel, make(document, "div", "miro-canvas-toolbar__grid miro-canvas-toolbar__palette"));
      swatches.setAttribute("data-color-palette", slot);
      const recent = append(popover.panel, make(document, "div", "miro-canvas-toolbar__grid miro-canvas-toolbar__palette miro-canvas-toolbar__palette--recent"));
      recent.setAttribute("data-color-recent", slot);
      const input = append(popover.panel, make(document, "input", "miro-canvas-toolbar__swatch"));
      input.type = "color";
      // Distinct from the popover button's own label so assistive technology
      // and tests can address the value control unambiguously.
      input.setAttribute("aria-label", `${label} value`);
      const clear = append(popover.panel, makeButton(document, "Clear", `Clear ${label.toLowerCase()}`, "miro-canvas-toolbar__button--wide"));
      colors[slot] = popover;
      colorInputs[slot] = input;
      colorClears[slot] = clear;
      colorSwatches[slot] = swatches;
      colorRecent[slot] = recent;
    }

    const lock = append(bar, makeButton(document, "🔓", "Lock selection", "miro-canvas-toolbar__button--lock"));
    lock.setAttribute("aria-pressed", "false");
    const nativeSlot = append(bar, make(document, "span", "miro-canvas-toolbar__native"));

    const more = this.makePopover(bar, "⋮", "More settings");
    const formatGroup = append(more.panel, make(document, "div", "miro-canvas-toolbar__grid"));
    const formats = { bold } as Record<(typeof FORMATS)[number], HTMLButtonElement>;
    for (const format of FORMATS.filter((value) => value !== "bold")) {
      const button = append(formatGroup, makeButton(
        document, FORMAT_LABELS[format], `Toggle ${format}`, `miro-canvas-toolbar__button--${format}`,
      ));
      button.setAttribute("aria-pressed", "false");
      formats[format] = button;
    }
    const lineHeight = append(more.panel, makeNumber(document, "Line height", 1, 10));
    lineHeight.step = "0.1";
    const borderGroup = append(more.panel, make(document, "div", "miro-canvas-toolbar__grid"));
    const borderStyle = append(borderGroup, makeSelect(document, "Border style", BORDER_STYLES));
    const borderWidth = append(borderGroup, makeNumber(document, "Border width", 0, MAX_BORDER_WIDTH));
    const connectorGroup = append(more.panel, make(document, "div", "miro-canvas-toolbar__grid"));
    const route = append(connectorGroup, makeSelect(document, "Connector route", CONNECTOR_ROUTES));
    const strokeStyle = append(connectorGroup, makeSelect(document, "Connector line style", CONNECTOR_STROKES));
    const startCap = append(connectorGroup, makeSelect(document, "Start cap", CONNECTOR_CAPS));
    const endCap = append(connectorGroup, makeSelect(document, "End cap", CONNECTOR_CAPS));
    const connectorWidth = append(connectorGroup, makeNumber(document, "Connector width", 1, MAX_BORDER_WIDTH));

    const status = append(root, make(document, "p", "miro-canvas-toolbar__status"));
    status.setAttribute("role", "status");
    status.hidden = true;

    const refs: ToolbarRefs = {
      bar, shape, shapeOptions,
      textGroup, fontFamily, fontSize, fontSizeDown, fontSizeUp, bold,
      align, alignment, verticalAlign,
      colors, colorInputs, colorClears, colorSwatches, colorRecent, lock, nativeSlot, more,
      formats: formats as ToolbarRefs["formats"], lineHeight,
      borderGroup, borderStyle, borderWidth,
      connectorGroup, route, strokeStyle, startCap, endCap, connectorWidth, status,
    };
    this.wire(refs);
    return refs;
  }

  private wire(refs: ToolbarRefs): void {
    for (const item of SHAPE_CATALOG) {
      this.listen(refs.shapeOptions[item.kind]!, "click", () => {
        // The node already shows this picture, maybe under a flowchart name.
        if (shapeCatalogEntry(this.state?.shape) === item) return;
        this.style({ shape: item.kind });
      });
    }
    this.listen(refs.fontFamily, "change", () => this.appearance({
      type: APPEARANCE_ACTIONS.setFontFamily, fontFamily: refs.fontFamily.value,
    }));
    this.listen(refs.fontSize, "change", () => {
      const size = finiteNumber(refs.fontSize.value);
      if (size !== undefined) this.appearance({ type: APPEARANCE_ACTIONS.setFontSize, fontSize: this.clampFontSize(size) });
    });
    this.listen(refs.fontSizeDown, "click", () => this.stepFontSize(-1));
    this.listen(refs.fontSizeUp, "click", () => this.stepFontSize(1));
    for (const format of FORMATS) {
      this.listen(refs.formats[format], "click", () => this.appearance({
        type: APPEARANCE_ACTIONS.setFormat,
        format: { [format]: this.state?.typography.format[format] !== true },
      }));
    }
    this.listen(refs.alignment, "change", () => this.appearance({
      type: APPEARANCE_ACTIONS.setAlignment, alignment: refs.alignment.value,
    }));
    this.listen(refs.verticalAlign, "change", () => this.appearance({
      type: APPEARANCE_ACTIONS.setTypography, typography: { verticalAlign: refs.verticalAlign.value },
    }));
    this.listen(refs.lineHeight, "change", () => {
      const value = finiteNumber(refs.lineHeight.value);
      if (value !== undefined && value > 0 && value <= 10) {
        this.appearance({ type: APPEARANCE_ACTIONS.setTypography, typography: { lineHeight: value } });
      }
    });
    for (const { slot } of COLOR_BUTTONS) {
      this.listen(refs.colorInputs[slot]!, "change", () => {
        const color = normalizedHex(refs.colorInputs[slot]!.value);
        if (color !== undefined) this.appearance({ type: APPEARANCE_ACTIONS.setColor, slot, color });
      });
      this.listen(refs.colorClears[slot]!, "click", () => this.appearance({
        type: APPEARANCE_ACTIONS.setColor, slot, color: null,
      }));
    }
    // The lock toggle is the one control that stays live on a locked selection,
    // otherwise an accidental lock could never be undone from here.
    this.listen(refs.lock, "click", () => {
      if (this.state === undefined || this.state.reviewMode) return;
      this.actions.onLock(!this.state.locked);
    });
    this.listen(refs.borderStyle, "change", () => this.style({ borderStyle: refs.borderStyle.value as BorderStyle }));
    this.listen(refs.borderWidth, "change", () => {
      const width = finiteNumber(refs.borderWidth.value);
      if (width !== undefined && width >= 0 && width <= MAX_BORDER_WIDTH) this.style({ borderWidth: width });
    });
    const connectorSelects = [
      ["route", refs.route], ["strokeStyle", refs.strokeStyle],
      ["startCap", refs.startCap], ["endCap", refs.endCap],
    ] as const;
    for (const [key, select] of connectorSelects) {
      this.listen(select, "change", () => this.style({ connector: { [key]: select.value } as LocalConnectorSettings }));
    }
    this.listen(refs.connectorWidth, "change", () => {
      const width = finiteNumber(refs.connectorWidth.value);
      if (width !== undefined && width > 0 && width <= MAX_BORDER_WIDTH) this.style({ connector: { width } });
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
    const root = this.element;
    const visible = state.selectedIds.length > 0 && state.placement !== undefined;
    root.hidden = !visible;
    // A popover must never outlive the selection it was opened for.
    const selectionKey = state.selectedIds.join(" ");
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
    refs.borderGroup.hidden = !hasNode;
    refs.connectorGroup.hidden = !hasEdge;
    for (const { slot, forEdge } of COLOR_BUTTONS) {
      refs.colors[slot]!.host.hidden = forEdge ? !hasEdge : !hasNode;
    }

    refs.fontFamily.value = state.typography.fontFamily;
    refs.fontSize.value = String(state.typography.fontSize);
    for (const format of FORMATS) {
      refs.formats[format].setAttribute("aria-pressed", state.typography.format[format] === true ? "true" : "false");
    }
    refs.alignment.value = state.typography.alignment;
    refs.verticalAlign.value = state.typography.verticalAlign ?? "top";
    refs.lineHeight.value = state.typography.lineHeight === undefined ? "" : String(state.typography.lineHeight);
    for (const { slot } of COLOR_BUTTONS) {
      const color = normalizedHex(state.colors[slot]);
      refs.colorInputs[slot]!.value = color ?? "#000000";
      refs.colors[slot]!.button.setAttribute("data-color-unset", color === undefined ? "true" : "false");
      refs.colors[slot]!.button.style.setProperty?.("--miro-canvas-swatch", color ?? "transparent");
      this.renderSwatches(refs.colorSwatches[slot]!, slot, state.palette.map((entry) => entry.color), state.editable);
      this.renderSwatches(refs.colorRecent[slot]!, slot, state.recentColors, state.editable);
    }
    const shape = shapeCatalogEntry(state.shape);
    for (const item of SHAPE_CATALOG) {
      refs.shapeOptions[item.kind]!.setAttribute("aria-pressed", item === shape ? "true" : "false");
    }
    showShapeIcon(this.document!, refs.shape.button, shape ?? SHAPE_CATALOG[0]!, "▭");
    refs.borderStyle.value = state.borderStyle ?? "solid";
    refs.borderWidth.value = state.borderWidth === undefined ? "" : String(state.borderWidth);
    refs.route.value = state.connector?.route ?? "straight";
    refs.strokeStyle.value = state.connector?.strokeStyle ?? "solid";
    refs.startCap.value = state.connector?.startCap ?? "none";
    refs.endCap.value = state.connector?.endCap ?? "arrow";
    refs.connectorWidth.value = state.connector?.width === undefined ? "" : String(state.connector.width);

    refs.lock.textContent = state.locked ? "🔒" : "🔓";
    refs.lock.setAttribute("aria-pressed", state.locked ? "true" : "false");
    refs.lock.setAttribute("aria-label", state.locked ? "Unlock selection" : "Lock selection");
    refs.lock.disabled = state.reviewMode;
    for (const control of this.controls(refs)) {
      control.disabled = !state.editable;
    }
    const reason = state.editable ? undefined : state.blockedReason ?? "This selection is locked.";
    refs.status.hidden = reason === undefined;
    refs.status.textContent = reason ?? "";
  }

  /** Swatches are rebuilt only when the palette they show actually changed. */
  private renderSwatches(container: HTMLElement, slot: ColorSlot, colors: readonly string[], editable: boolean): void {
    const wanted = colors.map((color) => normalizedHex(color)).filter((color): color is string => color !== undefined);
    if (container.getAttribute("data-colors") !== wanted.join(",")) {
      container.setAttribute("data-colors", wanted.join(","));
      while (container.firstChild !== null) container.removeChild(container.firstChild);
      for (const color of wanted) {
        const button = append(container, makeButton(this.document!, "", color, "miro-canvas-toolbar__button--swatch"));
        button.setAttribute("data-color", color);
        button.style.setProperty?.("background-color", color);
        button.style.setProperty?.("--miro-canvas-swatch", color);
        this.listen(button, "click", () => this.appearance({ type: APPEARANCE_ACTIONS.setColor, slot, color }));
      }
    }
    for (const child of Array.from(container.children ?? []) as HTMLButtonElement[]) {
      child.disabled = !editable;
    }
  }

  private controls(refs: ToolbarRefs): readonly (HTMLButtonElement | HTMLInputElement | HTMLSelectElement)[] {
    return [
      ...Object.values(refs.shapeOptions),
      refs.fontFamily, refs.fontSize, refs.fontSizeDown, refs.fontSizeUp,
      ...FORMATS.map((format) => refs.formats[format]),
      refs.alignment, refs.verticalAlign, refs.lineHeight,
      ...Object.values(refs.colorInputs), ...Object.values(refs.colorClears),
      refs.borderStyle, refs.borderWidth,
      refs.route, refs.strokeStyle, refs.startCap, refs.endCap, refs.connectorWidth,
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
