import { describe, expect, it } from "vitest";

import { APPEARANCE_ACTIONS, type AppearanceAction } from "../src/appearance";
import { FRAME_COLORS } from "../src/miro-palette";
import { SHAPE_CATALOG } from "../src/shape-catalog";
import { CONNECTOR_CAPS } from "../src/source-model";
import {
  SelectionToolbar,
  type SelectionStylePatch,
  type SelectionToolbarOptions,
  type SelectionToolbarState,
} from "../src/selection-toolbar";

class FakeElement {
  public readonly nodeType = 1;
  public readonly children: FakeElement[] = [];
  public readonly attributes = new Map<string, string>();
  public readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  public readonly style: Record<string, string> = {};
  public parentNode: FakeElement | undefined;
  public textContent = "";
  public className = "";
  public value = "";
  public label = "";
  public title = "";
  public type = "";
  public min = "";
  public max = "";
  public step = "";
  public hidden = false;
  public disabled = false;

  public constructor(public readonly tagName: string) {}

  public get parentElement(): FakeElement | null {
    return this.parentNode ?? null;
  }

  public get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  public appendChild(child: FakeElement): FakeElement {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  public removeChild(child: FakeElement): FakeElement {
    this.children.splice(this.children.indexOf(child), 1);
    child.parentNode = undefined;
    return child;
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  public addEventListener(name: string, listener: (event: unknown) => void): void {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  public removeEventListener(name: string, listener: (event: unknown) => void): void {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter((item) => item !== listener));
  }

  public dispatch(name: string, props: Record<string, unknown> = {}): void {
    for (const listener of [...(this.listeners.get(name) ?? [])]) {
      listener({ type: name, target: this, ...props });
    }
  }

  public remove(): void {
    this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = undefined;
  }
}

class FakeDocument {
  public createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }

  public createElementNS(_namespace: string, tagName: string): FakeElement {
    return new FakeElement(tagName);
  }
}

function descendants(root: FakeElement): FakeElement[] {
  return [root, ...root.children.flatMap((child) => descendants(child))];
}

function byLabel(root: FakeElement, label: string): FakeElement {
  const matches = descendants(root).filter((item) => item.attributes.get("aria-label") === label);
  if (matches.length !== 1) {
    throw new Error(`expected one control labelled ${label}, found ${matches.length}`);
  }
  return matches[0]!;
}

/** The panel a popover button owns is its sibling inside the popover host. */
function panelOf(root: FakeElement, buttonLabel: string): FakeElement {
  const host = byLabel(root, buttonLabel).parentElement!;
  return host.children.find((child) => child.className.includes("__panel"))!;
}

/** The control with a label inside one popover. */
function inPanel(root: FakeElement, popover: string, label: string): FakeElement {
  const matches = descendants(panelOf(root, popover)).filter((item) => item.attributes.get("aria-label") === label);
  if (matches.length !== 1) throw new Error(`expected one ${label} in ${popover}, found ${matches.length}`);
  return matches[0]!;
}

/** The choice carrying a value inside one popover. */
function choice(root: FakeElement, popover: string, value: string): FakeElement {
  const matches = descendants(panelOf(root, popover)).filter((item) => item.attributes.get("data-value") === value);
  if (matches.length !== 1) throw new Error(`expected one ${value} in ${popover}, found ${matches.length}`);
  return matches[0]!;
}

function pressed(root: FakeElement, popover: string): string[] {
  return descendants(panelOf(root, popover))
    .filter((item) => item.attributes.has("data-value") && item.attributes.get("aria-pressed") === "true")
    .map((item) => item.attributes.get("data-value")!);
}

function shapeOption(root: FakeElement, kind: string): FakeElement {
  const matches = descendants(root).filter((item) => item.attributes.get("data-shape") === kind);
  if (matches.length !== 1) throw new Error(`expected one option for ${kind}, found ${matches.length}`);
  return matches[0]!;
}

function pressedShapes(root: FakeElement): string[] {
  return descendants(root)
    .filter((item) => item.attributes.has("data-shape") && item.attributes.get("aria-pressed") === "true")
    .map((item) => item.attributes.get("data-shape")!);
}

/** A control is on screen when neither it nor anything it sits in is hidden. */
function shown(element: FakeElement): boolean {
  for (let item: FakeElement | undefined = element; item !== undefined; item = item.parentNode) {
    if (item.hidden) return false;
  }
  return true;
}

const TYPOGRAPHY = {
  fontFamily: "Inter",
  fontSize: 18,
  format: { bold: true, italic: false, underline: false, strike: false },
  alignment: "center",
  verticalAlign: "center",
} as const;

const EDGE = { kinds: ["edge"], selectedIds: ["e1"] } as const;

function build(overrides: Partial<SelectionToolbarState> = {}, options: SelectionToolbarOptions = {}): {
  readonly toolbar: SelectionToolbar;
  readonly root: FakeElement;
  readonly appearance: AppearanceAction[];
  readonly styles: SelectionStylePatch[];
  readonly locks: boolean[];
  readonly update: (patch?: Partial<SelectionToolbarState>) => void;
} {
  const appearance: AppearanceAction[] = [];
  const styles: SelectionStylePatch[] = [];
  const locks: boolean[] = [];
  const toolbar = new SelectionToolbar({
    onAppearance: (action) => { appearance.push(action); },
    onStyle: (patch) => { styles.push(patch); },
    onLock: (locked) => { locks.push(locked); },
  }, { document: new FakeDocument() as unknown as Document, ...options });
  const base: SelectionToolbarState = {
    selectedIds: ["n1"],
    kinds: ["shape"],
    editable: true,
    locked: false,
    reviewMode: false,
    typography: TYPOGRAPHY,
    colors: { fill: "#abcdef" },
    palette: [{ id: "miro-red", label: "Red", color: "#f24726", source: "miro" }],
    recentColors: ["#123456"],
    placement: { x: 120, y: 40 },
    ...overrides,
  };
  const update = (patch: Partial<SelectionToolbarState> = {}): void => toolbar.update({ ...base, ...patch });
  update();
  return { toolbar, root: toolbar.element as unknown as FakeElement, appearance, styles, locks, update };
}

describe("selection toolbar", () => {
  it("edits head size independently and rejects invalid or read-only changes", () => {
    const {root, styles, update} = build({...EDGE});
    const input = byLabel(root, "Arrowhead size");
    expect(input.value).toBe("");
    for (const value of ["", "0", "1001", "NaN"]) {input.value=value;input.dispatch("change");}
    expect(styles).toEqual([]);
    input.value="18.5";input.dispatch("change");
    expect(styles).toEqual([{connector:{headSize:18.5}}]);
    update({connector:{width:50,headSize:18.5}});
    expect(input.value).toBe("18.5");
    update({editable:false, connector:{headSize:18.5}});
    expect(input.disabled).toBe(true);
    input.value="30";input.dispatch("change");
    expect(styles).toHaveLength(1);
  });
  it("keeps one compact row and hides every popover until it is opened", () => {
    const { root } = build();
    const bar = root.children.find((child) => child.className.includes("__bar"))!;
    // Shape, the text group, the connector group, the colour group, the link
    // opener, the layer menu, the lock and the native menu's slot.
    expect(bar.children.length).toBeLessThanOrEqual(8);
    for (const panel of descendants(root).filter((item) => item.className.includes("__panel"))) {
      expect(panel.hidden).toBe(true);
    }
    expect(byLabel(root, "Shape").getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps a slot for the native Canvas menu right after the lock", () => {
    const { root, toolbar } = build();
    const bar = root.children.find((child) => child.className.includes("__bar"))!;
    const slot = toolbar.nativeSlot as unknown as FakeElement;
    expect(slot.className).toBe("miro-canvas-toolbar__native");
    const slotIndex = bar.children.indexOf(slot);
    expect(bar.children[slotIndex - 1]!.getAttribute("aria-label")).toBe("Lock selection");
    expect(slotIndex).toBe(bar.children.length - 1);
  });

  it("draws interface icons through the host and falls back to glyphs", () => {
    const drawn: string[] = [];
    const { root } = build({}, {
      setIcon: (element, icon) => {
        drawn.push(icon);
        (element as unknown as FakeElement).textContent = "";
      },
    });
    for (const icon of ["bold", "italic", "align-center", "align-vertical-justify-end", "baseline", "arrow-left-right", "lock-open", "chevron-up", "ban"]) {
      expect(drawn, icon).toContain(icon);
    }
    expect(byLabel(root, "Text style").getAttribute("data-icon")).toBe("bold");
    expect(byLabel(root, "Text style").textContent).toBe("");
    const plain = build();
    expect(byLabel(plain.root, "Text style").textContent).toBe("B");
    expect(byLabel(plain.root, "Lock selection").textContent).toBe("🔓");
  });

  it("opens one popover at a time and closes it on Escape", () => {
    const { root } = build();
    byLabel(root, "Shape").dispatch("click");
    expect(panelOf(root, "Shape").hidden).toBe(false);
    byLabel(root, "Alignment").dispatch("click");
    expect(panelOf(root, "Shape").hidden).toBe(true);
    expect(panelOf(root, "Alignment").hidden).toBe(false);
    root.dispatch("keydown", { key: "Escape" });
    expect(panelOf(root, "Alignment").hidden).toBe(true);
  });

  it("offers every shape once, as a picture named on hover", () => {
    const { root, styles } = build();
    byLabel(root, "Shape").dispatch("click");
    const panel = panelOf(root, "Shape");
    const options = descendants(panel).filter((item) => item.attributes.has("data-shape"));
    expect(options.map((item) => item.attributes.get("data-shape"))).toEqual(SHAPE_CATALOG.map((item) => item.kind));
    expect(descendants(panel).filter((item) => item.className === "miro-canvas-toolbar__heading")
      .map((item) => item.textContent)).toEqual(["Basic", "Flowchart"]);
    for (const option of options) {
      // Only a picture is shown; the words are hover text.
      expect(option.textContent).toBe("");
      const icon = option.children[0]!;
      expect(icon.tagName).toBe("svg");
      expect(icon.children[0]!.getAttribute("d")).toMatch(/^M/u);
      expect(option.getAttribute("data-tooltip-delay")).not.toBeNull();
    }
    // A basic shape's hover text carries what it means in a flowchart.
    expect(byLabel(root, "Rhombus\nDecision: a question that branches the flow")).toBe(shapeOption(root, "rhombus"));
    expect(shapeOption(root, "star").getAttribute("aria-label")).toBe("Star");
    expect(descendants(panel).some((item) => item.attributes.get("data-shape") === "flow_chart_decision")).toBe(false);
    shapeOption(root, "rectangle").dispatch("click");
    shapeOption(root, "flow_chart_terminator").dispatch("click");
    expect(styles).toEqual([{ shape: "rectangle" }, { shape: "flow_chart_terminator" }]);
    expect(panel.hidden).toBe(false);
  });

  it("marks the picture a node shows, whichever name the node uses for it", () => {
    const { root, styles, update } = build({ shape: "flow_chart_decision" });
    expect(pressedShapes(root)).toEqual(["rhombus"]);
    const button = byLabel(root, "Shape");
    expect(button.children[0]!.getAttribute("class")).toContain("miro-canvas-shape-icon");
    expect(button.getAttribute("data-picture")).toBe("rhombus");
    // Picking the picture the node already shows writes nothing.
    shapeOption(root, "rhombus").dispatch("click");
    expect(styles).toEqual([]);
    update({ shape: "ellipse" });
    expect(pressedShapes(root)).toEqual(["circle"]);
    expect(button.getAttribute("data-picture")).toBe("circle");
    expect(button.children).toHaveLength(1);
    update({ shape: undefined });
    expect(pressedShapes(root)).toEqual([]);
  });

  it("shows a node's row for a node and a connector's row for a connector", () => {
    const { root, update } = build();
    const visible = (label: string): boolean => shown(byLabel(root, label));
    expect(["Shape", "Font", "Text style", "Alignment", "Text color", "Fill color", "Border"].every(visible)).toBe(true);
    expect(["Line start", "Swap line ends", "Line end", "Line", "Line color"].some(visible)).toBe(false);
    update(EDGE);
    expect(["Line start", "Swap line ends", "Line end", "Line", "Line color", "Lock selection"].every(visible)).toBe(true);
    expect(["Shape", "Font", "Text style", "Alignment", "Text color", "Fill color", "Border"].some(visible)).toBe(false);
    update({ kinds: ["text"] });
    expect(visible("Shape")).toBe(false);
    expect(visible("Font")).toBe(true);
  });

  it("sets text style, alignment and font from pictures and shows the current ones", () => {
    const { root, appearance } = build();
    expect(pressed(root, "Text style")).toEqual(["bold"]);
    expect(byLabel(root, "Text style").getAttribute("data-active")).toBe("true");
    expect(pressed(root, "Alignment")).toEqual(["center", "center"]);
    expect(byLabel(root, "Alignment").getAttribute("data-icon")).toBe("align-center");
    expect(pressed(root, "Font")).toEqual(["Inter"]);
    expect(byLabel(root, "Font").textContent).toBe("Inter");
    byLabel(root, "Italic").dispatch("click");
    byLabel(root, "Bold").dispatch("click");
    byLabel(root, "Align right").dispatch("click");
    byLabel(root, "Align bottom").dispatch("click");
    choice(root, "Font", "Georgia").dispatch("click");
    expect(appearance).toEqual([
      { type: APPEARANCE_ACTIONS.setFormat, format: { italic: true } },
      { type: APPEARANCE_ACTIONS.setFormat, format: { bold: false } },
      { type: APPEARANCE_ACTIONS.setAlignment, alignment: "right" },
      { type: APPEARANCE_ACTIONS.setTypography, typography: { verticalAlign: "bottom" } },
      { type: APPEARANCE_ACTIONS.setFontFamily, fontFamily: "Georgia" },
    ]);
  });

  it("reflects the selected element state", () => {
    const { root } = build({ shape: "hexagon", borderStyle: "dashed", borderWidth: 4 });
    expect(byLabel(root, "Font size").value).toBe("18");
    expect(byLabel(root, "Custom fill color").value).toBe("#abcdef");
    expect(byLabel(root, "Fill color").getAttribute("data-color-unset")).toBe("false");
    expect(byLabel(root, "Text color").getAttribute("data-color-unset")).toBe("true");
    expect(pressedShapes(root)).toEqual(["hexagon"]);
    expect(pressed(root, "Border")).toContain("dashed");
    expect(byLabel(root, "Border width").value).toBe("4");
  });

  it("emits appearance actions for size and colours", () => {
    const { root, appearance } = build();
    byLabel(root, "Increase font size").dispatch("click");
    byLabel(root, "Decrease font size").dispatch("click");
    const fill = byLabel(root, "Custom fill color");
    fill.value = "#123456";
    fill.dispatch("change");
    inPanel(root, "Fill color", "Transparent").dispatch("click");
    inPanel(root, "Border", "Transparent").dispatch("click");
    expect(appearance).toEqual([
      { type: APPEARANCE_ACTIONS.setFontSize, fontSize: 19 },
      { type: APPEARANCE_ACTIONS.setFontSize, fontSize: 17 },
      { type: APPEARANCE_ACTIONS.setColor, slot: "fill", color: "#123456" },
      { type: APPEARANCE_ACTIONS.setColor, slot: "fill", color: null },
      { type: APPEARANCE_ACTIONS.setColor, slot: "border", color: null },
    ]);
  });

  it("leads every palette with Obsidian's own colour and marks it while nothing is set", () => {
    const { root, appearance, update } = build({ colors: { fill: "#abcdef", border: null } });
    for (const popover of ["Text color", "Fill color", "Border"]) {
      inPanel(root, popover, "Obsidian color").dispatch("click");
    }
    update({ ...EDGE, colors: {} });
    inPanel(root, "Line color", "Obsidian color").dispatch("click");
    expect(appearance).toEqual([
      { type: APPEARANCE_ACTIONS.resetColor, slot: "text" },
      { type: APPEARANCE_ACTIONS.resetColor, slot: "fill" },
      { type: APPEARANCE_ACTIONS.resetColor, slot: "border" },
      { type: APPEARANCE_ACTIONS.resetColor, slot: "edge" },
    ]);
    update({ colors: { fill: "#abcdef", border: null } });
    const pressedIn = (popover: string, label: string) => inPanel(root, popover, label).getAttribute("aria-pressed");
    expect(pressedIn("Text color", "Obsidian color")).toBe("true");
    expect(pressedIn("Fill color", "Obsidian color")).toBe("false");
    expect(pressedIn("Border", "Obsidian color")).toBe("false");
    expect(pressedIn("Border", "Transparent")).toBe("true");
    expect(byLabel(root, "Text color").getAttribute("data-color-origin")).toBe("obsidian");
    expect(byLabel(root, "Fill color").getAttribute("data-color-origin")).toBe("board");
    // A transparent line or text would only hide the element.
    expect(inPanel(root, "Text color", "Transparent").hidden).toBe(true);
    expect(inPanel(root, "Line color", "Transparent").hidden).toBe(true);
    expect(inPanel(root, "Fill color", "Transparent").hidden).toBe(false);
  });

  it("sets a border's style from pictures and its width from a slider", () => {
    const { root, styles } = build();
    expect(pressed(root, "Border")).toContain("solid");
    choice(root, "Border", "dotted").dispatch("click");
    const width = byLabel(root, "Border width");
    width.value = "6";
    width.dispatch("input");
    expect(styles).toEqual([{ borderStyle: "dotted" }]);
    const value = descendants(panelOf(root, "Border")).find((item) => item.className === "miro-canvas-toolbar__value")!;
    expect(value.textContent).toBe("6");
    width.dispatch("change");
    expect(styles).toEqual([{ borderStyle: "dotted" }, { borderWidth: 6 }]);
  });

  it("offers every line end as a picture at either end", () => {
    const { root, styles } = build(EDGE);
    for (const popover of ["Line start", "Line end"]) {
      const options = descendants(panelOf(root, popover)).filter((item) => item.attributes.has("data-value"));
      expect(options.map((item) => item.attributes.get("data-value"))).toEqual([...CONNECTOR_CAPS]);
      for (const option of options) expect(option.children[0]!.tagName).toBe("svg");
    }
    expect(choice(root, "Line start", "erd_zero_or_many").getAttribute("aria-label"))
      .toBe("Zero or many\nEntity relationship: any number, possibly none");
    choice(root, "Line start", "filled_diamond").dispatch("click");
    choice(root, "Line end", "none").dispatch("click");
    expect(styles).toEqual([
      { connector: { startCap: "filled_diamond" } },
      { connector: { endCap: "none" } },
    ]);
  });

  it("shows a connector's ends on their buttons and swaps them", () => {
    const { root, styles, update } = build({ ...EDGE, connector: { startCap: "erd_many", endCap: "none" } });
    expect(byLabel(root, "Line start").getAttribute("data-picture")).toBe("start:erd_many");
    expect(byLabel(root, "Line end").getAttribute("data-picture")).toBe("end:none");
    expect(pressed(root, "Line start")).toEqual(["erd_many"]);
    byLabel(root, "Swap line ends").dispatch("click");
    expect(styles).toEqual([{ connector: { startCap: "none", endCap: "erd_many" } }]);
    // Without its own ends a connector shows an arrow at the end only.
    update({ connector: undefined });
    expect(byLabel(root, "Line end").getAttribute("data-picture")).toBe("end:arrow");
    byLabel(root, "Swap line ends").dispatch("click");
    expect(styles[1]).toEqual({ connector: { startCap: "arrow", endCap: "none" } });
    update({ connector: { startCap: "arrow", endCap: "arrow" } });
    byLabel(root, "Swap line ends").dispatch("click");
    expect(styles).toHaveLength(2);
  });

  it("picks the kind of line, its dash and its thickness", () => {
    const { root, styles, update } = build(EDGE);
    expect(pressed(root, "Line")).toEqual(["curved", "solid"]);
    expect(byLabel(root, "Line").getAttribute("data-picture")).toBe("route:curved");
    byLabel(root, "Elbowed line").dispatch("click");
    byLabel(root, "Dashed line").dispatch("click");
    const width = byLabel(root, "Line thickness");
    width.value = "5";
    width.dispatch("change");
    width.value = "0";
    width.dispatch("change");
    expect(styles).toEqual([
      { connector: { route: "elbowed" } },
      { connector: { strokeStyle: "dashed" } },
      { connector: { width: 5 } },
    ]);
    update({ connector: { route: "straight", strokeStyle: "dotted", width: 3 } });
    expect(pressed(root, "Line")).toEqual(["straight", "dotted"]);
    expect(byLabel(root, "Line").getAttribute("data-picture")).toBe("route:straight");
    expect(width.value).toBe("3");
  });

  it("marks no picture for an unsupported shape token and rejects an out-of-range width", () => {
    const { root, styles } = build({ shape: "not_a_miro_shape" as never });
    expect(pressedShapes(root)).toEqual([]);
    expect(byLabel(root, "Shape").getAttribute("data-picture")).toBe("rectangle");
    const border = byLabel(root, "Border width");
    border.value = "1000";
    border.dispatch("change");
    expect(styles).toEqual([]);
  });

  it("keeps the lock toggle live on a locked selection while everything else is inert", () => {
    const { root, appearance, styles, locks, update } = build({
      editable: false, locked: true, blockedReason: "This selection is locked.",
    });
    const lock = byLabel(root, "Unlock selection");
    expect(lock.disabled).toBe(false);
    expect(lock.getAttribute("aria-pressed")).toBe("true");
    expect(shapeOption(root, "rectangle").disabled).toBe(true);
    expect(byLabel(root, "Swap line ends").disabled).toBe(true);
    byLabel(root, "Increase font size").dispatch("click");
    shapeOption(root, "rectangle").dispatch("click");
    byLabel(root, "Italic").dispatch("click");
    expect(appearance).toEqual([]);
    expect(styles).toEqual([]);
    lock.dispatch("click");
    expect(locks).toEqual([false]);
    const status = descendants(root).find((item) => item.attributes.get("role") === "status")!;
    expect(status.hidden).toBe(false);
    expect(status.textContent).toBe("This selection is locked.");
    update({ editable: false, locked: false, reviewMode: true, blockedReason: "Review mode is on." });
    expect(byLabel(root, "Lock selection").disabled).toBe(true);
  });

  it("shows the palette and recent colors inside the color popover", () => {
    const { root, appearance, update } = build();
    const panel = panelOf(root, "Fill color");
    const palette = descendants(panel).find((item) => item.attributes.get("data-color-palette") === "fill")!;
    const recent = descendants(panel).find((item) => item.attributes.get("data-color-recent") === "fill")!;
    expect(palette.children.map((item) => item.attributes.get("data-color"))).toEqual(["#f24726"]);
    expect(recent.children.map((item) => item.attributes.get("data-color"))).toEqual(["#123456"]);
    palette.children[0]!.dispatch("click");
    expect(appearance).toEqual([{ type: APPEARANCE_ACTIONS.setColor, slot: "fill", color: "#f24726" }]);
    // The colour the element has is the pressed swatch.
    update({ colors: { fill: "#f24726" } });
    expect(palette.children[0]!.getAttribute("aria-pressed")).toBe("true");
    // Swatches follow the palette without leaving stale buttons behind.
    update({ palette: [], recentColors: [] });
    expect(palette.children).toHaveLength(0);
    expect(recent.hidden).toBe(true);
  });

  it("offers a note Miro's sticky colours by name, for its fill only", () => {
    const { root } = build({
      kinds: ["sticky"],
      fillPalette: [{ id: "miro-sticky-yellow", label: "Yellow", color: "#ffe86d", source: "miro" }],
    });
    const swatches = (slot: string) => descendants(root)
      .find((item) => item.attributes.get("data-color-palette") === slot)!.children;
    expect(swatches("fill").map((item) => item.attributes.get("data-color"))).toEqual(["#ffe86d"]);
    expect(swatches("fill")[0]!.getAttribute("aria-label")).toBe("Yellow\n#ffe86d");
    expect(swatches("text").map((item) => item.attributes.get("data-color"))).toEqual(["#f24726"]);
  });

  it("offers a frame its quiet, see-through fills, and shows the picked one without its transparency", () => {
    const { root } = build({
      kinds: ["frame"],
      colors: { fill: "#6cbf8f38" },
      fillPalette: FRAME_COLORS.map((entry) => ({ id: entry.token, label: entry.label, color: entry.color, source: "miro" as const })),
    });
    const fill = descendants(root).find((item) => item.attributes.get("data-color-palette") === "fill")!.children;
    expect(fill).toHaveLength(FRAME_COLORS.length);
    expect(FRAME_COLORS.every((entry) => /^#[0-9a-f]{6}38$/u.test(entry.color))).toBe(true);
    expect(fill.find((item) => item.attributes.get("data-color") === "#6cbf8f38")!.getAttribute("aria-pressed")).toBe("true");
    const picker = descendants(root).find((item) => item.getAttribute("aria-label") === "Custom fill color") as unknown as { value: string };
    expect(picker.value).toBe("#6cbf8f");
  });

  it("opens a selected link from its own button, even in review mode", () => {
    const opened: number[] = [];
    const toolbar = new SelectionToolbar({
      onAppearance: () => undefined,
      onStyle: () => undefined,
      onLock: () => undefined,
      onOpenLink: () => { opened.push(1); },
    }, { document: new FakeDocument() as unknown as Document });
    const root = toolbar.element as unknown as FakeElement;
    const state: SelectionToolbarState = {
      selectedIds: ["link"], kinds: ["media"], editable: false, locked: false, reviewMode: true,
      typography: TYPOGRAPHY, colors: {}, palette: [], recentColors: [], placement: { x: 0, y: 0 },
    };
    toolbar.update(state);
    const open = descendants(root).find((item) => item.className.includes("--open-link"))!;
    expect(shown(open)).toBe(false);
    toolbar.update({ ...state, link: "https://example.test/page" });
    expect(shown(open)).toBe(true);
    expect(open.getAttribute("aria-label")).toBe("Open link\nhttps://example.test/page");
    expect(open.disabled).toBe(false);
    open.dispatch("click");
    expect(opened).toEqual([1]);
    // A link has no text of its own to format.
    expect(shown(byLabel(root, "Font"))).toBe(false);
  });

  it("shows the layer menu only when onLayer is given and a card is selected", () => {
    const withoutHandler = build({ kinds: ["shape"] });
    expect(shown(byLabel(withoutHandler.root, "Layer"))).toBe(false);

    const layers: string[] = [];
    const toolbar = new SelectionToolbar({
      onAppearance: () => undefined,
      onStyle: () => undefined,
      onLock: () => undefined,
      onLayer: (direction) => { layers.push(direction); },
    }, { document: new FakeDocument() as unknown as Document });
    const root = toolbar.element as unknown as FakeElement;
    const state: SelectionToolbarState = {
      selectedIds: ["e1"], kinds: ["edge"], editable: true, locked: false, reviewMode: false,
      typography: TYPOGRAPHY, colors: {}, palette: [], recentColors: [], placement: { x: 0, y: 0 },
    };
    toolbar.update(state);
    // A line or a frame alone has no layer to move.
    expect(shown(byLabel(root, "Layer"))).toBe(false);
    toolbar.update({ ...state, kinds: ["frame"] });
    expect(shown(byLabel(root, "Layer"))).toBe(false);
    toolbar.update({ ...state, kinds: ["edge", "shape"] });
    expect(shown(byLabel(root, "Layer"))).toBe(true);
  });

  it("moves a card with a layer command and closes the popover afterward", () => {
    const layers: string[] = [];
    const toolbar = new SelectionToolbar({
      onAppearance: () => undefined,
      onStyle: () => undefined,
      onLock: () => undefined,
      onLayer: (direction) => { layers.push(direction); },
    }, { document: new FakeDocument() as unknown as Document });
    const root = toolbar.element as unknown as FakeElement;
    toolbar.update({
      selectedIds: ["n1"], kinds: ["shape"], editable: true, locked: false, reviewMode: false,
      typography: TYPOGRAPHY, colors: {}, palette: [], recentColors: [], placement: { x: 0, y: 0 },
    });
    byLabel(root, "Layer").dispatch("click");
    expect(panelOf(root, "Layer").hidden).toBe(false);
    choice(root, "Layer", "forward").dispatch("click");
    expect(layers).toEqual(["forward"]);
    expect(panelOf(root, "Layer").hidden).toBe(true);
  });

  it("disables the layer buttons on a selection that cannot be edited", () => {
    const toolbar = new SelectionToolbar({
      onAppearance: () => undefined,
      onStyle: () => undefined,
      onLock: () => undefined,
      onLayer: () => undefined,
    }, { document: new FakeDocument() as unknown as Document });
    const root = toolbar.element as unknown as FakeElement;
    toolbar.update({
      selectedIds: ["n1"], kinds: ["shape"], editable: false, locked: true, reviewMode: false,
      blockedReason: "This selection is locked.",
      typography: TYPOGRAPHY, colors: {}, palette: [], recentColors: [], placement: { x: 0, y: 0 },
    });
    for (const value of ["front", "forward", "backward", "back"]) {
      expect(choice(root, "Layer", value).disabled).toBe(true);
    }
  });

  it("removes its listeners on dispose", () => {
    const { toolbar, root, appearance } = build();
    toolbar.dispose();
    byLabel(root, "Increase font size").dispatch("click");
    expect(appearance).toEqual([]);
  });
});
