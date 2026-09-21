/**
 * The board's creation tools, at the bottom of the view where native Canvas
 * keeps its own card menu: Miro's quick-access set of select, text, sticky
 * note, shape, connection line, comment and frame, and a "more" menu with a
 * code block, a web link and native Canvas's own cards.  A tool is armed by
 * its button or its letter and used once on the board; the host owns the
 * gesture and the creation.
 */
import { SHAPE_CATALOG, shapeCatalogEntry, shapeCatalogLabel } from "./shape-catalog";
import { shapePicture } from "./selection-toolbar";

export const QUICK_TOOLS = [
  "select", "text", "sticky", "shape", "pen", "highlighter", "smart", "eraser", "erase-part", "lasso",
  "connector", "comment", "frame", "code", "table", "link",
] as const;
export type QuickTool = (typeof QUICK_TOOLS)[number];

interface ToolSpec {
  readonly tool: QuickTool;
  readonly label: string;
  readonly icon: string;
  readonly glyph: string;
  /** The key that arms the tool, as Miro binds it. */
  readonly key?: string;
}

const BAR_TOOLS: readonly ToolSpec[] = [
  { tool: "select", label: "Select", icon: "mouse-pointer-2", glyph: "↖", key: "V" },
  // Next to Select: it is a way of selecting large parts of a board.
  { tool: "lasso", label: "Lasso", icon: "lasso", glyph: "◌" },
  { tool: "text", label: "Text", icon: "type", glyph: "T", key: "T" },
  { tool: "sticky", label: "Sticky note", icon: "sticky-note", glyph: "▢", key: "N" },
  { tool: "shape", label: "Shape", icon: "shapes", glyph: "◇", key: "S" },
  { tool: "pen", label: "Pen", icon: "pen", glyph: "✎", key: "P" },
  { tool: "connector", label: "Connection line", icon: "move-up-right", glyph: "↗", key: "L" },
  { tool: "comment", label: "Comment", icon: "message-circle", glyph: "💬", key: "C" },
  { tool: "frame", label: "Frame", icon: "frame", glyph: "#", key: "F" },
];

const MORE_TOOLS: readonly ToolSpec[] = [
  { tool: "code", label: "Code block", icon: "code-xml", glyph: "</>" },
  { tool: "table", label: "Grid", icon: "table", glyph: "▦" },
  { tool: "link", label: "Web link", icon: "link", glyph: "🔗" },
];

export interface QuickToolsState {
  /** False in review mode: nothing can be made. */
  readonly editable: boolean;
  readonly armed: QuickTool;
  /** The shape the shape tool makes. */
  readonly shape: string;
  /** What the pen draws with. */
  readonly penColor: string;
  readonly penWidth: number;
  /** How wide the erasers are, in screen pixels. */
  readonly eraserSize: number;
}

export interface QuickToolsActions {
  readonly onArm: (tool: QuickTool) => void;
  readonly onShape: (shape: string) => void;
  readonly onPen: (settings: { readonly color?: string; readonly width?: number; readonly eraserSize?: number }) => void;
}

/** What Miro keeps in a pen preset: its own colours and three thicknesses. */
export const PEN_COLORS = ["#1a1a1a", "#ffffff", "#f24726", "#ff9d48", "#ffd02f", "#67c6a0", "#2d9bf0", "#9b51e0"] as const;
/** The ranges the size slider covers: a line's width, an eraser's in pixels. */
export const PEN_WIDTH_RANGE = { min: 1, max: 60 } as const;
export const ERASER_SIZE_RANGE = { min: 8, max: 200 } as const;

const DRAWING_TOOLS: readonly ToolSpec[] = [
  { tool: "pen", label: "Pen", icon: "pen", glyph: "✎" },
  { tool: "highlighter", label: "Highlighter", icon: "highlighter", glyph: "▨" },
  { tool: "smart", label: "Smart drawing", icon: "wand-2", glyph: "✧" },
  { tool: "eraser", label: "Eraser", icon: "eraser", glyph: "⌫" },
  { tool: "erase-part", label: "Precision eraser", icon: "scissors", glyph: "✁" },
];

/** The largest sample the pen's row draws; a larger size is shown at this. */
const MAX_PREVIEW = 28;

/** Whether a tool is one of the pen's, which keep their panel open while armed. */
export function isDrawingTool(tool: QuickTool): boolean {
  return DRAWING_TOOLS.some((spec) => spec.tool === tool);
}

