/**
 * The marker a card's text is highlighted with.
 *
 * Highlighting stays in the text as Obsidian writes it - `==text==` - so a
 * card keeps its marks with the plugin off.  Markdown is not read inside an
 * HTML block, which is how the old converter writes rich text, so there the
 * same mark is an HTML `<mark>`.  The colour is the card's own, kept by the
 * plugin; the text only says what is marked.
 */

const FENCE = /^\s*(```|~~~)/u;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/u;
const HORIZONTAL_RULE = /^\s*([-*_])(\s*\1){2,}\s*$/u;
/** What leads a Markdown line and stays outside its mark: a heading, a quote, a list item, a task. */
const LEAD = /^(\s*(?:#{1,6}\s+|>\s*)*(?:(?:[-*+]|\d+[.)])\s+)?(?:\[[ xX]\]\s+)?)/u;
const HTML_BLOCK = /^\s*</u;
const MARK_TAG = /<\/?mark(?:\s[^>]*)?>/giu;
/** Block elements whose content a mark goes round. */
const HTML_TEXT_BLOCK = /(<(p|li|h[1-6]|td|th|blockquote)(?:\s[^>]*)?>)([\s\S]*?)(<\/\2>)/giu;

/** Whether a card's text is written as an HTML block, where Markdown marks do nothing. */
export function isHtmlText(text: string): boolean {
  return HTML_BLOCK.test(text);
}

/** Whether any of a card's text is marked. */
export function hasHighlight(text: string): boolean {
  return /==[^=\n]+==/u.test(text) || /<mark(?:\s[^>]*)?>/iu.test(text);
}

/** A stretch of text marked, as the text it sits in writes a mark. */
export function markSelection(selection: string, html: boolean): string {
  if (selection.trim() === "") return selection;
  if (html) return `<mark>${selection}</mark>`;
  // A mark does not cross a line in Markdown: each line is marked on its own.
  return selection.split("\n").map((line) => markLine(line)).join("\n");
}

/** The whole of a card's text marked, leaving code, rules and table lines alone. */
export function highlightText(text: string): string {
  const clean = unhighlightText(text);
  if (isHtmlText(clean)) {
    let marked = false;
    const result = clean.replace(HTML_TEXT_BLOCK, (_, open: string, _tag: string, inner: string, close: string) => {
      if (inner.trim() === "") return `${open}${inner}${close}`;
      marked = true;
      return `${open}<mark>${inner}</mark>${close}`;
    });
    if (marked) return result;
    // Bare text in a single element: the mark goes just inside it.
    return clean.replace(/^(\s*<[^>]+>)([\s\S]*?)(<\/[^>]+>\s*)$/u, (_, open: string, inner: string, close: string) =>
      inner.trim() === "" ? `${open}${inner}${close}` : `${open}<mark>${inner}</mark>${close}`);
  }
  let fenced = false;
  return clean.split("\n").map((line) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return line;
    }
    if (fenced || TABLE_RULE.test(line) || HORIZONTAL_RULE.test(line)) return line;
    if (/^\s*\|/u.test(line)) return markTableRow(line);
    return markLine(line);
  }).join("\n");
}

/** A card's text with every mark taken off, whichever way it was written. */
export function unhighlightText(text: string): string {
  const withoutTags = text.replace(MARK_TAG, "");
  let fenced = false;
  return withoutTags.split("\n").map((line) => {
    if (FENCE.test(line)) {
      fenced = !fenced;
      return line;
    }
    return fenced ? line : line.replace(/==([^=\n]+?)==/gu, "$1");
  }).join("\n");
}

function markLine(line: string): string {
  const lead = LEAD.exec(line)?.[1] ?? "";
  const body = line.slice(lead.length);
  const trailing = /\s*$/u.exec(body)?.[0] ?? "";
  const content = body.slice(0, body.length - trailing.length);
  if (content.trim() === "") return line;
  return `${lead}==${content}==${trailing}`;
}

function markTableRow(line: string): string {
  return line.split("|").map((cell, index, cells) => {
    if (index === 0 || index === cells.length - 1) return cell;
    const trimmed = cell.trim();
    if (trimmed === "") return cell;
    const start = cell.indexOf(trimmed);
    return `${cell.slice(0, start)}==${trimmed}==${cell.slice(start + trimmed.length)}`;
  }).join("|");
}
