/**
 * Shows a presentation's slides one at a time, as Miro's presenter does:
 * each slide fills the view, the keyboard moves between them and Escape ends
 * the show.  The board's own controls step aside meanwhile.  The host frames
 * a slide; this module owns only the show's state, its small bar and its
 * keyboard listener.
 */

import { TOOLTIP_DELAY } from "./tooltips";

export interface SlideRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface SlideShowHost {
  /** Where a slide is on the board now, or nothing once it is gone. */
  readonly rectOf: (id: string) => SlideRect | undefined;
  /** Brings a board rectangle into view. */
  readonly show: (rect: SlideRect) => void;
  readonly setIcon?: (element: HTMLElement, icon: string) => void;
}

const PRESENTING_CLASS = "miro-canvas-presenting";
const NEXT_KEYS = new Set(["ArrowRight", "ArrowDown", "PageDown", " ", "Enter"]);
const PREVIOUS_KEYS = new Set(["ArrowLeft", "ArrowUp", "PageUp", "Backspace"]);

export class SlideShow {
  private slides: readonly string[] = [];
  private index = 0;
  private bar: HTMLElement | undefined;
  private counter: HTMLElement | undefined;
  private readonly onKey = (event: KeyboardEvent): void => this.handleKey(event);

  public constructor(
    private readonly root: HTMLElement,
    private readonly host: SlideShowHost,
  ) {}

  public get active(): boolean {
    return this.bar !== undefined;
  }

  public get current(): number {
    return this.index;
  }

  /** Starts at a slide; slides that no longer exist are skipped. */
  public start(slides: readonly string[], from = 0): boolean {
    const shown = slides.filter((id) => this.host.rectOf(id) !== undefined);
    if (shown.length === 0) return false;
    this.stop();
    this.slides = shown;
    this.mount();
    this.go(Math.max(0, shown.indexOf(slides[from] ?? "")));
    return true;
  }

  public next(): void {
    this.go(this.index + 1);
  }

  public previous(): void {
    this.go(this.index - 1);
  }

  public go(index: number): void {
    if (!this.active) return;
    this.index = Math.min(Math.max(index, 0), this.slides.length - 1);
    const rect = this.host.rectOf(this.slides[this.index]!);
    if (rect !== undefined) this.host.show(rect);
    if (this.counter !== undefined) this.counter.textContent = `${this.index + 1} / ${this.slides.length}`;
    this.bar?.setAttribute("data-first", String(this.index === 0));
    this.bar?.setAttribute("data-last", String(this.index === this.slides.length - 1));
  }

  public stop(): void {
    if (this.bar === undefined) return;
    this.root.ownerDocument.removeEventListener("keydown", this.onKey, true);
    this.bar.remove();
    this.bar = undefined;
    this.counter = undefined;
    this.root.classList.remove(PRESENTING_CLASS);
  }

  private mount(): void {
    const document = this.root.ownerDocument;
    const bar = document.createElement("div");
    bar.className = "miro-canvas-slideshow";
    bar.setAttribute("role", "toolbar");
    bar.setAttribute("aria-label", "Presentation");
    const button = (label: string, icon: string, glyph: string, run: () => void): HTMLButtonElement => {
      const element = document.createElement("button");
      element.type = "button";
      element.className = "miro-canvas-slideshow__button";
      element.setAttribute("aria-label", label);
      element.setAttribute("data-tooltip-delay", TOOLTIP_DELAY);
      if (this.host.setIcon !== undefined) this.host.setIcon(element, icon);
      else element.textContent = glyph;
      element.addEventListener("click", run);
      bar.appendChild(element);
      return element;
    };
    button("Previous slide", "chevron-left", "‹", () => this.previous()).classList.add("miro-canvas-slideshow__previous");
    const counter = document.createElement("span");
    counter.className = "miro-canvas-slideshow__counter";
    bar.appendChild(counter);
    button("Next slide", "chevron-right", "›", () => this.next()).classList.add("miro-canvas-slideshow__next");
    button("End presentation", "x", "×", () => this.stop());
    // The board must not start a drag or select under the bar.
    bar.addEventListener("pointerdown", (event) => event.stopPropagation());
    this.root.appendChild(bar);
    this.root.classList.add(PRESENTING_CLASS);
    document.addEventListener("keydown", this.onKey, true);
    this.bar = bar;
    this.counter = counter;
  }

  private handleKey(event: KeyboardEvent): void {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    let handled = true;
    if (event.key === "Escape") this.stop();
    else if (NEXT_KEYS.has(event.key)) this.next();
    else if (PREVIOUS_KEYS.has(event.key)) this.previous();
    else if (event.key === "Home") this.go(0);
    else if (event.key === "End") this.go(this.slides.length - 1);
    else handled = false;
    if (handled) {
      event.preventDefault();
      event.stopPropagation();
    }
  }
}
