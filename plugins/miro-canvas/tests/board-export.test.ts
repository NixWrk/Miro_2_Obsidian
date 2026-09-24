import { describe, expect, it } from "vitest";

import {
  EXPORT_TEXT, ExportOverlay, ExportPanel, planCapture, type ExportPanelActions, type ExportPanelState, type OverlayPage,
} from "../src/board-export";
import { DEFAULT_EXPORT_STATE, type ExportState } from "../src/export-pages";

describe("planCapture", () => {
  it("plans a page that fits the window in one tile", () => {
    const [plan] = planCapture([{ x: 0, y: 0, width: 1000, height: 500 }], "standard", { width: 2000, height: 1000 }, 1, 1);
    expect(plan!.pixels).toEqual({ width: 2000, height: 1000, scale: 2 });
    expect(plan!.scale).toBe(2);
    expect(plan!.tiles).toHaveLength(1);
    expect(plan!.tiles[0]!.center).toEqual({ x: 500, y: 250 });
    expect(plan!.tiles[0]!.zoom).toBeCloseTo(1);
    expect(plan!.tiles[0]!.draw).toEqual({ x: 0, y: 0, width: 2000, height: 1000 });
  });

  it("splits a page wider than the window into several tiles, each with its own centre and offset", () => {
    const [plan] = planCapture([{ x: 0, y: 0, width: 2000, height: 500 }], "standard", { width: 1000, height: 1000 }, 1, 1);
    expect(plan!.tiles).toHaveLength(2);
    expect(plan!.tiles[0]).toEqual({
      tile: { x: 0, y: 0, width: 1000, height: 500 },
      center: { x: 500, y: 500 },
      zoom: 0,
      draw: { x: 0, y: 0, width: 1000, height: 500 },
    });
    expect(plan!.tiles[1]).toEqual({
      tile: { x: 1000, y: 0, width: 1000, height: 500 },
      center: { x: 1500, y: 500 },
      zoom: 0,
      draw: { x: 1000, y: 0, width: 1000, height: 500 },
    });
  });

  it("folds the window's own zoom factor and pixel ratio into the scale and the zoom it plans", () => {
    const [plan] = planCapture([{ x: 0, y: 0, width: 1000, height: 1000 }], "high", { width: 1875, height: 1875 }, 2, 1.25);
    // pixels.scale is 3 (long side at 3000); ratio is 2 / 1.25 = 1.6, so the
    // window shows 1.875 pixels per board unit.
    expect(plan!.pixels.scale).toBe(3);
    expect(plan!.scale).toBeCloseTo(1.875);
    expect(plan!.tiles).toHaveLength(1);
    expect(plan!.tiles[0]!.zoom).toBeCloseTo(Math.log2(1.5));
    expect(plan!.tiles[0]!.draw).toEqual({ x: 0, y: 0, width: 3000, height: 3000 });
  });
});

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
  public type = "";
  public hidden = false;
  public disabled = false;

  public constructor(public readonly tagName: string) {}

  public get parentElement(): FakeElement | null { return this.parentNode ?? null; }
  public get firstChild(): FakeElement | null { return this.children[0] ?? null; }

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

  public remove(): void {
    this.parentNode?.removeChild(this);
  }

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
}

/** `document.defaultView`: the overlay drags by listening on the window, not the element. */
class FakeWindow {
  public readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  public addEventListener(name: string, listener: (event: unknown) => void, _capture?: boolean): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  public removeEventListener(name: string, listener: (event: unknown) => void, _capture?: boolean): void {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter((item) => item !== listener));
  }
  public dispatch(name: string, props: Record<string, unknown> = {}): void {
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener({ type: name, ...props });
  }
}

class FakeDocument {
  public readonly defaultView = new FakeWindow();
  public createElement(tagName: string): FakeElement { return new FakeElement(tagName); }
}

function descendants(root: FakeElement): FakeElement[] {
  return [root, ...root.children.flatMap((child) => descendants(child))];
}

function byLabel(root: FakeElement, label: string): FakeElement {
  const found = byLabelAll(root, label);
  if (found.length !== 1) throw new Error(`expected one ${label}, found ${found.length}`);
  return found[0]!;
}

function byLabelAll(root: FakeElement, label: string): FakeElement[] {
  return descendants(root).filter((item) => item.attributes.get("aria-label") === label);
}

function texts(root: FakeElement, className: string): string[] {
  return descendants(root).filter((item) => item.className === className).map((item) => item.textContent);
}

/** The nth page row: its name button, then (for a board) earlier, later and remove. */
function pageRow(root: FakeElement, index: number): FakeElement {
  return descendants(root).filter((item) => item.className === "miro-canvas-export__page")[index]!;
}

const STATE: ExportState = {
  ...DEFAULT_EXPORT_STATE,
  pages: [
    { id: "p1", x: 0, y: 0, width: 100, height: 100, name: "Intro" },
    { id: "p2", x: 200, y: 0, width: 100, height: 100 },
  ],
};