function isEraser(tool: QuickTool): boolean {
  return tool === "eraser" || tool === "erase-part";
}

export interface QuickToolsOptions {
  readonly document?: Document;
  readonly setIcon?: (element: HTMLElement, icon: string) => void;
}

/** The letter each tool answers to. */
export const QUICK_TOOL_KEYS: ReadonlyMap<string, QuickTool> = new Map(
  BAR_TOOLS.filter((spec) => spec.key !== undefined).map((spec) => [spec.key!, spec.tool]),
);

export class QuickTools {
  public readonly element: HTMLElement;
  /** Where the host puts native Canvas's own card buttons. */
  public readonly nativeSlot: HTMLElement;
  private readonly document: Document;
  private readonly buttons = new Map<QuickTool, HTMLButtonElement>();
  private readonly shapeButtons = new Map<string, HTMLButtonElement>();
  private readonly penColors = new Map<string, HTMLButtonElement>();
  private penButton: HTMLButtonElement | undefined;
  /** The pen's own row, open for as long as one of its tools is armed. */
  private drawingBar: HTMLElement | undefined;
  private colorRow: HTMLElement | undefined;
  private sizeInput: HTMLInputElement | undefined;
  private sizeNumber: HTMLInputElement | undefined;
  private sizePreview: HTMLElement | undefined;
  private armed: QuickTool = "select";
  /** The drawing tool the pen button goes back to. */
  private drawingTool: QuickTool = "pen";
  private readonly panels: { readonly button: HTMLButtonElement; readonly panel: HTMLElement }[] = [];
  private readonly listeners: (() => void)[] = [];
  private shownShape = "";

