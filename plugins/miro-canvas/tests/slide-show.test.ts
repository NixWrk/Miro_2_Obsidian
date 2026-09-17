import { describe, expect, it } from "vitest";
import { SlideShow, type SlideRect } from "../src/slide-show";

type Listener = (event: FakeEvent) => void;

interface FakeEvent {
  readonly key?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  prevented?: boolean;
  preventDefault(): void;
  stopPropagation(): void;
}

class FakeTarget {
  public readonly listeners = new Map<string, Listener[]>();
  public addEventListener(name: string, listener: Listener): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  public removeEventListener(name: string, listener: Listener): void {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter((item) => item !== listener));
  }
  public fire(name: string, props: Partial<FakeEvent> = {}): FakeEvent {
    const event: FakeEvent = {
      ...props,
      preventDefault() { event.prevented = true; },
      stopPropagation() {},
    };
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener(event);
    return event;
  }
}

class FakeElement extends FakeTarget {
  public readonly children: FakeElement[] = [];
  public readonly attributes = new Map<string, string>();
  public readonly classes = new Set<string>();
  public readonly classList = {
    add: (name: string) => { this.classes.add(name); },
    remove: (name: string) => { this.classes.delete(name); },
    contains: (name: string) => this.classes.has(name),
  };
  public parentNode: FakeElement | undefined;
  public textContent = "";
  public type = "";
  public constructor(public readonly tagName: string, public readonly ownerDocument: FakeDocument) { super(); }
  public set className(value: string) { for (const name of value.split(" ")) this.classes.add(name); }
  public appendChild(child: FakeElement): FakeElement { child.parentNode = this; this.children.push(child); return child; }
  public remove(): void {
    this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = undefined;
  }
  public setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  public getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  public click(): void { this.fire("click"); }
  public find(test: (element: FakeElement) => boolean): FakeElement | undefined {
    for (const child of this.children) {
      if (test(child)) return child;
      const found = child.find(test);
      if (found !== undefined) return found;
    }
    return undefined;
  }
}

class FakeDocument extends FakeTarget {
  public createElement(tagName: string): FakeElement { return new FakeElement(tagName, this); }
}

function setup(rects: Record<string, SlideRect>) {
  const document = new FakeDocument();
  const root = document.createElement("div");
  const shown: SlideRect[] = [];
  const show = new SlideShow(root as unknown as HTMLElement, { rectOf: (id) => rects[id], show: (rect) => shown.push(rect) });
  const key = (name: string, props: Partial<FakeEvent> = {}) => document.fire("keydown", { key: name, ...props });
  const bar = () => root.find((element) => element.classes.has("miro-canvas-slideshow"));
  const counter = () => root.find((element) => element.classes.has("miro-canvas-slideshow__counter"))?.textContent;
  const button = (label: string) => root.find((element) => element.getAttribute("aria-label") === label)!;
  return { root, show, shown, key, bar, counter, button };
}

const RECTS = {
  one: { x: 0, y: 0, width: 960, height: 540 },
  two: { x: 1000, y: 0, width: 960, height: 540 },
  three: { x: 2000, y: 0, width: 960, height: 540 },
};

describe("slide show", () => {
  it("frames each slide in turn from the keyboard and ends on Escape", () => {
    const { root, show, shown, key, bar, counter } = setup(RECTS);
    expect(show.start(["one", "gone", "two", "three"])).toBe(true);
    expect(root.classes.has("miro-canvas-presenting")).toBe(true);
    expect(shown).toEqual([RECTS.one]);
    // A slide that no longer exists is left out of the count.
    expect(counter()).toBe("1 / 3");
    expect(key("ArrowRight").prevented).toBe(true);
    key(" ");
    expect(shown.slice(-2)).toEqual([RECTS.two, RECTS.three]);
    key("ArrowRight");
    expect(show.current).toBe(2);
    expect(bar()?.getAttribute("data-last")).toBe("true");
    // A shortcut with a modifier is left to Obsidian.
    expect(key("ArrowLeft", { ctrlKey: true }).prevented).toBeUndefined();
    key("Home");
    expect(counter()).toBe("1 / 3");
    key("Escape");
    expect(show.active).toBe(false);
    expect(bar()).toBeUndefined();
    expect(root.classes.has("miro-canvas-presenting")).toBe(false);
    // Once ended, the keyboard belongs to the board again.
    expect(key("ArrowRight").prevented).toBeUndefined();
    // Past the last slide the current one is framed again: start, two moves, the stop at the end and Home.
    expect(shown).toHaveLength(5);
  });

  it("moves from its own buttons and refuses a deck with nothing to show", () => {
    const { show, shown, bar, button } = setup(RECTS);
    expect(show.start(["gone"])).toBe(false);
    expect(bar()).toBeUndefined();
    show.start(["one", "two"], 1);
    expect(shown).toEqual([RECTS.two]);
    button("Previous slide").click();
    expect(shown.at(-1)).toEqual(RECTS.one);
    button("End presentation").click();
    expect(show.active).toBe(false);
  });
});