function buildPanel(overrides: Partial<ExportPanelState> = {}): {
  readonly panel: ExportPanel; readonly root: FakeElement; readonly calls: Record<string, unknown[]>;
  readonly render: (patch?: Partial<ExportPanelState>) => void;
} {
  const calls: Record<string, unknown[]> = {
    format: [], quality: [], addPage: [], addFramePages: [], removePage: [], movePage: [], showPage: [], exportKind: [], close: [],
  };
  const actions: ExportPanelActions = {
    onFormat: (format, orientation) => calls.format.push([format, orientation]),
    onQuality: (quality) => calls.quality.push(quality),
    onAddPage: () => calls.addPage.push(true),
    onAddFramePages: () => calls.addFramePages.push(true),
    onRemovePage: (id) => calls.removePage.push(id),
    onMovePage: (id, step) => calls.movePage.push([id, step]),
    onShowPage: (id) => calls.showPage.push(id),
    onExport: (kind) => calls.exportKind.push(kind),
    onClose: () => calls.close.push(true),
  };
  const panel = new ExportPanel(new FakeDocument() as unknown as Document, actions);
  const root = panel.element as unknown as FakeElement;
  const base: ExportPanelState = { mode: "board", title: "Export board", state: STATE, ...overrides };
  const render = (patch: Partial<ExportPanelState> = {}): void => panel.update({ ...base, ...patch });
  render();
  return { panel, root, calls, render };
}

describe("ExportPanel", () => {
  it("lists the board's pages with their number and name", () => {
    const { root } = buildPanel();
    expect(texts(root, "miro-canvas-export__page-name")).toEqual(["1. Intro", "2. Page 2"]);
  });

  it("moves, removes and shows a page from its row", () => {
    const { root, calls } = buildPanel();
    // p1's row: name, earlier (disabled, it is first), later, remove.
    const first = pageRow(root, 0);
    first.children[0]!.dispatch("click");
    first.children[2]!.dispatch("click");
    first.children[3]!.dispatch("click");
    expect(calls.showPage[0]).toBe("p1");
    expect(calls.movePage[0]).toEqual(["p1", 1]);
    expect(calls.removePage[0]).toBe("p1");
  });

  it("offers to add a page or one per frame, only for a board", () => {
    const { root, calls } = buildPanel();
    byLabel(root, EXPORT_TEXT.addPageHint).dispatch("click");
    byLabel(root, EXPORT_TEXT.addFramePagesHint).dispatch("click");
    expect(calls.addPage).toHaveLength(1);
    expect(calls.addFramePages).toHaveLength(1);
    const { root: slidesRoot, calls: slidesCalls } = buildPanel({ mode: "slides", title: "Export slides" });
    expect(() => byLabel(slidesRoot, EXPORT_TEXT.addPageHint)).toThrow();
    // A slide can still be shown, but never moved or removed.
    expect(() => byLabel(slidesRoot, EXPORT_TEXT.removePage)).toThrow();
    pageRow(slidesRoot, 0).children[0]!.dispatch("click");
    expect(slidesCalls.showPage[0]).toBe("p1");
  });

  it("disables page and export actions while busy, and export while unavailable or empty", () => {
    const { root } = buildPanel({ busy: "Taking pictures: 0 of 1" });
    expect(byLabelAll(root, EXPORT_TEXT.later).every((item) => item.disabled)).toBe(true);
    expect(byLabel(root, EXPORT_TEXT.exportPdf).disabled).toBe(true);
    expect(texts(root, "miro-canvas-export__status")).toEqual(["Taking pictures: 0 of 1"]);
    const { root: unavailableRoot } = buildPanel({ unavailable: EXPORT_TEXT.unavailable });
    expect(byLabel(unavailableRoot, EXPORT_TEXT.exportPdf).disabled).toBe(true);
    const { root: emptyRoot } = buildPanel({ state: { ...STATE, pages: [] } });
    expect(byLabel(emptyRoot, EXPORT_TEXT.exportPdf).disabled).toBe(true);
    expect(texts(emptyRoot, "miro-canvas-export__empty")).toEqual([EXPORT_TEXT.noPages]);
  });

  it("changes paper format, orientation and quality", () => {
    const { root, calls } = buildPanel();
    byLabel(root, EXPORT_TEXT.portrait).dispatch("click");
    byLabel(root, EXPORT_TEXT.highHint).dispatch("click");
    expect(calls.format[0]).toEqual(["a4", "portrait"]);
    expect(calls.quality[0]).toBe("high");
  });

  it("runs pdf or pptx export and closes from its own buttons", () => {
    const { root, calls } = buildPanel();
    byLabel(root, EXPORT_TEXT.exportPptx).dispatch("click");
    byLabel(root, EXPORT_TEXT.close).dispatch("click");
    expect(calls.exportKind).toEqual(["pptx"]);
    expect(calls.close).toHaveLength(1);
  });
});

