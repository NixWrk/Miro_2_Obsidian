import { describe, expect, it } from "vitest";

import { APPEARANCE_ACTIONS, type AppearanceAction } from "../src/appearance";
import { CONNECTOR_CAPS, LOCAL_SHAPE_KINDS } from "../src/source-model";
import {
  SelectionToolbar,
  type SelectionStylePatch,
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

function optionValues(select: FakeElement): string[] {
  return descendants(select).filter((item) => item.tagName === "option").map((item) => item.value);
}

/** The panel a popover button owns is its sibling inside the popover host. */
function panelOf(root: FakeElement, buttonLabel: string): FakeElement {
  const host = byLabel(root, buttonLabel).parentElement!;
  return host.children.find((child) => child.className.includes("__panel"))!;
}

const TYPOGRAPHY = {
  fontFamily: "Inter",
  fontSize: 18,
  format: { bold: true, italic: false, underline: false, strike: false },
  alignment: "center",
  verticalAlign: "center",
} as const;

function build(overrides: Partial<SelectionToolbarState> = {}): {
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
  }, { document: new FakeDocument() as unknown as Document });
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
  it("keeps one compact row and hides every popover until it is opened", () => {
    const { root } = build();
    const bar = root.children.find((child) => child.className.includes("__bar"))!;
    // Shape, three color buttons, lock, the native menu's slot and overflow
    // sit beside one text group.
    expect(bar.children.length).toBeLessThanOrEqual(9);
    for (const panel of descendants(root).filter((item) => item.className.includes("__panel"))) {
      expect(panel.hidden).toBe(true);
    }
    expect(byLabel(root, "Shape").getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps a slot for the native Canvas menu between the lock and the overflow", () => {
    const { root, toolbar } = build();
    const bar = root.children.find((child) => child.className.includes("__bar"))!;
    const slot = toolbar.nativeSlot as unknown as FakeElement;
    expect(slot.className).toBe("miro-canvas-toolbar__native");
    const order = bar.children.map((child) => child.getAttribute("aria-label") ?? child.className);
    const slotIndex = bar.children.indexOf(slot);
    expect(order[slotIndex - 1]).toBe("Lock selection");
    expect(bar.children[slotIndex + 1]!.className).toContain("popover");
  });

  it("opens one popover at a time and closes it on Escape", () => {
    const { root } = build();
    byLabel(root, "Shape").dispatch("click");
    expect(panelOf(root, "Shape").hidden).toBe(false);
    byLabel(root, "More settings").dispatch("click");
    expect(panelOf(root, "Shape").hidden).toBe(true);
    expect(panelOf(root, "More settings").hidden).toBe(false);
    root.dispatch("keydown", { key: "Escape" });
    expect(panelOf(root, "More settings").hidden).toBe(true);
  });

  it("offers common shapes up front and the full Miro set behind More shapes", () => {
    const { root, styles } = build();
    byLabel(root, "Shape").dispatch("click");
    byLabel(root, "Rectangle").dispatch("click");
    expect(styles).toEqual([{ shape: "rectangle" }]);
    const all = byLabel(root, "All shapes");
    expect(all.hidden).toBe(true);
    byLabel(root, "More shapes").dispatch("click");
    expect(all.hidden).toBe(false);
    expect(optionValues(all).sort()).toEqual([...LOCAL_SHAPE_KINDS].sort());
  });

  it("keeps every connector cap available in the overflow menu", () => {
    const { root, styles } = build({ kinds: ["edge"], selectedIds: ["e1"] });
    expect(optionValues(byLabel(root, "Start cap"))).toEqual([...CONNECTOR_CAPS]);
    const endCap = byLabel(root, "End cap");
    endCap.value = "erd_many";
    endCap.dispatch("change");
    expect(styles).toEqual([{ connector: { endCap: "erd_many" } }]);
  });

  it("hides on an empty selection and when no placement is resolved", () => {
    const { root, update } = build();
    expect(root.hidden).toBe(false);
    expect(root.style.left).toBe("120px");
    update({ selectedIds: [] });
    expect(root.hidden).toBe(true);
    update({ placement: undefined });
    expect(root.hidden).toBe(true);
    update();
    expect(root.hidden).toBe(false);
  });

  it("closes an open popover when the selection is cleared or replaced", () => {
    const { root, update } = build();
    byLabel(root, "Shape").dispatch("click");
    expect(panelOf(root, "Shape").hidden).toBe(false);
    update({ selectedIds: [] });
    expect(panelOf(root, "Shape").hidden).toBe(true);
    update();
    byLabel(root, "Shape").dispatch("click");
    update({ selectedIds: ["n2"] });
    expect(panelOf(root, "Shape").hidden).toBe(true);
  });

  it("shows connector settings for an edge and shape settings for a node", () => {
    const { root, update } = build();
    const shapeHost = byLabel(root, "Shape").parentElement!;
    const connectorGroup = byLabel(root, "Connector route").parentElement!;
    const borderGroup = byLabel(root, "Border style").parentElement!;
    expect(shapeHost.hidden).toBe(false);
    expect(connectorGroup.hidden).toBe(true);
    expect(borderGroup.hidden).toBe(false);
    expect(byLabel(root, "Fill color").parentElement!.hidden).toBe(false);
    expect(byLabel(root, "Line color").parentElement!.hidden).toBe(true);
    update({ kinds: ["edge"], selectedIds: ["e1"] });
    expect(shapeHost.hidden).toBe(true);
    expect(connectorGroup.hidden).toBe(false);
    expect(borderGroup.hidden).toBe(true);
    expect(byLabel(root, "Fill color").parentElement!.hidden).toBe(true);
    expect(byLabel(root, "Line color").parentElement!.hidden).toBe(false);
  });

  it("reflects the selected element state", () => {
    const { root } = build({ shape: "hexagon", borderStyle: "dashed", borderWidth: 4 });
    expect(byLabel(root, "Font size").value).toBe("18");
    expect(byLabel(root, "Toggle bold").getAttribute("aria-pressed")).toBe("true");
    expect(byLabel(root, "Toggle italic").getAttribute("aria-pressed")).toBe("false");
    expect(byLabel(root, "Text alignment").value).toBe("center");
    expect(byLabel(root, "Fill color value").value).toBe("#abcdef");
    expect(byLabel(root, "Fill color").getAttribute("data-color-unset")).toBe("false");
    expect(byLabel(root, "Text color").getAttribute("data-color-unset")).toBe("true");
    expect(byLabel(root, "All shapes").value).toBe("hexagon");
    expect(byLabel(root, "Border style").value).toBe("dashed");
    expect(byLabel(root, "Border width").value).toBe("4");
  });

  it("emits appearance actions for typography and colors", () => {
    const { root, appearance } = build();
    byLabel(root, "Increase font size").dispatch("click");
    byLabel(root, "Decrease font size").dispatch("click");
    byLabel(root, "Toggle bold").dispatch("click");
    const fill = byLabel(root, "Fill color value");
    fill.value = "#123456";
    fill.dispatch("change");
    byLabel(root, "Clear fill color").dispatch("click");
    expect(appearance).toEqual([
      { type: APPEARANCE_ACTIONS.setFontSize, fontSize: 19 },
      { type: APPEARANCE_ACTIONS.setFontSize, fontSize: 17 },
      { type: APPEARANCE_ACTIONS.setFormat, format: { bold: false } },
      { type: APPEARANCE_ACTIONS.setColor, slot: "fill", color: "#123456" },
      { type: APPEARANCE_ACTIONS.setColor, slot: "fill", color: null },
    ]);
  });

  it("rejects an unsupported shape token and an out-of-range width", () => {
    const { root, styles } = build();
    const all = byLabel(root, "All shapes");
    all.value = "not_a_miro_shape";
    all.dispatch("change");
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
    expect(byLabel(root, "All shapes").disabled).toBe(true);
    byLabel(root, "Increase font size").dispatch("click");
    byLabel(root, "Rectangle").dispatch("click");
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
    // Swatches follow the palette without leaving stale buttons behind.
    update({ palette: [] });
    expect(palette.children).toHaveLength(0);
  });

  it("removes its listeners on dispose", () => {
    const { toolbar, root, appearance } = build();
    toolbar.dispose();
    byLabel(root, "Increase font size").dispatch("click");
    expect(appearance).toEqual([]);
  });
});
