import { describe, expect, it } from "vitest";

import { APPEARANCE_ACTIONS, normalizeAppearanceState } from "../src/appearance";
import { M1Controls, type M1ControlsActions, type M1ControlsState, type M1NavigationAction } from "../src/m1-controls";

class FakeElement {
  public readonly nodeType = 1;
  public readonly children: FakeElement[] = [];
  public readonly attributes = new Map<string, string>();
  public readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  public readonly dataset: Record<string, string> = {};
  public readonly style: Record<string, string> = {};
  public parentNode: FakeElement | undefined;
  public textContent = "";
  public className = "";
  public type = "";
  public disabled = false;
  public hidden = false;
  public tabIndex = 0;
  public width = 0;
  public height = 0;

  public constructor(public readonly tagName: string) {}
  public get firstChild(): FakeElement | null { return this.children[0] ?? null; }
  public get parentElement(): FakeElement | null { return this.parentNode ?? null; }
  public appendChild(child: FakeElement): FakeElement { child.parentNode = this; this.children.push(child); return child; }
  public removeChild(child: FakeElement): FakeElement { this.children.splice(this.children.indexOf(child), 1); child.parentNode = undefined; return child; }
  public remove(): void { this.parentNode?.removeChild(this); }
  public setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  public getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  public addEventListener(name: string, listener: (event: unknown) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  public removeEventListener(name: string, listener: (event: unknown) => void): void {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter((item) => item !== listener));
  }
  public dispatch(name: string, props: Record<string, unknown> = {}): void {
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener({ type: name, target: this, ...props });
  }
  public focus(): void {}
}

class FakeDocument {
  public readonly body = new FakeElement("body");
  public createElement(tagName: string): FakeElement { return new FakeElement(tagName); }
  public createTextNode(value: string): FakeElement { const node = new FakeElement("#text"); node.textContent = value; return node; }
}

function descendants(root: FakeElement): FakeElement[] {
  return [root, ...root.children.flatMap((child) => descendants(child))];
}

function byLabel(root: FakeElement, label: string): FakeElement {
  const found = descendants(root).filter((item) => item.attributes.get("aria-label") === label);
  if (found.length !== 1) throw new Error(`expected one ${label}, found ${found.length}`);
  return found[0]!;
}

function row(root: FakeElement, text: string): FakeElement {
  const found = descendants(root).filter((item) => item.className === "miro-canvas-dock__item"
    && descendants(item).some((child) => child.textContent === text));
  if (found.length !== 1) throw new Error(`expected one row ${text}, found ${found.length}`);
  return found[0]!;
}

function menu(root: FakeElement, name: string): FakeElement {
  return descendants(root).find((item) => item.className.includes(`miro-canvas-dock__menu--${name}`))!;
}

/** Shown when neither it nor anything it sits in is hidden. */
function shown(element: FakeElement): boolean {
  for (let item: FakeElement | undefined = element; item !== undefined; item = item.parentNode) {
    if (item.hidden) return false;
  }
  return true;
}

const STATE: M1ControlsState = {
  appearance: normalizeAppearanceState(undefined),
  selectedIds: [],
  reviewMode: false,
  lockedSelection: false,
  showAttachmentNames: true,
  minimapVisible: true,
  diagnostics: [],
  zoom: 0.5,
  snapToGrid: true,
  snapToObjects: false,
};

function build(options: { withSettings?: boolean; setIcon?: (element: HTMLElement, icon: string) => void } = {}) {
  const calls: { navigation: M1NavigationAction[]; appearance: unknown[]; interaction: unknown[]; attachment: unknown[]; opened: string[] } = {
    navigation: [], appearance: [], interaction: [], attachment: [], opened: [],
  };
  const actions: M1ControlsActions = {
    onAppearance: (action) => { calls.appearance.push(action); },
    onInteraction: (action) => { calls.interaction.push(action); },
    onAttachment: (action) => { calls.attachment.push(action); },
    onNavigation: (action) => { calls.navigation.push(action); },
    openCommandModal: () => { calls.opened.push("commands"); },
    openSourceInspector: () => { calls.opened.push("source"); },
    openExport: () => { calls.opened.push("export"); },
    ...(options.withSettings === false ? {} : { openSettings: () => { calls.opened.push("settings"); } }),
  };
  const document = new FakeDocument();
  const controls = new M1Controls(actions, {
    document: document as unknown as Document,
    ...(options.setIcon === undefined ? {} : { setIcon: options.setIcon }),
  });
  const root = controls.element as unknown as FakeElement;
  const update = (patch: Partial<M1ControlsState> = {}): void => controls.update({ ...STATE, ...patch });
  update();
  return { controls, root, document, calls, update };
}

