import { describe, expect, it } from "vitest";

import { QUICK_TOOLS, QUICK_TOOL_KEYS, QuickTools, type QuickTool } from "../src/quick-tools";

class FakeElement {
  public readonly nodeType = 1;
  public readonly children: FakeElement[] = [];
  public readonly attributes = new Map<string, string>();
  public readonly classes = new Set<string>();
  public readonly classList = {
    add: (name: string) => { this.classes.add(name); },
    remove: (name: string) => { this.classes.delete(name); },
    contains: (name: string) => this.classes.has(name),
  };
  public readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  public parentNode: FakeElement | undefined;
  public textContent = "";
  public type = "";
  public hidden = false;
  public disabled = false;

  public constructor(public readonly tagName: string) {}

  public set className(value: string) {
    for (const name of value.split(" ")) if (name !== "") this.classes.add(name);
  }

  public get className(): string {
    return [...this.classes].join(" ");
  }

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

  // Shape pictures are made through the namespaced call; the fake does not
  // need a real SVG namespace to stand in for one.
  public createElementNS(_namespace: string, tagName: string): FakeElement {
    return new FakeElement(tagName);
  }
}

function descendants(root: FakeElement): FakeElement[] {
  return [root, ...root.children.flatMap((child) => descendants(child))];
}

function toolButton(root: FakeElement, tool: QuickTool): FakeElement {
  const matches = descendants(root).filter((item) => item.attributes.get("data-tool") === tool);
  if (matches.length !== 1) throw new Error(`expected one button for ${tool}, found ${matches.length}`);
  return matches[0]!;
}

function byLabel(root: FakeElement, label: string): FakeElement {
  const matches = descendants(root).filter((item) => item.attributes.get("aria-label") === label);
  if (matches.length !== 1) throw new Error(`expected one control labelled ${label}, found ${matches.length}`);
  return matches[0]!;
}

function shapeOption(root: FakeElement, kind: string): FakeElement {
  const matches = descendants(root).filter((item) => item.attributes.get("data-shape") === kind);
  if (matches.length !== 1) throw new Error(`expected one shape option for ${kind}, found ${matches.length}`);
  return matches[0]!;
}

/** The panel a popover button owns is its sibling inside the popover host. */
function panelOf(button: FakeElement): FakeElement {
  return button.parentElement!.children.find((child) => child.className.includes("__panel"))!;
}

type Call =
  | { readonly kind: "arm"; readonly tool: QuickTool }
  | { readonly kind: "shape"; readonly shape: string }
  | { readonly kind: "pen"; readonly settings: { readonly color?: string; readonly width?: number } };

/** What the bar is told about the board when nothing in particular is set. */
const STATE = { editable: true, armed: "select", shape: "rectangle", penColor: "#1a1a1a", penWidth: 5, eraserSize: 32 } as const;

function build(): { readonly tools: QuickTools; readonly root: FakeElement; readonly calls: Call[] } {
  const calls: Call[] = [];
  const tools = new QuickTools(
    {
      onArm: (tool) => calls.push({ kind: "arm", tool }),
      onShape: (shape) => calls.push({ kind: "shape", shape }),
      onPen: (settings) => calls.push({ kind: "pen", settings }),
    },
    { document: new FakeDocument() as unknown as Document },
  );
  return { tools, root: tools.element as unknown as FakeElement, calls };
}

