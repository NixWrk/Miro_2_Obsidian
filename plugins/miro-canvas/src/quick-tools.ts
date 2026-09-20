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

export const QUICK_TOOLS = ["select", "text", "sticky", "shape", "connector", "comment", "frame", "code", "table", "link"] as const;
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
  { tool: "text", label: "Text", icon: "type", glyph: "T", key: "T" },
  { tool: "sticky", label: "Sticky note", icon: "sticky-note", glyph: "▢", key: "N" },
  { tool: "shape", label: "Shape", icon: "shapes", glyph: "◇", key: "S" },
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
}

export interface QuickToolsActions {
  readonly onArm: (tool: QuickTool) => void;
  readonly onShape: (shape: string) => void;
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
  private readonly panels: { readonly button: HTMLButtonElement; readonly panel: HTMLElement }[] = [];
  private readonly listeners: (() => void)[] = [];
  private shownShape = "";

  public constructor(private readonly actions: QuickToolsActions, private readonly options: QuickToolsOptions = {}) {
    const document = options.document ?? globalThis.document;
    this.document = document;
    const root = this.make("div", "miro-canvas-toolbar miro-canvas-tools");
    root.setAttribute("role", "toolbar");
    root.setAttribute("aria-label", "Board tools");
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