describe("corner dock", () => {
  it("is one element holding the map, the menus and one row of controls", () => {
    const { controls, root } = build();
    expect(controls.minimapElement).toBe(controls.element);
    expect(root.className).toBe("miro-canvas-dock");
    const bar = root.children[root.children.length - 1]!;
    expect(bar.className).toBe("miro-canvas-dock__bar");
    const labels = descendants(bar).map((item) => item.attributes.get("aria-label")).filter((label) => label !== undefined);
    expect(labels).toEqual(["Canvas navigation", "Undo", "Redo", "Hide minimap", "Zoom out", "View and zoom", "Zoom in", "Board settings", "0 diagnostic(s)"]);
    for (const name of ["view", "board", "diagnostics"]) expect(menu(root, name).hidden).toBe(true);
  });

  it("draws Obsidian icons through the host and falls back to glyphs", () => {
    const drawn: string[] = [];
    const { root } = build({ setIcon: (element, icon) => { drawn.push(icon); (element as unknown as FakeElement).textContent = ""; } });
    expect(drawn).toEqual(expect.arrayContaining(["undo-2", "redo-2", "map", "minus", "plus", "settings-2", "triangle-alert", "grid", "moon"]));
    expect(byLabel(root, "Undo").textContent).toBe("");
    expect(byLabel(build().root, "Undo").textContent).toBe("↶");
  });

  it("shows the zoom and the minimap as they are", () => {
    const { root, update } = build();
    expect(byLabel(root, "View and zoom").textContent).toBe("50%");
    const map = descendants(root).find((item) => item.className === "miro-canvas-dock__map")!;
    expect(map.hidden).toBe(false);
    expect(byLabel(root, "Hide minimap").getAttribute("aria-pressed")).toBe("true");
    update({ minimapVisible: false, zoom: 1.236 });
    expect(map.hidden).toBe(true);
    expect(byLabel(root, "Show minimap").getAttribute("aria-pressed")).toBe("false");
    expect(byLabel(root, "View and zoom").textContent).toBe("124%");
    update({ zoom: undefined });
    expect(byLabel(root, "View and zoom").textContent).toBe("—");
  });

  it("reports the row's buttons as navigation", () => {
    const { root, calls } = build();
    for (const label of ["Undo", "Redo", "Hide minimap", "Zoom out", "Zoom in"]) byLabel(root, label).dispatch("click");
    expect(calls.navigation).toEqual(["undo", "redo", "toggle-minimap", "zoom-out", "zoom-in"]);
  });

  it("opens the view menu from the zoom and runs its rows", () => {
    const { root, calls, update } = build();
    const view = menu(root, "view");
    byLabel(root, "View and zoom").dispatch("click");
    expect(view.hidden).toBe(false);
    expect(byLabel(root, "View and zoom").getAttribute("aria-expanded")).toBe("true");
    row(root, "Zoom to 50%").dispatch("click");
    expect(view.hidden).toBe(true);
    byLabel(root, "View and zoom").dispatch("click");
    row(root, "Fit to screen").dispatch("click");
    byLabel(root, "View and zoom").dispatch("click");
    row(root, "Zoom to 200%").dispatch("click");
    byLabel(root, "View and zoom").dispatch("click");
    row(root, "Zoom to 100%").dispatch("click");
    expect(calls.navigation).toEqual(["zoom-50", "zoom-fit", "zoom-200", "zoom-reset"]);
    // Switches keep the menu open and show what they switch.
    byLabel(root, "View and zoom").dispatch("click");
    expect(row(root, "Snap to grid").getAttribute("aria-checked")).toBe("true");
    expect(row(root, "Snap to objects").getAttribute("aria-checked")).toBe("false");
    expect(row(root, "Minimap").getAttribute("aria-checked")).toBe("true");
    row(root, "Snap to objects").dispatch("click");
    row(root, "Minimap").dispatch("click");
    expect(calls.navigation.slice(-2)).toEqual(["toggle-snap-objects", "toggle-minimap"]);
    expect(view.hidden).toBe(false);
    // Snapping the host cannot read is not offered.
    update({ snapToGrid: undefined });
    expect(row(root, "Snap to grid").hidden).toBe(true);
  });

  it("sets the board theme and switches from the board menu", () => {
    const { root, calls, update } = build();
    byLabel(root, "Board settings").dispatch("click");
    expect(menu(root, "board").hidden).toBe(false);
    const segments = descendants(root).filter((item) => item.className.includes("miro-canvas-dock__segment ")
      || item.className.endsWith("miro-canvas-dock__segment"));
    expect(segments.map((item) => [item.getAttribute("data-value"), item.getAttribute("aria-pressed")]))
      .toEqual([["system", "true"], ["light", "false"], ["dark", "false"]]);
    byLabel(root, "Dark theme").dispatch("click");
    expect(calls.appearance).toEqual([{ type: APPEARANCE_ACTIONS.setDisplayTheme, displayTheme: "dark" }]);
    row(root, "Review mode").dispatch("click");
    row(root, "Attachment names").dispatch("click");
    expect(calls.interaction).toEqual([{ type: "set-review-mode", enabled: true }]);
    expect(calls.attachment).toEqual([{ type: "set-global", visible: false }]);
    expect(row(root, "Name on selected attachment").disabled).toBe(true);
    update({ selectedIds: ["n1"], reviewMode: true, selectedAttachmentNames: false });
    expect(row(root, "Review mode").getAttribute("aria-checked")).toBe("true");
    expect(row(root, "Name on selected attachment").disabled).toBe(false);
    row(root, "Name on selected attachment").dispatch("click");
    expect(calls.attachment[1]).toEqual({ type: "set-selection", visible: true, elementIds: ["n1"] });
    row(root, "Review mode").dispatch("click");
    expect(calls.interaction[1]).toEqual({ type: "set-review-mode", enabled: false });
  });

  it("leads from the board menu to commands, the source and the plugin settings", () => {
    const { root, calls } = build();
    for (const text of ["Commands", "Source & provenance", "Plugin settings"]) {
      byLabel(root, "Board settings").dispatch("click");
      row(root, text).dispatch("click");
      expect(menu(root, "board").hidden).toBe(true);
    }
    expect(calls.opened).toEqual(["commands", "source", "settings"]);
    expect(() => row(build({ withSettings: false }).root, "Plugin settings")).toThrow();
  });

  it("offers exporting to PDF or PowerPoint from the board menu", () => {
    const { root, calls } = build();
    byLabel(root, "Board settings").dispatch("click");
    row(root, "Export to PDF or PowerPoint").dispatch("click");
    expect(menu(root, "board").hidden).toBe(true);
    expect(calls.opened).toEqual(["export"]);
  });

  it("shows a warning badge only when there is something to report", () => {
    const { root, update } = build();
    const badge = byLabel(root, "0 diagnostic(s)");
    expect(shown(badge)).toBe(false);
    update({ diagnostics: ["one", "two"] });
    expect(shown(badge)).toBe(true);
    expect(badge.getAttribute("aria-label")).toBe("2 diagnostic(s)");
    badge.dispatch("click");
    const list = descendants(menu(root, "diagnostics")).filter((item) => item.className === "miro-canvas-panel__diagnostic");
    expect(list.map((item) => item.textContent)).toEqual(["one", "two"]);
    update({ diagnostics: ["one", "two"], showDiagnostics: false });
    expect(shown(badge)).toBe(false);
    expect(menu(root, "diagnostics").hidden).toBe(true);
  });

  it("keeps one menu open at a time and closes it on Escape", () => {
    const { root } = build();
    byLabel(root, "View and zoom").dispatch("click");
    byLabel(root, "Board settings").dispatch("click");
    expect(menu(root, "view").hidden).toBe(true);
    expect(menu(root, "board").hidden).toBe(false);
    byLabel(root, "Board settings").dispatch("click");
    expect(menu(root, "board").hidden).toBe(true);
    byLabel(root, "Board settings").dispatch("click");
    root.dispatch("keydown", { key: "Escape" });
    expect(menu(root, "board").hidden).toBe(true);
  });

  it("opens dialogs over the whole window, not inside the dock", () => {
    const { controls, root, document } = build();
    controls.openCommandModal([{ id: "a", label: "A", run: () => undefined }]);
    const modal = document.body.children[0]!;
    expect(modal.className).toBe("miro-canvas-command-modal");
    expect(descendants(root).some((item) => item.className === "miro-canvas-command-modal")).toBe(false);
    modal.dispatch("keydown", { key: "Escape" });
    expect(document.body.children).toHaveLength(0);
    controls.openCommandModal([]);
    controls.dispose();
    expect(document.body.children).toHaveLength(0);
  });
});