function overlayPage(id: string, left: number, top: number, width = 100, height = 60): OverlayPage {
  return { id, label: id, left, top, width, height };
}

describe("ExportOverlay", () => {
  it("draws each page as a tab and a corner, positioned as given", () => {
    const document = new FakeDocument();
    const overlay = new ExportOverlay(document as unknown as Document, () => {}, () => undefined);
    overlay.update([overlayPage("p1", 10, 20, 100, 60)], true);
    const root = overlay.element as unknown as FakeElement;
    expect(root.children).toHaveLength(1);
    const frame = root.children[0]!;
    expect(frame.style).toEqual({ left: "10px", top: "20px", width: "100px", height: "60px" });
    expect(frame.children.map((child) => child.className)).toEqual(["miro-canvas-export-page__tab", "miro-canvas-export-page__corner"]);
  });

  it("moves and relabels the same elements when the set of pages is unchanged", () => {
    const document = new FakeDocument();
    const overlay = new ExportOverlay(document as unknown as Document, () => {}, () => undefined);
    overlay.update([overlayPage("p1", 0, 0)], true);
    const root = overlay.element as unknown as FakeElement;
    const frame = root.children[0]!;
    overlay.update([overlayPage("p1", 40, 50)], true);
    expect(root.children).toHaveLength(1);
    expect(root.children[0]).toBe(frame);
    expect(frame.style.left).toBe("40px");
    expect(frame.style.top).toBe("50px");
  });

  it("rebuilds when a page is added, removed or reordered", () => {
    const document = new FakeDocument();
    const overlay = new ExportOverlay(document as unknown as Document, () => {}, () => undefined);
    overlay.update([overlayPage("p1", 0, 0), overlayPage("p2", 200, 0)], true);
    const root = overlay.element as unknown as FakeElement;
    const first = root.children[0]!;
    overlay.update([overlayPage("p2", 200, 0), overlayPage("p1", 0, 0)], true);
    expect(root.children).toHaveLength(2);
    expect(root.children[0]).not.toBe(first);
    expect(first.parentNode).toBeUndefined();
  });

  it("does not draw a corner, or listen for a drag, when the pages are not editable", () => {
    const document = new FakeDocument();
    const overlay = new ExportOverlay(document as unknown as Document, () => {}, () => undefined);
    overlay.update([overlayPage("p1", 0, 0)], false);
    const root = overlay.element as unknown as FakeElement;
    expect(root.children[0]!.children).toHaveLength(1);
    expect(root.children[0]!.children[0]!.className).toBe("miro-canvas-export-page__tab");
  });

  it("previews a drag as it moves and commits it only on release", () => {
    const document = new FakeDocument();
    const changes: [string, unknown, boolean][] = [];
    const overlay = new ExportOverlay(document as unknown as Document, (id, rect, commit) => { changes.push([id, rect, commit]); }, () => undefined);
    overlay.update([overlayPage("p1", 10, 20, 100, 60)], true);
    const root = overlay.element as unknown as FakeElement;
    const tab = root.children[0]!.children[0]!;
    tab.dispatch("pointerdown", { button: 0, clientX: 50, clientY: 50, preventDefault: () => {}, stopPropagation: () => {} });
    document.defaultView.dispatch("pointermove", { clientX: 60, clientY: 55 });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toEqual(["p1", { left: 20, top: 25, width: 100, height: 60 }, false]);
    // A refresh mid-drag must not tear down, or even move, the page being dragged.
    const dragged = root.children[0]!;
    overlay.update([overlayPage("p1", 999, 999)], true);
    expect(root.children[0]).toBe(dragged);
    // Set by the drag's own move handler; update()'s early return left it alone.
    expect(dragged.style.left).toBe("20px");
    document.defaultView.dispatch("pointerup", { clientX: 70, clientY: 65 });
    expect(changes).toHaveLength(2);
    expect(changes[1]).toEqual(["p1", { left: 30, top: 35, width: 100, height: 60 }, true]);
  });

  it("keeps a paper's ratio while its corner is dragged, and grows freely when there is none", () => {
    const document = new FakeDocument();
    const changes: [unknown, boolean][] = [];
    const overlay = new ExportOverlay(document as unknown as Document, (_id, rect, commit) => { changes.push([rect, commit]); }, () => 2);
    overlay.update([overlayPage("p1", 0, 0, 100, 50)], true);
    const root = overlay.element as unknown as FakeElement;
    const corner = root.children[0]!.children[1]!;
    corner.dispatch("pointerdown", { button: 0, clientX: 100, clientY: 50, preventDefault: () => {}, stopPropagation: () => {} });
    document.defaultView.dispatch("pointerup", { clientX: 140, clientY: 50 });
    const [rect] = changes[0]!;
    expect((rect as { width: number; height: number }).width / (rect as { width: number; height: number }).height).toBeCloseTo(2);
  });
});
