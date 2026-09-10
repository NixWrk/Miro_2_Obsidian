import { describe, expect, it } from "vitest";

import { M1Controls, type M1ControlsActions } from "../src/m1-controls";
import { buildSourceInspection } from "../src/source-inspector";

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
  public value = "";
  public checked = false;
  public disabled = false;
  public hidden = false;
  public tabIndex = 0;
  public width = 0;
  public height = 0;

  public constructor(public readonly tagName: string) {}
  public get firstChild(): FakeElement | null { return this.children[0] ?? null; }
  public appendChild(child: FakeElement): FakeElement { child.parentNode = this; this.children.push(child); return child; }
  public removeChild(child: FakeElement): FakeElement { this.children.splice(this.children.indexOf(child), 1); child.parentNode = undefined; return child; }
  public remove(): void { this.parentNode?.removeChild(this); }
  public setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  public addEventListener(name: string, listener: (event: unknown) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  public removeEventListener(name: string, listener: (event: unknown) => void): void {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter((item) => item !== listener));
  }
  public dispatch(name: string): void {
    for (const listener of this.listeners.get(name) ?? []) listener({ type: name, target: this });
  }
  public focus(): void {}
}

class FakeDocument {
  public createElement(tagName: string): FakeElement { return new FakeElement(tagName); }
  public createTextNode(value: string): FakeElement { const node = new FakeElement("#text"); node.textContent = value; return node; }
}

function descendants(root: FakeElement): FakeElement[] {
  return [root, ...root.children.flatMap((child) => descendants(child))];
}

function fixture(): { readonly controls: M1Controls; readonly root: FakeElement } {
  let controls: M1Controls;
  const actions: M1ControlsActions = {
    onAppearance: () => undefined,
    onInteraction: () => undefined,
    onAttachment: () => undefined,
    onNavigation: () => undefined,
    openCommandModal: () => controls.openCommandModal([]),
  };
  controls = new M1Controls(actions, { document: new FakeDocument() as unknown as Document });
  return { controls, root: controls.element as unknown as FakeElement };
}

describe("M1 source inspector UI", () => {
  it("renders only the safe read-only model", () => {
    const { controls, root } = fixture();
    const inspection = buildSourceInspection({
      miroSource: {
        items: [{ id: "n", type: "card", data: { title: "Private title" }, future: { private: "sensitive-value" } }],
        completeness: { complete: false, known_limitations: ["Private limitation"] },
      },
    }, ["n"]);
    controls.openSourceInspector(inspection);
    const rendered = descendants(root).map((item) => item.textContent).join("\n");
    expect(rendered).toContain("Source & provenance");
    expect(rendered).toContain("Unknown metadata fields");
    expect(rendered).toContain("miroSource.records[0].future: object");
    expect(rendered).not.toContain("Private title");
    expect(rendered).not.toContain("Private limitation");
    expect(rendered).not.toContain("sensitive-value");
    controls.dispose();
  });

  it("keeps the inspector open when launched from the command modal", () => {
    const { controls, root } = fixture();
    const inspection = buildSourceInspection({ miroSource: { items: [] } });
    controls.openCommandModal([{ id: "inspect", label: "Inspect", run: () => controls.openSourceInspector(inspection) }]);
    const command = descendants(root).find((item) => item.dataset.miroCanvasCommand === "inspect");
    expect(command).toBeDefined();
    command!.dispatch("click");
    expect(descendants(root).some((item) => item.className.includes("miro-canvas-source-inspector__dialog"))).toBe(true);
    controls.dispose();
  });
});
