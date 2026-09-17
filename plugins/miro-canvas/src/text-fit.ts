/** Layout-free text estimates, for text Miro sizes to fit its container. */

const ENTITIES: Readonly<Record<string, string>> = Object.freeze({
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ",
});

/** The words a node's stored markup shows: tags, entities and markdown marks dropped. */
export function plainText(markup: unknown): string {
  if (typeof markup !== "string") return "";
  return markup
    .slice(0, 20_000)
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6])\b[^>]*>/giu, "\n")
    .replace(/<[^>]*>/gu, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/giu, (whole, name: string) => {
      if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? whole;
      const code = name[1]?.toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    })
    .replace(/^\s{0,3}(?:#{1,6}\s+|[-*+]\s+|>\s?)/gmu, "")
    .replace(/[*_~`]+/gu, "")
    .trim();
}

const MAX_NUMBERED_LINES = 5_000;

/**
 * How many lines the code a node shows has: the body of its first <pre> or
 * fenced block, or the whole text when it has neither.
 */
export function codeLineCount(markup: unknown): number {
  if (typeof markup !== "string") return 1;
  const source = markup.slice(0, 200_000);
  const pre = /<pre\b[^>]*>([\s\S]*?)<\/pre>/iu.exec(source);
  const fence = /^\s*(`{3,}|~{3,})[^\n]*\n([\s\S]*?)\n\s*\1\s*$/mu.exec(source);
  const body = pre !== null
    ? pre[1]!.replace(/<br\s*\/?>/giu, "\n").replace(/<[^>]*>/gu, "")
    : fence !== null ? fence[2]! : source;
  const lines = body.replace(/\r\n?/gu, "\n").replace(/^\n/u, "").replace(/\n$/u, "").split("\n").length;
  return Math.min(Math.max(lines, 1), MAX_NUMBERED_LINES);
}

/** A CSS string of the numbers 1 to count, one per line, for generated content. */
export function lineNumbersCss(count: number): string {
  const total = Math.min(Math.max(Math.trunc(count), 1), MAX_NUMBERED_LINES);
  return `"${Array.from({ length: total }, (_, index) => index + 1).join("\\A ")}"`;
}

export interface FitOptions {
  readonly min?: number;
  readonly max?: number;
  /** Share of each side kept clear of text. */
  readonly inset?: number;
  readonly lineHeight?: number;
  /** Average glyph advance, in ems. */
  readonly advance?: number;
}

/**
 * The largest whole font size at which the text, wrapped at word boundaries,
 * fits the box.  A word never breaks, so the longest word bounds the size too.
 * Without layout this is an estimate from an average glyph width, which is
 * what a note needs: the size is picked once, not measured every frame.
 */
export function fitFontSize(text: string, width: number, height: number, options: FitOptions = {}): number {
  const min = options.min ?? 8;
  const max = options.max ?? 64;
  if (!(width > 0) || !(height > 0)) return min;
  const inset = options.inset ?? 0.08;
  const lineHeight = options.lineHeight ?? 1.3;
  const advance = options.advance ?? 0.6;
  const innerWidth = width * (1 - 2 * inset);
  const innerHeight = height * (1 - 2 * inset);
  const paragraphs = text.split(/\n+/u).map((line) => line.trim().split(/\s+/u).filter(Boolean)).filter((words) => words.length > 0);
  if (paragraphs.length === 0) return Math.max(min, Math.min(max, Math.floor(innerHeight / lineHeight)));
  for (let size = max; size > min; size -= 1) {
    const glyph = size * advance;
    let lines = 0;
    let fits = true;
    for (const words of paragraphs) {
      let used = 0;
      lines += 1;
      for (const word of words) {
        const span = [...word].length * glyph;
        if (span > innerWidth) { fits = false; break; }
        const next = used === 0 ? span : used + glyph + span;
        if (next <= innerWidth) used = next;
        else { lines += 1; used = span; }
      }
      if (!fits) break;
    }
    if (fits && lines * size * lineHeight <= innerHeight) return size;
  }
  return min;
}