  public constructor(private readonly actions: QuickToolsActions, private readonly options: QuickToolsOptions = {}) {
    const document = options.document ?? globalThis.document;
    this.document = document;
    const root = this.make("div", "miro-canvas-toolbar miro-canvas-tools");
    root.setAttribute("role", "toolbar");
    root.setAttribute("aria-label", "Board tools");
    // Miro keeps the pen, the highlighter, smart drawing, the erasers and the
    // colour and size of the line in a row of their own, which stays open
    // while any of them is in use, so a colour or a size is one press away.
    const drawingBar = root.appendChild(this.make("div", "miro-canvas-toolbar__bar miro-canvas-tools__drawing"));
    drawingBar.hidden = true;
    for (const drawing of DRAWING_TOOLS) drawingBar.appendChild(this.toolButton(drawing));
    const colors = drawingBar.appendChild(this.make("span", "miro-canvas-tools__swatches"));
    for (const color of PEN_COLORS) {
      const option = colors.appendChild(this.make("button", "miro-canvas-toolbar__button miro-canvas-toolbar__button--swatch"));
      option.type = "button";
      option.setAttribute("aria-label", color);
      option.setAttribute("data-pen-color", color);
      option.style?.setProperty?.("--miro-canvas-swatch", color);
      this.listen(option, "click", () => this.actions.onPen({ color }));
      this.penColors.set(color, option);
    }
    // The size: a sample of it, a slider that acts as it moves, and the exact
    // number, which can be typed.
    const size = drawingBar.appendChild(this.make("span", "miro-canvas-tools__size"));
    const sizePreview = size.appendChild(this.make("span", "miro-canvas-tools__preview"));
    sizePreview.setAttribute("aria-hidden", "true");
    const sizeInput = size.appendChild(this.make("input", "miro-canvas-toolbar__range"));
    sizeInput.type = "range";
    sizeInput.step = "1";
    sizeInput.setAttribute("aria-label", "Line width");
    const sizeNumber = size.appendChild(this.make("input", "miro-canvas-toolbar__number miro-canvas-tools__number"));
    sizeNumber.type = "number";
    sizeNumber.step = "1";
    sizeNumber.setAttribute("aria-label", "Line width in points");
    const apply = (raw: string): void => {
      const range = isEraser(this.armed) ? ERASER_SIZE_RANGE : PEN_WIDTH_RANGE;
      const value = Number(raw);
      if (!Number.isFinite(value) || raw.trim() === "") return;
      const clamped = Math.min(Math.max(Math.round(value), range.min), range.max);
      this.actions.onPen(isEraser(this.armed) ? { eraserSize: clamped } : { width: clamped });
    };
    this.listen(sizeInput, "input", () => apply(sizeInput.value));
    // A typed number counts once it is complete: on Enter or on leaving the field.
    this.listen(sizeNumber, "change", () => apply(sizeNumber.value));
    this.listen(sizeNumber, "keydown", (event) => {
      if ((event as KeyboardEvent).key === "Enter") apply(sizeNumber.value);
      // The board's own letters must not fire while a number is typed.
      event.stopPropagation();
    });
    this.drawingBar = drawingBar;
    this.colorRow = colors;
    this.sizeInput = sizeInput;
    this.sizeNumber = sizeNumber;
    this.sizePreview = sizePreview;
    const bar = root.appendChild(this.make("div", "miro-canvas-toolbar__bar"));
    for (const spec of BAR_TOOLS) {
      if (spec.tool === "shape") {
        const host = bar.appendChild(this.make("span", "miro-canvas-toolbar__popover"));
        const button = host.appendChild(this.toolButton(spec));
        const panel = host.appendChild(this.panel(button, "miro-canvas-toolbar__panel--shapes"));
        const grid = panel.appendChild(this.make("div", "miro-canvas-toolbar__pictures miro-canvas-toolbar__pictures--shapes"));
        // The quick set Miro offers first; the selection toolbar has the rest.
        for (const entry of SHAPE_CATALOG.filter((item) => item.section === "basic")) {
          const option = grid.appendChild(this.make("button", "miro-canvas-toolbar__button miro-canvas-toolbar__button--picture"));
          option.type = "button";
          option.setAttribute("aria-label", shapeCatalogLabel(entry));
          option.setAttribute("data-shape", entry.kind);
          const picture = shapePicture(document, entry);
          if (picture !== undefined) option.appendChild(picture);
          else option.textContent = entry.name;
          this.listen(option, "click", () => {
            this.closePanels();
            this.actions.onShape(entry.kind);
            this.actions.onArm("shape");
          });
          this.shapeButtons.set(entry.kind, option);
        }
        continue;
      }
      if (spec.tool === "pen") {
        // The pen button wears the colour it will draw with and arms the
        // drawing tool last used, which opens the pen's row.
        const button = bar.appendChild(this.iconButton(`${spec.label}\n${spec.key}`, spec.icon, spec.glyph));
        button.setAttribute("data-tool-group", "drawing");
        this.listen(button, "click", () => this.actions.onArm(this.drawingTool));
        this.penButton = button;
        continue;
      }
      bar.appendChild(this.toolButton(spec));
    }
    const moreHost = bar.appendChild(this.make("span", "miro-canvas-toolbar__popover miro-canvas-tools__more"));
    const more = moreHost.appendChild(this.iconButton("More tools", "plus", "+"));
    const morePanel = moreHost.appendChild(this.panel(more, "miro-canvas-tools__menu"));
    for (const spec of MORE_TOOLS) {
      const item = morePanel.appendChild(this.toolButton(spec, true));
      this.listen(item, "click", () => this.closePanels());
    }
    this.nativeSlot = morePanel.appendChild(this.make("div", "miro-canvas-tools__native"));
    this.listen(this.nativeSlot, "click", () => this.closePanels());
    // The board must not start a drag or a selection under the bar.
    this.listen(root, "pointerdown", (event) => event.stopPropagation());
    this.listen(root, "keydown", (event) => {
      if ((event as KeyboardEvent).key === "Escape") this.closePanels();
    });
    this.element = root;
  }

