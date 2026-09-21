/**
 * What a board exports: pages laid over it, each a rectangle of the board
 * printed on one sheet or slide.
 *
 * The pages are the plugin's own record, kept with the board under
 * `miroCanvas.export`; they never become nodes, so marking what to export
 * leaves the board exactly as it was.  A page has the proportions of its
 * paper, so what is inside it is what the sheet shows.  Pure, so the
 * panel, the capture and the tests all measure a page the same way.
 */

export const PAPER_FORMATS = ["a4", "a3", "letter", "16:9", "4:3", "free"] as const;
export type PaperFormat = (typeof PAPER_FORMATS)[number];
export type PaperOrientation = "landscape" | "portrait";
export type ExportQuality = "standard" | "high";

export interface ExportRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ExportPageRecord extends ExportRect {
  readonly id: string;
  readonly name?: string;
}

export interface ExportState {
  readonly format: PaperFormat;
  readonly orientation: PaperOrientation;
  readonly quality: ExportQuality;
  readonly pages: readonly ExportPageRecord[];
}

export const DEFAULT_EXPORT_STATE: ExportState = Object.freeze({
  format: "a4", orientation: "landscape", quality: "standard", pages: Object.freeze([]),
});

/** Paper sizes in points, long side second: what the sheet of each format measures. */
const PAPER_POINTS: Readonly<Record<Exclude<PaperFormat, "free">, readonly [number, number]>> = Object.freeze({
  a4: [595.28, 841.89],
  a3: [841.89, 1190.55],
  letter: [612, 792],
  // A widescreen slide as PowerPoint makes one: 13.33 by 7.5 inches.
  "16:9": [540, 960],
  "4:3": [540, 720],
});

export const PAPER_LABELS: Readonly<Record<PaperFormat, string>> = Object.freeze({
  a4: "A4", a3: "A3", letter: "Letter", "16:9": "Slide 16:9", "4:3": "Slide 4:3", free: "Free size",
});

/** The most pages a board keeps, and the largest a page may be. */
export const MAX_EXPORT_PAGES = 200;
const MAX_EXTENT = 1_000_000;
/** A free page's long side, in points: as long as A4's. */
const FREE_LONG_SIDE = 841.89;

/** The sheet a page prints on, in points: its paper, turned as asked, or the page's own shape when free. */
export function paperSize(format: PaperFormat, orientation: PaperOrientation, page?: ExportRect): { readonly width: number; readonly height: number } {
  if (format === "free") {
    const width = page?.width ?? 4, height = page?.height ?? 3;
    const scale = FREE_LONG_SIDE / Math.max(width, height, 1e-9);
    return { width: Math.round(width * scale * 100) / 100, height: Math.round(height * scale * 100) / 100 };
  }
  const [short, long] = PAPER_POINTS[format];
  return orientation === "landscape" ? { width: long, height: short } : { width: short, height: long };
}

/** Width over height of a format's sheet; undefined when the page may take any shape. */
export function paperRatio(format: PaperFormat, orientation: PaperOrientation): number | undefined {
  if (format === "free") return undefined;
  const size = paperSize(format, orientation);
  return size.width / size.height;
}

/** The page of a given shape that covers a rectangle, centred on it. */
export function pageAround(rect: ExportRect, ratio: number | undefined, margin = 0): ExportRect {
  const width = rect.width + margin * 2, height = rect.height + margin * 2;
  if (ratio === undefined) return { x: rect.x - margin, y: rect.y - margin, width, height };
  const fitted = width / height > ratio ? { width, height: width / ratio } : { width: height * ratio, height };
  return {
    x: rect.x + rect.width / 2 - fitted.width / 2,
    y: rect.y + rect.height / 2 - fitted.height / 2,
    width: fitted.width,
    height: fitted.height,
  };
}

/** A page given a new shape, keeping its middle and its area. */
export function reshapePage(page: ExportRect, ratio: number | undefined): ExportRect {
  if (ratio === undefined) return page;
  const area = page.width * page.height;
  const width = Math.sqrt(area * ratio), height = width / ratio;
  return { x: page.x + page.width / 2 - width / 2, y: page.y + page.height / 2 - height / 2, width, height };
}

/**
 * The board rectangles a page is captured in: the view holds `view` board
 * units at a time, so a page larger than that is taken piece by piece.
 */
export function captureTiles(page: ExportRect, view: { readonly width: number; readonly height: number }): ExportRect[] {
  const tiles: ExportRect[] = [];
  const across = Math.max(1, Math.ceil(page.width / view.width - 1e-9));
  const down = Math.max(1, Math.ceil(page.height / view.height - 1e-9));
  for (let row = 0; row < down; row += 1) {
    for (let column = 0; column < across; column += 1) {
      const x = page.x + column * view.width, y = page.y + row * view.height;
      tiles.push({
        x, y,
        width: Math.min(view.width, page.x + page.width - x),
        height: Math.min(view.height, page.y + page.height - y),
      });
    }
  }
  return tiles;
}

/** How many pixels a page is exported at: its long side, by quality. */
export function exportPixels(page: ExportRect, quality: ExportQuality): { readonly width: number; readonly height: number; readonly scale: number } {
  const long = quality === "high" ? 3_000 : 2_000;
  const scale = long / Math.max(page.width, page.height, 1e-9);
  return { width: Math.max(1, Math.round(page.width * scale)), height: Math.max(1, Math.round(page.height * scale)), scale };
}

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => value !== null && typeof value === "object" && !Array.isArray(value);

/** A board's export record, with anything malformed left out rather than refused. */
export function readExportState(value: unknown): ExportState {
  if (!isRecord(value)) return DEFAULT_EXPORT_STATE;
  const format = (PAPER_FORMATS as readonly unknown[]).includes(value.format) ? value.format as PaperFormat : DEFAULT_EXPORT_STATE.format;
  const orientation = value.orientation === "portrait" ? "portrait" : "landscape";
  const quality = value.quality === "high" ? "high" : "standard";
  const pages = (Array.isArray(value.pages) ? value.pages : []).slice(0, MAX_EXPORT_PAGES).flatMap((page): ExportPageRecord[] => {
    if (!isRecord(page) || typeof page.id !== "string" || page.id === "") return [];
    const { x, y, width, height } = page;
    if (![x, y, width, height].every(isFiniteNumber) || !((width as number) > 0) || !((height as number) > 0)) return [];
    if ([x, y, width, height].some((part) => Math.abs(part as number) > MAX_EXTENT)) return [];
    return [Object.freeze({
      id: page.id, x: x as number, y: y as number, width: width as number, height: height as number,
      ...(typeof page.name === "string" && page.name.length <= 256 ? { name: page.name } : {}),
    })];
  });
  return Object.freeze({ format, orientation, quality, pages: Object.freeze(pages) });
}

/** Whether a stored export record is one this plugin can read back whole. */
export function isExportRecord(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const read = readExportState(value);
  return !Array.isArray(value.pages) || read.pages.length === value.pages.length;
}

/** The record to store: numbers rounded to hundredths, nothing else kept. */
export function exportRecord(state: ExportState): Record<string, unknown> {
  const round = (value: number): number => Math.round(value * 100) / 100;
  return {
    format: state.format, orientation: state.orientation, quality: state.quality,
    pages: state.pages.map((page) => ({
      id: page.id, x: round(page.x), y: round(page.y), width: round(page.width), height: round(page.height),
      ...(page.name === undefined ? {} : { name: page.name }),
    })),
  };
}