describe("quick tools", () => {
  it("reports valid head sizes separately from width and supports optional hosts", () => {
    const patches: unknown[] = [];
    const tools = new QuickTools({onArm:()=>{}, onShape:()=>{}, onPen:()=>{}, onConnector:p=>patches.push(p)}, {document:new FakeDocument() as unknown as Document});
    const root = tools.element as unknown as FakeElement;
    const input = byLabel(root, "New connector arrowhead size") as unknown as HTMLInputElement;
    tools.update({...STATE, armed:"connector"});
    expect(input.value).toBe("");
    for (const value of ["0", "1001", "", "NaN"]) {
      input.value=value;(input as unknown as FakeElement).dispatch("change");
    }
    expect(patches).toEqual([]);
    input.value="24.5";(input as unknown as FakeElement).dispatch("change");
    expect(patches).toEqual([{headSize:24.5}]);
    tools.update({...STATE, connectorHeadSize:24.5, connectorWidth:50, editable:false});
    expect(input.value).toBe("24.5");expect(input.disabled).toBe(true);
    (input as unknown as FakeElement).dispatch("change");
    expect(patches).toHaveLength(1);
    const optional=build();
    const optionalInput=byLabel(optional.root,"New connector arrowhead size") as unknown as HTMLInputElement;
    optionalInput.value="20";
    expect(()=>(optionalInput as unknown as FakeElement).dispatch("change")).not.toThrow();
  });
  it("offers a custom drawing color alongside the connector color picker", () => {
    const {tools, root, calls} = build();
    tools.update({...STATE, armed: "pen", penColor: "#abcdef"});
    const picker = byLabel(root, "New drawing color") as unknown as HTMLInputElement;
    expect(picker.value).toBe("#abcdef");
    picker.value = "#123456";
    (picker as unknown as FakeElement).dispatch("input");
    expect(calls).toEqual([{kind: "pen", settings: {color: "#123456"}}]);
    expect(byLabel(root, "New connector color").type).toBe("color");
    tools.update({...STATE, editable: false});
    expect(picker.disabled).toBe(true);
  });
  it("offers one button per tool, with code and link inside the more panel", () => {
    const { root } = build();
    for (const tool of QUICK_TOOLS) toolButton(root, tool);
    const more = panelOf(byLabel(root, "More tools"));
    expect(descendants(more)).toContain(toolButton(root, "code"));
    expect(descendants(more)).toContain(toolButton(root, "link"));
  });

  it("arms the tool a bar button names when it is clicked", () => {
    const { root, calls } = build();
    for (const tool of ["select", "text", "sticky", "connector", "comment", "frame"] as const) {
      toolButton(root, tool).dispatch("click");
    }
    expect(calls).toEqual(
      ["select", "text", "sticky", "connector", "comment", "frame"].map((tool) => ({ kind: "arm", tool })),
    );
  });

  it("arms a tool from the more panel and closes the panel behind it", () => {
    const { root, calls } = build();
    const more = byLabel(root, "More tools");
    more.dispatch("click");
    expect(panelOf(more).hidden).toBe(false);
    toolButton(root, "link").dispatch("click");
    expect(calls).toEqual([{ kind: "arm", tool: "link" }]);
    expect(panelOf(more).hidden).toBe(true);
    expect(more.getAttribute("aria-expanded")).toBe("false");
  });

  it("picks a shape from the shape panel, arms the shape tool and closes the panel", () => {
    const { root, calls } = build();
    const shapeButton = toolButton(root, "shape");
    shapeButton.dispatch("click");
    expect(panelOf(shapeButton).hidden).toBe(false);
    shapeOption(root, "rectangle").dispatch("click");
    expect(calls).toEqual([{ kind: "arm", tool: "shape" }, { kind: "shape", shape: "rectangle" }, { kind: "arm", tool: "shape" }]);
    expect(panelOf(shapeButton).hidden).toBe(true);
  });

  it("opens one panel at a time and marks the open one expanded", () => {
    const { root } = build();
    const shapeButton = toolButton(root, "shape");
    const more = byLabel(root, "More tools");
    shapeButton.dispatch("click");
    expect(panelOf(shapeButton).hidden).toBe(false);
    expect(shapeButton.getAttribute("aria-expanded")).toBe("true");
    more.dispatch("click");
    expect(panelOf(shapeButton).hidden).toBe(true);
    expect(shapeButton.getAttribute("aria-expanded")).toBe("false");
    expect(panelOf(more).hidden).toBe(false);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    // A second click on the open panel's own button closes it again.
    more.dispatch("click");
    expect(panelOf(more).hidden).toBe(true);
  });

  it("closes shape popovers when a different tool is armed", () => {
    const { root, tools } = build();
    tools.update({ ...STATE, armed: "shape" });
    const button = toolButton(root, "shape");
    button.dispatch("click");
    expect(panelOf(button).hidden).toBe(false);
    tools.update({ ...STATE, armed: "connector" });
    expect(panelOf(button).hidden).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("false");
  });

  it("disables every tool but the selecting ones and closes open panels when the board stops being editable", () => {
    const { root, tools } = build();
    toolButton(root, "shape").dispatch("click");
    tools.update({ ...STATE, editable: false });
    expect(panelOf(toolButton(root, "shape")).hidden).toBe(true);
    for (const tool of QUICK_TOOLS) {
      // Selecting changes nothing, so Select and the lasso stay live.
      expect(toolButton(root, tool).disabled).toBe(tool !== "select" && tool !== "lasso");
    }
  });

  it("marks the armed tool and the chosen shape as pressed", () => {
    const { root, tools } = build();
    tools.update({ ...STATE, armed: "text", shape: "rhombus" });
    for (const tool of QUICK_TOOLS) {
      expect(toolButton(root, tool).getAttribute("aria-pressed")).toBe(tool === "text" ? "true" : "false");
    }
    expect(shapeOption(root, "rhombus").getAttribute("aria-pressed")).toBe("true");
    expect(shapeOption(root, "rectangle").getAttribute("aria-pressed")).toBe("false");
    // A second, different shape swaps the picture the bar button already shows.
    tools.update({ ...STATE, armed: "frame" });
    expect(toolButton(root, "frame").getAttribute("aria-pressed")).toBe("true");
    expect(toolButton(root, "text").getAttribute("aria-pressed")).toBe("false");
    expect(shapeOption(root, "rectangle").getAttribute("aria-pressed")).toBe("true");
    expect(shapeOption(root, "rhombus").getAttribute("aria-pressed")).toBe("false");
  });

  it("maps each bar shortcut letter to its tool", () => {
    expect([...QUICK_TOOL_KEYS.entries()]).toEqual([
      ["V", "select"], ["T", "text"], ["N", "sticky"], ["S", "shape"], ["P", "pen"],
      ["L", "connector"], ["C", "comment"], ["F", "frame"],
    ]);
  });

  it("stops answering clicks once disposed", () => {
    const { root, tools, calls } = build();
    tools.dispose();
    toolButton(root, "select").dispatch("click");
    expect(calls).toEqual([]);
  });
});