  public update(state: QuickToolsState): void {
    this.element.setAttribute("data-miro-canvas-editable", state.editable ? "true" : "false");
    for (const [tool, button] of this.buttons) {
      button.setAttribute("aria-pressed", tool === state.armed ? "true" : "false");
      button.disabled = tool !== "select" && !state.editable;
    }
    for (const [kind, button] of this.shapeButtons) {
      button.setAttribute("aria-pressed", kind === state.shape ? "true" : "false");
    }
    for (const [color, button] of this.penColors) {
      button.setAttribute("aria-pressed", color === state.penColor ? "true" : "false");
    }
    // The pen button carries the colour it draws with, and stays marked while
    // any of the drawing tools is the armed one; so does the pen's row.
    this.armed = state.armed;
    const drawing = isDrawingTool(state.armed);
    if (drawing) this.drawingTool = state.armed;
    this.penButton?.style?.setProperty?.("--miro-canvas-swatch", state.penColor);
    this.penButton?.setAttribute("aria-pressed", drawing ? "true" : "false");
    if (this.drawingBar !== undefined) this.drawingBar.hidden = !drawing || !state.editable;
    // An eraser has a size but no colour; a line has both.
    const erasing = isEraser(state.armed);
    if (this.colorRow !== undefined) this.colorRow.hidden = erasing;
    if (this.sizeInput !== undefined && this.sizeNumber !== undefined) {
      const range = erasing ? ERASER_SIZE_RANGE : PEN_WIDTH_RANGE;
      const value = erasing ? state.eraserSize : state.penWidth;
      for (const input of [this.sizeInput, this.sizeNumber]) {
        input.min = String(range.min);
        input.max = String(range.max);
        if (input.value !== String(value) && this.document.activeElement !== input) input.value = String(value);
      }
      this.sizeInput.setAttribute("aria-label", erasing ? "Eraser size" : "Line width");
      this.sizeNumber.setAttribute("aria-label", erasing ? "Eraser size in pixels" : "Line width in points");
    }
    if (this.sizePreview !== undefined) {
      // The sample is drawn at its true size up to the room the row has.
      const value = erasing ? state.eraserSize : state.penWidth;
      const shown = Math.min(Math.max(value, 2), MAX_PREVIEW);
      this.sizePreview.setAttribute("data-kind", erasing ? "eraser" : "pen");
      this.sizePreview.setAttribute("data-clipped", value > MAX_PREVIEW ? "true" : "false");
      this.sizePreview.style?.setProperty?.("--miro-canvas-preview-size", `${shown}px`);
      this.sizePreview.style?.setProperty?.("--miro-canvas-preview-color", state.penColor);
    }
    const entry = shapeCatalogEntry(state.shape);
    const shapeButton = this.buttons.get("shape");
    if (entry !== undefined && shapeButton !== undefined && this.shownShape !== entry.kind) {
      // The button shows the shape it will make.
      const picture = shapePicture(this.document, entry);
      if (picture !== undefined) {
        while (shapeButton.firstChild !== null) shapeButton.removeChild(shapeButton.firstChild);
        shapeButton.appendChild(picture);
        this.shownShape = entry.kind;
      }
    }
    if (!state.editable) this.closePanels();
  }

  public closePanels(): void {
    for (const { button, panel } of this.panels) {
      panel.hidden = true;
      button.setAttribute("aria-expanded", "false");
    }
  }

  public dispose(): void {
    for (const remove of this.listeners.splice(0)) remove();
    this.element.remove();
  }

  private toolButton(spec: ToolSpec, withLabel = false): HTMLButtonElement {
    const label = spec.key === undefined ? spec.label : `${spec.label}\n${spec.key}`;
    const button = this.iconButton(label, spec.icon, spec.glyph);
    button.setAttribute("data-tool", spec.tool);
    button.setAttribute("aria-pressed", "false");
    if (withLabel) {
      button.classList.add("miro-canvas-tools__item");
      button.appendChild(this.make("span", "miro-canvas-tools__item-label", spec.label));
    }
    if (spec.tool !== "shape") this.listen(button, "click", () => this.actions.onArm(spec.tool));
    this.buttons.set(spec.tool, button);
    return button;
  }

  private iconButton(label: string, icon: string, glyph: string): HTMLButtonElement {
    const button = this.make("button", "miro-canvas-toolbar__button");
    button.type = "button";
    button.setAttribute("aria-label", label);
    button.setAttribute("data-tooltip-position", "top");
    let drawn = false;
    if (this.options.setIcon !== undefined) {
      try {
        this.options.setIcon(button, icon);
        drawn = true;
      } catch {
        drawn = false;
      }
    }
    if (!drawn) button.textContent = glyph;
    return button;
  }

  /** A menu that opens above its button; one at a time. */
  private panel(button: HTMLButtonElement, className: string): HTMLElement {
    const panel = this.make("div", `miro-canvas-toolbar__panel ${className}`);
    panel.hidden = true;
    button.setAttribute("aria-haspopup", "true");
    button.setAttribute("aria-expanded", "false");
    this.listen(button, "click", () => {
      const open = panel.hidden;
      this.closePanels();
      if (!open) return;
      panel.hidden = false;
      button.setAttribute("aria-expanded", "true");
    });
    this.panels.push({ button, panel });
    return panel;
  }

  private make<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const element = this.document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  private listen(target: EventTarget, type: string, handler: EventListener): void {
    target.addEventListener(type, handler);
    this.listeners.push(() => target.removeEventListener(type, handler));
  }
}
