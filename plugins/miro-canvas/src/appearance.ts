/**
 * Framework-free appearance model for the M1 Canvas UI.
 *
 * This module deliberately has no Obsidian, DOM, or CSS dependencies.  It
 * owns the values that the UI may edit and can therefore be used by a root
 * view, a command-palette adapter, or tests without booting Obsidian.
 *
 * Persistence contract (the metadata schema is intentionally not changed by
 * this module): merge `toAppearanceMetadata(state)` into `miroCanvas` as
 * `settings` and `localOverrides`.  The returned shape is:
 *
 *     {
 *       settings: {
 *         displayTheme: "system" | "light" | "dark",
 *         palette: [{ id, label, color, source }],
 *         recentColors: ["#rrggbb" | "#rrggbbaa"]
 *       },
 *       localOverrides: {
 *         "canvas-node-id": {
 *           typography: {
 *             fontFamily, fontSize,
 *             format: { bold, italic, underline, strike },
 *             alignment, lineHeight, verticalAlign
 *           },
 *           colors: { text, fill, border, edge }
 *         }
 *       }
 *     }
 *
 * `miroSource` is never read or modified here.  A metadata writer should
 * merge this owned subset with the rest of `miroCanvas` in one explicit
 * transaction.  Transparent colors are represented by `null` in the model
 * and payload; CSS is only produced by a consuming renderer after validation.
 */

export const DEFAULT_FONT_FAMILY = "Inter" as const;
export const DEFAULT_FONT_SIZE = 16 as const;
export const MIN_FONT_SIZE = 6 as const;
export const MAX_FONT_SIZE = 256 as const;
export const DEFAULT_LINE_HEIGHT = 1.2 as const;
export const MIN_LINE_HEIGHT = 0.5 as const;
export const MAX_LINE_HEIGHT = 4 as const;
export const MAX_PALETTE_COLORS = 128 as const;
export const MAX_RECENT_COLORS = 12 as const;

export type DisplayTheme = "system" | "light" | "dark";
export type AppearanceTheme = DisplayTheme;
export type ResolvedDisplayTheme = Exclude<DisplayTheme, "system">;

export type TextAlignment = "left" | "center" | "right" | "justify";
export type VerticalAlign = "top" | "center" | "bottom";
export type VerticalAlignment = VerticalAlign;

export type ColorSlot = "text" | "fill" | "border" | "edge";

/** A canonical opaque/alpha hex color, or null for a transparent/cleared slot. */
export type AppearanceColor = string | null;
export type CanvasColor = AppearanceColor;

export type PaletteSource = "miro" | "obsidian" | "custom";

export interface TypographyFormat {
  readonly bold: boolean;
  readonly italic: boolean;
  readonly underline: boolean;
  readonly strike: boolean;
  readonly [key: string]: unknown;
}

export interface TypographySettings {
  readonly fontFamily: string;
  readonly fontSize: number;
  readonly format: TypographyFormat;
  readonly alignment: TextAlignment;
  readonly lineHeight?: number;
  readonly verticalAlign?: VerticalAlign;
  readonly [key: string]: unknown;
}

export type Typography = TypographySettings;
export type AppearanceTypography = TypographySettings;
export type TypographyStyle = TypographyFormat;
export type FontFormat = TypographyFormat;

/** A palette item is safe to display as text and safe to use as a color token. */
export interface PaletteColor {
  readonly id: string;
  readonly label: string;
  readonly color: string;
  readonly source: PaletteSource;
  readonly [key: string]: unknown;
}

export interface ColorSettings {
  readonly text: AppearanceColor;
  readonly fill: AppearanceColor;
  readonly border: AppearanceColor;
  readonly edge: AppearanceColor;
  readonly [key: string]: unknown;
}

export type ColorMap = ColorSettings;
export type AppearanceColorMap = ColorSettings;

export interface AppearanceSettings {
  readonly displayTheme: DisplayTheme;
  readonly palette: readonly PaletteColor[];
  readonly recentColors: readonly string[];
  /** Settings owned by the adjacent M1 interaction/navigation reducers. */
  readonly reviewMode?: boolean;
  readonly showAttachmentNames?: boolean;
  readonly minimapVisible?: boolean;
  readonly [key: string]: unknown;
}

export interface AppearanceLocalOverride {
  readonly typography?: TypographySettings;
  readonly colors?: ColorSettings;
  /** Preserved so appearance actions cannot erase other M1 overrides. */
  readonly locked?: boolean;
  readonly showAttachmentName?: boolean;
  readonly [key: string]: unknown;
}

export interface AppearanceState {
  readonly settings: AppearanceSettings;
  readonly localOverrides: Readonly<Record<string, AppearanceLocalOverride>>;
}

export interface AppearanceMetadataPayload {
  readonly settings: AppearanceSettings;
  readonly localOverrides: Readonly<Record<string, AppearanceLocalOverride>>;
}

export interface AppearanceDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface AppearanceValidationResult<T> {
  readonly valid: boolean;
  readonly value?: T;
  readonly diagnostics: readonly AppearanceDiagnostic[];
}

export const DEFAULT_TYPOGRAPHY: TypographySettings = Object.freeze({
  fontFamily: DEFAULT_FONT_FAMILY,
  fontSize: DEFAULT_FONT_SIZE,
  format: Object.freeze({
    bold: false,
    italic: false,
    underline: false,
    strike: false,
  }),
  alignment: "left",
  lineHeight: DEFAULT_LINE_HEIGHT,
  verticalAlign: "top",
});

export const DEFAULT_COLORS: ColorSettings = Object.freeze({
  text: "#1e1e1e",
  fill: null,
  border: "#1e1e1e",
  edge: "#1e1e1e",
});

const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const COLOR_SLOTS: readonly ColorSlot[] = ["text", "fill", "border", "edge"];
const TEXT_ALIGNMENTS: readonly TextAlignment[] = ["left", "center", "right", "justify"];
const TYPOGRAPHY_FIELDS = new Set([
  "fontFamily",
  "fontSize",
  "format",
  "alignment",
  "lineHeight",
  "verticalAlign",
  // M0/M1 schema aliases accepted on input and replaced by the canonical
  // nested format/alignment representation on an explicit appearance edit.
  "fontWeight",
  "fontStyle",
  "textDecoration",
  "textAlign",
]);
const COLOR_FIELDS = new Set(["text", "fill", "border", "edge"]);
const SETTINGS_FIELDS = new Set([
  "displayTheme",
  "palette",
  "recentColors",
  "reviewMode",
  "showAttachmentNames",
  "minimapVisible",
]);
const OVERRIDE_FIELDS = new Set(["typography", "colors", "locked", "showAttachmentName"]);
const DISPLAY_THEMES: readonly DisplayTheme[] = ["system", "light", "dark"];
const PALETTE_SOURCES: readonly PaletteSource[] = ["miro", "obsidian", "custom"];

const BUILTIN_PALETTE: readonly PaletteColor[] = [
  { id: "miro-black", label: "Black", color: "#1e1e1e", source: "miro" },
  { id: "miro-white", label: "White", color: "#ffffff", source: "miro" },
  { id: "miro-red", label: "Red", color: "#f24726", source: "miro" },
  { id: "miro-orange", label: "Orange", color: "#ff9d48", source: "miro" },
  { id: "miro-yellow", label: "Yellow", color: "#ffd02f", source: "miro" },
  { id: "miro-green", label: "Green", color: "#67c6a0", source: "miro" },
  { id: "miro-blue", label: "Blue", color: "#4262ff", source: "miro" },
  { id: "miro-purple", label: "Purple", color: "#9b51e0", source: "miro" },
  { id: "obsidian-red", label: "Obsidian red", color: "#e06c75", source: "obsidian" },
  { id: "obsidian-orange", label: "Obsidian orange", color: "#d19a66", source: "obsidian" },
  { id: "obsidian-yellow", label: "Obsidian yellow", color: "#e5c07b", source: "obsidian" },
  { id: "obsidian-green", label: "Obsidian green", color: "#98c379", source: "obsidian" },
  { id: "obsidian-cyan", label: "Obsidian cyan", color: "#56b6c2", source: "obsidian" },
  { id: "obsidian-blue", label: "Obsidian blue", color: "#61afef", source: "obsidian" },
  { id: "obsidian-purple", label: "Obsidian purple", color: "#c678dd", source: "obsidian" },
  { id: "obsidian-gray", label: "Obsidian gray", color: "#abb2bf", source: "obsidian" },
  // The six presets native Canvas offers in its own colour picker, so a board
  // styled here keeps matching one styled with the plugin switched off.
  { id: "canvas-red", label: "Canvas red", color: "#fb464c", source: "obsidian" },
  { id: "canvas-orange", label: "Canvas orange", color: "#e9973f", source: "obsidian" },
  { id: "canvas-yellow", label: "Canvas yellow", color: "#e0de71", source: "obsidian" },
  { id: "canvas-green", label: "Canvas green", color: "#44cf6e", source: "obsidian" },
  { id: "canvas-cyan", label: "Canvas cyan", color: "#53dfdd", source: "obsidian" },
  { id: "canvas-purple", label: "Canvas purple", color: "#a882ff", source: "obsidian" },
].map((item) => Object.freeze(item) as PaletteColor);

export const DEFAULT_PALETTE: readonly PaletteColor[] = Object.freeze(BUILTIN_PALETTE);

type UnknownRecord = Record<string, unknown>;
const ABSENT = Symbol("appearance-absent");
const INVALID = Symbol("appearance-invalid");

function isRecord(value: unknown): value is UnknownRecord {
  if (value === null || typeof value !== "object") {
    return false;
  }
  try {
    return !Array.isArray(value);
  } catch {
    return false;
  }
}

function readOwn(record: UnknownRecord, key: string): unknown | typeof ABSENT {
  try {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      return ABSENT;
    }
    return record[key];
  } catch {
    return ABSENT;
  }
}

function ownKeys(record: UnknownRecord): readonly string[] {
  try {
    return Object.keys(record);
  } catch {
    return [];
  }
}

/** Read array indices without invoking a caller-provided iterator or method. */
function readArray(value: unknown): readonly unknown[] | null {
  let arrayValue: boolean;
  try {
    arrayValue = Array.isArray(value);
  } catch {
    return null;
  }
  if (!arrayValue) {
    return null;
  }
  let length: unknown;
  try {
    length = (value as unknown as { readonly length: unknown }).length;
  } catch {
    return null;
  }
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > 100_000) {
    return null;
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const item = readOwn(value as unknown as UnknownRecord, String(index));
    if (item !== ABSENT) {
      result.push(item);
    }
  }
  return result;
}

function freeze<T>(value: T): T {
  return Object.freeze(value);
}

function isSafeObjectKey(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const key = value.trim();
  if (key.length === 0 || key.length > 256 || RESERVED_KEYS.has(key.toLowerCase())) {
    return false;
  }
  return !/[\u0000-\u001f\u007f]/u.test(key);
}

function isSafeLabel(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const label = value.trim();
  if (label.length === 0 || label.length > 80) {
    return false;
  }
  return !/[\u0000-\u001f\u007f<>]/u.test(label);
}

function defineOwn<T extends object>(record: T, key: string, value: unknown): void {
  Object.defineProperty(record, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

/**
 * Copy a JSON-shaped value without retaining references to caller-owned
 * unknown fields.  Appearance only interprets a small owned subset; all other
 * fields are carried through as opaque JSON so a newer M2/M3 feature cannot be
 * erased by an M1 edit.  Unsupported values fail closed and are omitted by
 * `copyUnknownProperties`.
 */
function cloneUnknown(value: unknown, visiting = new Set<object>()): unknown | typeof INVALID {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : INVALID;
  }
  if (typeof value !== "object") {
    return INVALID;
  }
  if (visiting.has(value)) {
    return INVALID;
  }
  visiting.add(value);
  try {
    if (Array.isArray(value)) {
      const length = (value as unknown as { readonly length?: unknown }).length;
      if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > 100_000) {
        return INVALID;
      }
      const result: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const item = readOwn(value as unknown as UnknownRecord, String(index));
        if (item === ABSENT) {
          return INVALID;
        }
        const copy = cloneUnknown(item, visiting);
        if (copy === INVALID) {
          return INVALID;
        }
        result.push(copy);
      }
      for (const key of ownKeys(value as unknown as UnknownRecord)) {
        if (!/^\d+$/u.test(key) || Number(key) >= length || String(Number(key)) !== key) {
          return INVALID;
        }
      }
      return result;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) {
      return INVALID;
    }
    const result: UnknownRecord = {};
    for (const key of ownKeys(value as UnknownRecord)) {
      if (!isSafeObjectKey(key)) {
        return INVALID;
      }
      const item = readOwn(value as UnknownRecord, key);
      if (item === ABSENT) {
        return INVALID;
      }
      const copy = cloneUnknown(item, visiting);
      if (copy === INVALID) {
        return INVALID;
      }
      defineOwn(result, key, copy);
    }
    return result;
  } catch {
    return INVALID;
  } finally {
    visiting.delete(value);
  }
}

function copyUnknownProperties(source: UnknownRecord, known: ReadonlySet<string>): UnknownRecord {
  const result: UnknownRecord = {};
  for (const key of ownKeys(source)) {
    if (known.has(key) || !isSafeObjectKey(key)) {
      continue;
    }
    const value = readOwn(source, key);
    if (value === ABSENT) {
      continue;
    }
    const copy = cloneUnknown(value);
    if (copy !== INVALID) {
      defineOwn(result, key, copy);
    }
  }
  return result;
}

function isOneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

export function isDisplayTheme(value: unknown): value is DisplayTheme {
  return isOneOf(value, DISPLAY_THEMES);
}

export function normalizeDisplayTheme(value: unknown, fallback: DisplayTheme = "system"): DisplayTheme {
  return isDisplayTheme(value) ? value : isDisplayTheme(fallback) ? fallback : "system";
}

/** Resolve a board theme using an already-known system preference. */
export function resolveDisplayTheme(
  theme: unknown,
  systemTheme: unknown = "light",
): ResolvedDisplayTheme {
  const normalizedTheme = normalizeDisplayTheme(theme);
  if (normalizedTheme !== "system") {
    return normalizedTheme;
  }
  return systemTheme === "dark" ? "dark" : "light";
}

export function isTextAlignment(value: unknown): value is TextAlignment {
  return isOneOf(value, TEXT_ALIGNMENTS);
}

export function normalizeTextAlignment(value: unknown, fallback: TextAlignment = "left"): TextAlignment {
  if (value === "start") {
    return "left";
  }
  if (value === "end") {
    return "right";
  }
  if (value === "centre") {
    return "center";
  }
  return isTextAlignment(value) ? value : isTextAlignment(fallback) ? fallback : "left";
}

export function isColorSlot(value: unknown): value is ColorSlot {
  return isOneOf(value, COLOR_SLOTS);
}

function parseColor(value: unknown): AppearanceColor | typeof INVALID {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    return INVALID;
  }
  const candidate = value.trim().toLowerCase();
  if (candidate === "transparent") {
    return null;
  }
  if (/^#[0-9a-f]{3}$/u.test(candidate)) {
    return `#${candidate[1]}${candidate[1]}${candidate[2]}${candidate[2]}${candidate[3]}${candidate[3]}`;
  }
  if (/^#[0-9a-f]{4}$/u.test(candidate)) {
    return `#${candidate[1]}${candidate[1]}${candidate[2]}${candidate[2]}${candidate[3]}${candidate[3]}${candidate[4]}${candidate[4]}`;
  }
  if (/^#[0-9a-f]{6}$/u.test(candidate) || /^#[0-9a-f]{8}$/u.test(candidate)) {
    return candidate;
  }
  return INVALID;
}

export function isValidColor(value: unknown): value is AppearanceColor {
  return parseColor(value) !== INVALID;
}

export const isSafeColor = isValidColor;

export function normalizeColor(value: unknown, fallback: AppearanceColor = null): AppearanceColor {
  const parsed = parseColor(value);
  if (parsed !== INVALID) {
    return parsed;
  }
  const parsedFallback = parseColor(fallback);
  return parsedFallback === INVALID ? null : parsedFallback;
}

export const normalizeHexColor = normalizeColor;

export function colorToCss(value: unknown): string {
  const normalized = normalizeColor(value);
  return normalized ?? "transparent";
}

export const toCssColor = colorToCss;

function validFontFamily(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const candidate = value.trim();
  if (candidate.length === 0 || candidate.length > 128) {
    return false;
  }
  // Font names are intentionally narrower than the CSS grammar.  Quoting,
  // delimiters, functions, and custom-property syntax cannot cross this API
  // boundary, so a caller can safely place the normalized value in a style.
  if (!/^[\p{L}\p{N}][\p{L}\p{N} _.-]*(?:,\s*[\p{L}\p{N}][\p{L}\p{N} _.-]*)*$/u.test(candidate)) {
    return false;
  }
  return !/(?:^|[\s,])(url|var|expression|javascript|import)(?:[\s,(]|$)/iu.test(candidate);
}

export function isSafeFontFamily(value: unknown): value is string {
  return validFontFamily(value);
}

export function normalizeFontFamily(value: unknown, fallback: string = DEFAULT_FONT_FAMILY): string {
  if (validFontFamily(value)) {
    return value.trim();
  }
  return validFontFamily(fallback) ? fallback.trim() : DEFAULT_FONT_FAMILY;
}

export function isValidFontSize(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= MIN_FONT_SIZE && value <= MAX_FONT_SIZE;
}

export function normalizeFontSize(value: unknown, fallback: number = DEFAULT_FONT_SIZE): number {
  if (isValidFontSize(value)) {
    return Math.round(value * 100) / 100;
  }
  return isValidFontSize(fallback) ? Math.round(fallback * 100) / 100 : DEFAULT_FONT_SIZE;
}

export function isValidLineHeight(value: unknown): value is number {
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= MIN_LINE_HEIGHT
    && value <= MAX_LINE_HEIGHT;
}

export function normalizeLineHeight(value: unknown, fallback: number = DEFAULT_LINE_HEIGHT): number {
  if (isValidLineHeight(value)) {
    return Math.round(value * 100) / 100;
  }
  return isValidLineHeight(fallback) ? Math.round(fallback * 100) / 100 : DEFAULT_LINE_HEIGHT;
}

export function isVerticalAlign(value: unknown): value is VerticalAlign | "middle" {
  return value === "top" || value === "center" || value === "bottom" || value === "middle";
}

export function normalizeVerticalAlign(value: unknown, fallback: VerticalAlign | "middle" = "top"): VerticalAlign {
  if (value === "middle") {
    return "center";
  }
  if (value === "top" || value === "center" || value === "bottom") {
    return value;
  }
  return fallback === "middle" ? "center" : fallback;
}

export function isTypographyFormat(value: unknown): value is TypographyFormat {
  if (!isRecord(value)) {
    return false;
  }
  return ["bold", "italic", "underline", "strike"].every((field) => readOwn(value, field) !== ABSENT
    && typeof readOwn(value, field) === "boolean");
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function normalizeTypographyFormat(
  value: unknown,
  fallback: TypographyFormat = DEFAULT_TYPOGRAPHY.format,
): TypographyFormat {
  const fallbackRecord = isRecord(fallback as unknown)
    ? fallback as unknown as UnknownRecord
    : DEFAULT_TYPOGRAPHY.format as unknown as UnknownRecord;
  const fallbackBold = readOwn(fallbackRecord, "bold");
  const fallbackItalic = readOwn(fallbackRecord, "italic");
  const fallbackUnderline = readOwn(fallbackRecord, "underline");
  const fallbackStrike = readOwn(fallbackRecord, "strike");
  const base: TypographyFormat = {
    bold: normalizeBoolean(fallbackBold, false),
    italic: normalizeBoolean(fallbackItalic, false),
    underline: normalizeBoolean(fallbackUnderline, false),
    strike: normalizeBoolean(fallbackStrike, false),
  };
  if (typeof value === "string") {
    const words = value.toLowerCase().split(/[\s+,|]+/u).filter(Boolean);
    if (words.includes("normal")) {
      return freeze({ bold: false, italic: false, underline: false, strike: false });
    }
    return freeze({
      bold: words.includes("bold") || base.bold,
      italic: words.includes("italic") || base.italic,
      underline: words.includes("underline") || base.underline,
      strike: words.includes("strike") || words.includes("strikethrough") || base.strike,
    });
  }
  if (!isRecord(value)) {
    return freeze(base);
  }
  const strike = readOwn(value, "strike");
  const strikethrough = readOwn(value, "strikethrough");
  const normalized = {
    ...copyUnknownProperties(value, new Set(["bold", "italic", "underline", "strike", "strikethrough"])),
    bold: normalizeBoolean(readOwn(value, "bold"), base.bold),
    italic: normalizeBoolean(readOwn(value, "italic"), base.italic),
    underline: normalizeBoolean(readOwn(value, "underline"), base.underline),
    strike: normalizeBoolean(strike !== ABSENT ? strike : strikethrough, base.strike),
  };
  return freeze(normalized);
}

export function normalizeTypography(
  value: unknown,
  fallback: TypographySettings = DEFAULT_TYPOGRAPHY,
): TypographySettings {
  const fallbackRecord = isRecord(fallback as unknown)
    ? fallback as unknown as UnknownRecord
    : DEFAULT_TYPOGRAPHY as unknown as UnknownRecord;
  const fallbackFontFamily = readOwn(fallbackRecord, "fontFamily");
  const fallbackFontSize = readOwn(fallbackRecord, "fontSize");
  const fallbackFormat = readOwn(fallbackRecord, "format");
  const fallbackAlignment = readOwn(fallbackRecord, "alignment");
  const fallbackLineHeight = readOwn(fallbackRecord, "lineHeight");
  const fallbackVerticalAlign = readOwn(fallbackRecord, "verticalAlign");
  const base = {
    fontFamily: normalizeFontFamily(fallbackFontFamily),
    fontSize: normalizeFontSize(fallbackFontSize),
    format: normalizeTypographyFormat(fallbackFormat, DEFAULT_TYPOGRAPHY.format),
    alignment: normalizeTextAlignment(fallbackAlignment),
    lineHeight: normalizeLineHeight(fallbackLineHeight),
    verticalAlign: normalizeVerticalAlign(fallbackVerticalAlign),
  };
  if (!isRecord(value)) {
    const fallbackUnknown = isRecord(fallback)
      ? copyUnknownProperties(fallback as unknown as UnknownRecord, TYPOGRAPHY_FIELDS)
      : {};
    return freeze({ ...fallbackUnknown, ...base });
  }
  const fontFamily = readOwn(value, "fontFamily");
  const fontSize = readOwn(value, "fontSize");
  const format = readOwn(value, "format");
  const alignment = readOwn(value, "alignment");
  const lineHeight = readOwn(value, "lineHeight");
  const verticalAlign = readOwn(value, "verticalAlign");
  const fontWeight = readOwn(value, "fontWeight");
  const fontStyle = readOwn(value, "fontStyle");
  const textDecoration = readOwn(value, "textDecoration");
  const textAlign = readOwn(value, "textAlign");
  let schemaFormat: unknown = format;
  if (schemaFormat === ABSENT) {
    const hasLegacyFormat = fontWeight !== ABSENT || fontStyle !== ABSENT || textDecoration !== ABSENT;
    schemaFormat = hasLegacyFormat
      ? {
        bold: fontWeight === "bold" || (typeof fontWeight === "number" && fontWeight >= 600),
        italic: fontStyle === "italic",
        underline: typeof textDecoration === "string" && textDecoration.toLowerCase().includes("underline"),
        strike: typeof textDecoration === "string" && textDecoration.toLowerCase().includes("line-through"),
      }
      : base.format;
  }
  const unknown = {
    ...(isRecord(fallback) ? copyUnknownProperties(fallback as unknown as UnknownRecord, TYPOGRAPHY_FIELDS) : {}),
    ...copyUnknownProperties(value, TYPOGRAPHY_FIELDS),
  };
  const normalized: TypographySettings = {
    ...unknown,
    fontFamily: fontFamily === ABSENT ? base.fontFamily : normalizeFontFamily(fontFamily, base.fontFamily),
    fontSize: fontSize === ABSENT ? base.fontSize : normalizeFontSize(fontSize, base.fontSize),
    format: normalizeTypographyFormat(schemaFormat, base.format),
    alignment: alignment !== ABSENT
      ? normalizeTextAlignment(alignment, base.alignment)
      : normalizeTextAlignment(textAlign, base.alignment),
    lineHeight: lineHeight === ABSENT
      ? base.lineHeight
      : normalizeLineHeight(lineHeight, base.lineHeight),
    verticalAlign: verticalAlign === ABSENT
      ? base.verticalAlign
      : normalizeVerticalAlign(verticalAlign, base.verticalAlign),
  };
  // The normalized model is always complete.  Legacy M0 records may omit
  // these fields, but all new payloads carry deterministic values so a
  // reducer/writer never has to guess which typography controls are active.
  return freeze(normalized);
}

export const normalizeTypographySettings = normalizeTypography;

export function normalizeColors(
  value: unknown,
  fallback: ColorSettings = DEFAULT_COLORS,
): ColorSettings {
  const fallbackRecord = isRecord(fallback as unknown)
    ? fallback as unknown as UnknownRecord
    : DEFAULT_COLORS as unknown as UnknownRecord;
  const fallbackText = readOwn(fallbackRecord, "text");
  const fallbackFill = readOwn(fallbackRecord, "fill");
  const fallbackBorder = readOwn(fallbackRecord, "border");
  const fallbackEdge = readOwn(fallbackRecord, "edge");
  const base: ColorSettings = {
    text: normalizeColor(fallbackText),
    fill: normalizeColor(fallbackFill),
    border: normalizeColor(fallbackBorder),
    edge: normalizeColor(fallbackEdge),
  };
  if (!isRecord(value)) {
    const fallbackUnknown = isRecord(fallback)
      ? copyUnknownProperties(fallback as unknown as UnknownRecord, COLOR_FIELDS)
      : {};
    return freeze({ ...fallbackUnknown, ...base });
  }
  const unknown = {
    ...(isRecord(fallback) ? copyUnknownProperties(fallback as unknown as UnknownRecord, COLOR_FIELDS) : {}),
    ...copyUnknownProperties(value, COLOR_FIELDS),
  };
  return freeze({
    ...unknown,
    text: normalizeColor(readOwn(value, "text"), base.text),
    fill: normalizeColor(readOwn(value, "fill"), base.fill),
    border: normalizeColor(readOwn(value, "border"), base.border),
    edge: normalizeColor(readOwn(value, "edge"), base.edge),
  });
}

export const normalizeColorSettings = normalizeColors;

function paletteIdForColor(color: string): string {
  return `custom-${color.slice(1).replace(/[^0-9a-f]/gu, "")}`;
}

function normalizePaletteSource(value: unknown, fallback: PaletteSource = "custom"): PaletteSource {
  return isOneOf(value, PALETTE_SOURCES) ? value : fallback;
}

function normalizePaletteEntry(value: unknown, index: number): PaletteColor | undefined {
  let rawColor: unknown = value;
  let rawId: unknown = ABSENT;
  let rawLabel: unknown = ABSENT;
  let rawSource: unknown = ABSENT;
  if (isRecord(value)) {
    rawColor = readOwn(value, "color");
    if (rawColor === ABSENT) {
      rawColor = readOwn(value, "value");
    }
    rawId = readOwn(value, "id");
    rawLabel = readOwn(value, "label");
    rawSource = readOwn(value, "source");
  }
  const color = parseColor(rawColor);
  if (color === INVALID || color === null) {
    return undefined;
  }
  const suppliedId = rawId === ABSENT ? undefined : rawId;
  const id = isSafeObjectKey(suppliedId) ? suppliedId.trim() : paletteIdForColor(color);
  const suppliedLabel = rawLabel === ABSENT ? undefined : rawLabel;
  const label = isSafeLabel(suppliedLabel) ? suppliedLabel.trim() : `Color ${index + 1}`;
  const unknown = isRecord(value)
    ? copyUnknownProperties(value, new Set(["id", "label", "color", "value", "source"]))
    : {};
  return freeze({
    ...unknown,
    id,
    label,
    color,
    source: normalizePaletteSource(rawSource),
  });
}

function cloneDefaultPalette(): readonly PaletteColor[] {
  return freeze(DEFAULT_PALETTE.map((item) => freeze({ ...item })));
}

export function normalizePalette(value: unknown, fallback: readonly PaletteColor[] = DEFAULT_PALETTE): readonly PaletteColor[] {
  const input = readArray(value);
  const source = input ?? readArray(fallback) ?? [];
  const result: PaletteColor[] = [];
  const seen = new Set<string>();
  source.slice(0, MAX_PALETTE_COLORS).forEach((item, index) => {
    const normalized = normalizePaletteEntry(item, index);
    if (normalized === undefined || seen.has(normalized.color)) {
      return;
    }
    seen.add(normalized.color);
    result.push(normalized);
  });
  if (result.length === 0 && input !== null) {
    return cloneDefaultPalette();
  }
  return freeze(result);
}

export const normalizeExpandedPalette = normalizePalette;

export function normalizeRecentColors(
  value: unknown,
  max: number = MAX_RECENT_COLORS,
): readonly string[] {
  const input = readArray(value) ?? [];
  const limit = Number.isSafeInteger(max) && max >= 0 ? Math.min(max, MAX_RECENT_COLORS) : MAX_RECENT_COLORS;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    const color = parseColor(item);
    if (color === INVALID || color === null || seen.has(color)) {
      continue;
    }
    seen.add(color);
    result.push(color);
    if (result.length >= limit) {
      break;
    }
  }
  return freeze(result);
}

export function addRecentColor(
  recentColors: unknown,
  color: unknown,
  max: number = MAX_RECENT_COLORS,
): readonly string[] {
  const parsed = parseColor(color);
  if (parsed === INVALID || parsed === null) {
    return normalizeRecentColors(recentColors, max);
  }
  return normalizeRecentColors([parsed, ...(readArray(recentColors) ?? [])], max);
}

export const recordRecentColor = addRecentColor;

function normalizeSettings(value: unknown): AppearanceSettings {
  const source = isRecord(value) ? value : {};
  const reviewMode = readOwn(source, "reviewMode");
  const showAttachmentNames = readOwn(source, "showAttachmentNames");
  const minimapVisible = readOwn(source, "minimapVisible");
  return freeze({
    ...copyUnknownProperties(source, SETTINGS_FIELDS),
    displayTheme: normalizeDisplayTheme(readOwn(source, "displayTheme")),
    palette: normalizePalette(readOwn(source, "palette")),
    recentColors: normalizeRecentColors(readOwn(source, "recentColors")),
    ...(typeof reviewMode === "boolean" ? { reviewMode } : {}),
    ...(typeof showAttachmentNames === "boolean" ? { showAttachmentNames } : {}),
    ...(typeof minimapVisible === "boolean" ? { minimapVisible } : {}),
  });
}

function normalizeOverride(value: unknown): AppearanceLocalOverride | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const typography = readOwn(value, "typography");
  const colors = readOwn(value, "colors");
  const locked = readOwn(value, "locked");
  const showAttachmentName = readOwn(value, "showAttachmentName");
  const normalized: AppearanceLocalOverride = {
    ...copyUnknownProperties(value, OVERRIDE_FIELDS),
    ...(typography === ABSENT || !isRecord(typography) ? {} : { typography: normalizeTypography(typography) }),
    ...(colors === ABSENT || !isRecord(colors) ? {} : { colors: normalizeColors(colors) }),
    ...(typeof locked === "boolean" ? { locked } : {}),
    ...(typeof showAttachmentName === "boolean" ? { showAttachmentName } : {}),
  };
  return Object.keys(normalized).length === 0 ? undefined : freeze(normalized);
}

function normalizeLocalOverrides(value: unknown): Readonly<Record<string, AppearanceLocalOverride>> {
  const result: Record<string, AppearanceLocalOverride> = {};
  if (!isRecord(value)) {
    return freeze(result);
  }
  for (const key of ownKeys(value)) {
    if (!isSafeObjectKey(key)) {
      continue;
    }
    const override = normalizeOverride(readOwn(value, key));
    if (override !== undefined) {
      defineOwn(result, key, override);
    }
  }
  return freeze(result);
}

/** Normalize unknown persisted/input data into a detached, frozen model. */
export function normalizeAppearanceState(value: unknown): AppearanceState {
  let source = isRecord(value) ? value : {};
  const wrapper = readOwn(source, "miroCanvas");
  if (wrapper !== ABSENT && isRecord(wrapper)) {
    source = wrapper;
  }
  const settingsValue = readOwn(source, "settings");
  const settings = normalizeSettings(settingsValue === ABSENT ? source : settingsValue);
  const overrides = normalizeLocalOverrides(readOwn(source, "localOverrides"));
  return freeze({ settings, localOverrides: overrides });
}

export const normalizeAppearance = normalizeAppearanceState;

export function createDefaultAppearanceState(): AppearanceState {
  return freeze({
    settings: freeze({
      displayTheme: "system",
      palette: cloneDefaultPalette(),
      recentColors: freeze([]),
    }),
    localOverrides: freeze({}),
  });
}

export const createDefaultAppearance = createDefaultAppearanceState;

function addDiagnostic(
  diagnostics: AppearanceDiagnostic[],
  code: string,
  path: string,
  message: string,
): void {
  diagnostics.push({ code, path, message });
}

function validateTypographyValue(value: unknown, path: string, diagnostics: AppearanceDiagnostic[]): void {
  if (!isRecord(value)) {
    addDiagnostic(diagnostics, "object-expected", path, "Typography must be an object.");
    return;
  }
  const fontFamily = readOwn(value, "fontFamily");
  if (fontFamily !== ABSENT && !isSafeFontFamily(fontFamily)) {
    addDiagnostic(diagnostics, "font-family-invalid", `${path}.fontFamily`, "Font family contains unsupported CSS syntax.");
  }
  const fontSize = readOwn(value, "fontSize");
  if (fontSize !== ABSENT && !isValidFontSize(fontSize)) {
    addDiagnostic(diagnostics, "font-size-invalid", `${path}.fontSize`, `Font size must be finite and between ${MIN_FONT_SIZE} and ${MAX_FONT_SIZE}.`);
  }
  const format = readOwn(value, "format");
  if (format !== ABSENT) {
    if (typeof format === "string") {
      const words = format.toLowerCase().split(/[\s+,|]+/u).filter(Boolean);
      if (words.some((word) => !["normal", "bold", "italic", "underline", "strike", "strikethrough"].includes(word))) {
        addDiagnostic(diagnostics, "format-invalid", `${path}.format`, "Typography format contains an unknown value.");
      }
    } else if (!isRecord(format)) {
      addDiagnostic(diagnostics, "format-invalid", `${path}.format`, "Typography format must be an object or known string.");
    } else {
      for (const field of ["bold", "italic", "underline", "strike", "strikethrough"]) {
        const item = readOwn(format, field);
        if (item !== ABSENT && typeof item !== "boolean") {
          addDiagnostic(diagnostics, "format-flag-invalid", `${path}.format.${field}`, "Format flags must be boolean.");
        }
      }
    }
  }
  const alignment = readOwn(value, "alignment");
  if (alignment !== ABSENT && !isTextAlignment(alignment)
    && alignment !== "start" && alignment !== "end" && alignment !== "centre") {
    addDiagnostic(diagnostics, "alignment-invalid", `${path}.alignment`, "Alignment is not supported.");
  }
  const textAlign = readOwn(value, "textAlign");
  if (textAlign !== ABSENT && !isTextAlignment(textAlign)
    && textAlign !== "start" && textAlign !== "end" && textAlign !== "centre") {
    addDiagnostic(diagnostics, "alignment-invalid", `${path}.textAlign`, "Text alignment is not supported.");
  }
  const lineHeight = readOwn(value, "lineHeight");
  if (lineHeight !== ABSENT && !isValidLineHeight(lineHeight)) {
    addDiagnostic(diagnostics, "line-height-invalid", `${path}.lineHeight`, `Line height must be finite and between ${MIN_LINE_HEIGHT} and ${MAX_LINE_HEIGHT}.`);
  }
  const verticalAlign = readOwn(value, "verticalAlign");
  if (verticalAlign !== ABSENT && !isVerticalAlign(verticalAlign)) {
    addDiagnostic(diagnostics, "vertical-align-invalid", `${path}.verticalAlign`, "Vertical alignment is not supported.");
  }
  const fontStyle = readOwn(value, "fontStyle");
  if (fontStyle !== ABSENT && fontStyle !== "normal" && fontStyle !== "italic") {
    addDiagnostic(diagnostics, "font-style-invalid", `${path}.fontStyle`, "Font style must be normal or italic.");
  }
  const textDecoration = readOwn(value, "textDecoration");
  if (textDecoration !== ABSENT && textDecoration !== "none" && textDecoration !== "underline"
    && textDecoration !== "line-through" && textDecoration !== "underline line-through"
    && textDecoration !== "line-through underline") {
    addDiagnostic(diagnostics, "text-decoration-invalid", `${path}.textDecoration`, "Text decoration is not supported.");
  }
  const fontWeight = readOwn(value, "fontWeight");
  if (fontWeight !== ABSENT && fontWeight !== "normal" && fontWeight !== "bold"
    && (typeof fontWeight !== "number" || !Number.isInteger(fontWeight)
      || fontWeight < 100 || fontWeight > 900 || fontWeight % 100 !== 0)) {
    addDiagnostic(diagnostics, "font-weight-invalid", `${path}.fontWeight`, "Font weight must be normal, bold, or 100-900.");
  }
}

export function validateTypography(value: unknown): AppearanceValidationResult<TypographySettings> {
  const diagnostics: AppearanceDiagnostic[] = [];
  validateTypographyValue(value, "typography", diagnostics);
  return diagnostics.length > 0
    ? { valid: false, diagnostics: freeze(diagnostics) }
    : { valid: true, value: normalizeTypography(value), diagnostics: freeze([]) };
}

function validateColorValue(value: unknown, path: string, diagnostics: AppearanceDiagnostic[]): void {
  if (!isValidColor(value)) {
    addDiagnostic(diagnostics, "color-invalid", path, "Color must be a hex color or transparent/null.");
  }
}

export function validateColor(value: unknown): AppearanceValidationResult<AppearanceColor> {
  const diagnostics: AppearanceDiagnostic[] = [];
  validateColorValue(value, "color", diagnostics);
  return diagnostics.length > 0
    ? { valid: false, diagnostics: freeze(diagnostics) }
    : { valid: true, value: normalizeColor(value), diagnostics: freeze([]) };
}

export function validateColors(value: unknown): AppearanceValidationResult<ColorSettings> {
  const diagnostics: AppearanceDiagnostic[] = [];
  if (!isRecord(value)) {
    addDiagnostic(diagnostics, "object-expected", "colors", "Colors must be an object.");
  } else {
    for (const slot of COLOR_SLOTS) {
      const color = readOwn(value, slot);
      if (color !== ABSENT) {
        validateColorValue(color, `colors.${slot}`, diagnostics);
      }
    }
  }
  return diagnostics.length > 0
    ? { valid: false, diagnostics: freeze(diagnostics) }
    : { valid: true, value: normalizeColors(value), diagnostics: freeze([]) };
}

export function validatePalette(value: unknown): AppearanceValidationResult<readonly PaletteColor[]> {
  const diagnostics: AppearanceDiagnostic[] = [];
  const items = readArray(value);
  if (items === null) {
    addDiagnostic(diagnostics, "palette-invalid", "palette", "Palette must be an array.");
  } else {
    items.slice(0, MAX_PALETTE_COLORS).forEach((item, index) => {
      const entry = normalizePaletteEntry(item, index);
      if (entry === undefined) {
        addDiagnostic(diagnostics, "palette-color-invalid", `palette[${index}]`, "Palette entries must contain a safe hex color.");
      }
      if (isRecord(item)) {
        const label = readOwn(item, "label");
        if (label !== ABSENT && !isSafeLabel(label)) {
          addDiagnostic(diagnostics, "palette-label-invalid", `palette[${index}].label`, "Palette labels contain unsafe text.");
        }
      }
    });
  }
  return diagnostics.length > 0
    ? { valid: false, diagnostics: freeze(diagnostics) }
    : { valid: true, value: normalizePalette(value), diagnostics: freeze([]) };
}

function validateSettings(value: unknown, diagnostics: AppearanceDiagnostic[]): void {
  if (!isRecord(value)) {
    addDiagnostic(diagnostics, "object-expected", "settings", "Appearance settings must be an object.");
    return;
  }
  const displayTheme = readOwn(value, "displayTheme");
  if (displayTheme !== ABSENT && !isDisplayTheme(displayTheme)) {
    addDiagnostic(diagnostics, "theme-invalid", "settings.displayTheme", "Theme must be system, light, or dark.");
  }
  for (const field of ["reviewMode", "showAttachmentNames", "minimapVisible"]) {
    const setting = readOwn(value, field);
    if (setting !== ABSENT && typeof setting !== "boolean") {
      addDiagnostic(diagnostics, "setting-invalid", `settings.${field}`, "This setting must be boolean.");
    }
  }
  const palette = readOwn(value, "palette");
  if (palette !== ABSENT) {
    const result = validatePalette(palette);
    diagnostics.push(...result.diagnostics.map((item) => ({
      ...item,
      path: `settings.${item.path}`,
    })));
  }
  const recent = readOwn(value, "recentColors");
  if (recent !== ABSENT) {
    const values = readArray(recent);
    if (values === null) {
      addDiagnostic(diagnostics, "recent-colors-invalid", "settings.recentColors", "Recent colors must be an array.");
    } else {
      values.forEach((item, index) => validateColorValue(item, `settings.recentColors[${index}]`, diagnostics));
    }
  }
}

function validateOverrides(value: unknown, diagnostics: AppearanceDiagnostic[]): void {
  if (!isRecord(value)) {
    addDiagnostic(diagnostics, "overrides-invalid", "localOverrides", "Local overrides must be an object map.");
    return;
  }
  for (const key of ownKeys(value)) {
    if (!isSafeObjectKey(key)) {
      addDiagnostic(diagnostics, "override-key-invalid", `localOverrides.${key}`, "Override key is unsafe.");
      continue;
    }
    const override = readOwn(value, key);
    if (!isRecord(override)) {
      addDiagnostic(diagnostics, "override-invalid", `localOverrides.${key}`, "Each override must be an object.");
      continue;
    }
    const typography = readOwn(override, "typography");
    if (typography !== ABSENT) {
      validateTypographyValue(typography, `localOverrides.${key}.typography`, diagnostics);
    }
    const colors = readOwn(override, "colors");
    if (colors !== ABSENT) {
      const result = validateColors(colors);
      diagnostics.push(...result.diagnostics.map((item) => ({
        ...item,
        path: `localOverrides.${key}.${item.path}`,
      })));
    }
    for (const field of ["locked", "showAttachmentName"]) {
      const setting = readOwn(override, field);
      if (setting !== ABSENT && typeof setting !== "boolean") {
        addDiagnostic(diagnostics, "override-setting-invalid", `localOverrides.${key}.${field}`, "This override must be boolean.");
      }
    }
  }
}

/** Validate without retaining references to the caller's objects. */
export function validateAppearanceState(value: unknown): AppearanceValidationResult<AppearanceState> {
  const diagnostics: AppearanceDiagnostic[] = [];
  if (!isRecord(value)) {
    addDiagnostic(diagnostics, "state-invalid", "appearance", "Appearance state must be an object.");
    return { valid: false, diagnostics: freeze(diagnostics) };
  }
  const settings = readOwn(value, "settings");
  if (settings === ABSENT) {
    addDiagnostic(diagnostics, "settings-missing", "settings", "Appearance settings are required.");
  } else {
    validateSettings(settings, diagnostics);
  }
  const overrides = readOwn(value, "localOverrides");
  if (overrides !== ABSENT) {
    validateOverrides(overrides, diagnostics);
  }
  return diagnostics.length > 0
    ? { valid: false, diagnostics: freeze(diagnostics) }
    : { valid: true, value: normalizeAppearanceState(value), diagnostics: freeze([]) };
}

export const validateAppearance = validateAppearanceState;

/** Return an owned, JSON-safe appearance subset suitable for metadata merge. */
export function toAppearanceMetadata(state: AppearanceState | unknown): AppearanceMetadataPayload {
  const normalized = normalizeAppearanceState(state);
  const localOverrides: Record<string, AppearanceLocalOverride> = {};
  for (const key of ownKeys(normalized.localOverrides as UnknownRecord)) {
    const override = readOwn(normalized.localOverrides as UnknownRecord, key);
    if (override !== ABSENT) {
      defineOwn(localOverrides, key, override);
    }
  }
  return freeze({
    settings: freeze({
      ...normalized.settings,
      displayTheme: normalized.settings.displayTheme,
      palette: normalized.settings.palette,
      recentColors: normalized.settings.recentColors,
      ...(normalized.settings.reviewMode === undefined ? {} : { reviewMode: normalized.settings.reviewMode }),
      ...(normalized.settings.showAttachmentNames === undefined
        ? {}
        : { showAttachmentNames: normalized.settings.showAttachmentNames }),
      ...(normalized.settings.minimapVisible === undefined
        ? {}
        : { minimapVisible: normalized.settings.minimapVisible }),
    }),
    localOverrides: freeze(localOverrides),
  });
}

export const appearanceToMetadata = toAppearanceMetadata;
export const fromAppearanceMetadata = normalizeAppearanceState;

const APPEARANCE_SETTINGS_FIELDS = new Set([
  "displayTheme",
  "palette",
  "recentColors",
]);
const APPEARANCE_TYPOGRAPHY_FIELDS = new Set([
  "fontFamily",
  "fontSize",
  "format",
  "alignment",
  "lineHeight",
  "verticalAlign",
  // Legacy names are owned aliases.  An explicit edit writes the canonical
  // nested values and removes these aliases from that edited typography.
  "fontWeight",
  "fontStyle",
  "textDecoration",
  "textAlign",
]);
const APPEARANCE_OVERRIDE_FIELDS = new Set(["typography", "colors"]);
const COLOR_OVERRIDE_FIELDS = new Set(["text", "fill", "border", "edge"]);
const FORMAT_FIELDS = new Set(["bold", "italic", "underline", "strike", "strikethrough"]);

function cloneMergeRecord(value: unknown): UnknownRecord {
  const copy = cloneUnknown(value);
  return isRecord(copy) ? copy : {};
}

function hasOwnKey(value: UnknownRecord, key: string): boolean {
  return readOwn(value, key) !== ABSENT;
}

function mergeTypographyMetadata(currentInput: unknown, nextInput: unknown): UnknownRecord {
  const current = cloneMergeRecord(currentInput);
  const next = isRecord(nextInput) ? nextInput : {};
  // Legacy flat names are aliases, not a second representation.  They are
  // removed only when this owned typography object is explicitly edited.
  for (const field of ["fontWeight", "fontStyle", "textDecoration", "textAlign"] as const) {
    delete current[field];
  }
  for (const key of ownKeys(next)) {
    if (!isSafeObjectKey(key)) {
      continue;
    }
    const value = readOwn(next, key);
    if (value === ABSENT) {
      continue;
    }
    if (key === "format" && isRecord(value)) {
      // `format` is an owned object, but newer M2/M3 format flags may live
      // beside the four canonical booleans.  Merge the known flags while
      // retaining those opaque nested fields from both sides.
      const existingFormat = cloneMergeRecord(current.format);
      for (const field of FORMAT_FIELDS) {
        delete existingFormat[field];
      }
      for (const formatKey of ownKeys(value)) {
        if (!isSafeObjectKey(formatKey)) {
          continue;
        }
        const formatValue = readOwn(value, formatKey);
        if (formatValue === ABSENT) {
          continue;
        }
        const formatCopy = cloneUnknown(formatValue);
        if (formatCopy !== INVALID) {
          defineOwn(existingFormat, formatKey, formatCopy);
        }
      }
      defineOwn(current, key, existingFormat);
      continue;
    }
    const copy = cloneUnknown(value);
    if (copy !== INVALID) {
      defineOwn(current, key, copy);
    }
  }
  return current;
}

function removeOwnedTypographyMetadata(value: unknown): UnknownRecord | undefined {
  const current = cloneMergeRecord(value);
  const format = readOwn(current, "format");
  if (format !== ABSENT && isRecord(format)) {
    const preservedFormat = cloneMergeRecord(format);
    for (const field of FORMAT_FIELDS) {
      delete preservedFormat[field];
    }
    if (ownKeys(preservedFormat).length > 0) {
      defineOwn(current, "format", preservedFormat);
    } else {
      delete current.format;
    }
  }
  for (const field of APPEARANCE_TYPOGRAPHY_FIELDS) {
    if (field !== "format") {
      delete current[field];
    }
  }
  return ownKeys(current).length > 0 ? current : undefined;
}

function removeOwnedColorsMetadata(value: unknown): UnknownRecord | undefined {
  const current = cloneMergeRecord(value);
  for (const field of COLOR_OVERRIDE_FIELDS) {
    delete current[field];
  }
  return ownKeys(current).length > 0 ? current : undefined;
}

function mergeColorsMetadata(currentInput: unknown, nextInput: unknown): UnknownRecord {
  const current = cloneMergeRecord(currentInput);
  const next = isRecord(nextInput) ? nextInput : {};
  for (const key of ownKeys(next)) {
    if (!isSafeObjectKey(key)) {
      continue;
    }
    const value = readOwn(next, key);
    if (value === ABSENT) {
      continue;
    }
    const copy = cloneUnknown(value);
    if (copy !== INVALID) {
      defineOwn(current, key, copy);
    }
  }
  // A normalized ColorSettings is complete.  Delete an owned color slot only
  // when a caller explicitly omitted it from a non-normalized payload; null
  // remains a real canonical value and is never rewritten as a fake color.
  for (const field of COLOR_OVERRIDE_FIELDS) {
    if (!hasOwnKey(next, field)) {
      delete current[field];
    }
  }
  return current;
}

/**
 * Safely merge an appearance state into a `miroCanvas` metadata container.
 *
 * The function accepts either the metadata object itself or a Canvas root
 * containing `miroCanvas`; the latter form is useful to adapters and keeps an
 * existing `miroSource` untouched.  The source and every unknown field are
 * detached before the result is returned.  Appearance owns only theme,
 * palette, recent colors, typography, and colors.  Other settings and
 * override fields (including locks, comments, anchors, and future M2 data)
 * are preserved even when an appearance reducer resets its own fields.
 *
 * The optional third argument is retained for compatibility with an earlier
 * UI adapter API.  It is intentionally not required for removal semantics:
 * omission of an owned field in the next state is sufficient.
 */
export function mergeAppearanceMetadata(
  metadataInput: unknown,
  stateInput: AppearanceState | unknown,
  _previousStateInput?: AppearanceState | unknown,
): Record<string, unknown> {
  const root = cloneMergeRecord(metadataInput);
  const hasSchema = hasOwnKey(root, "schemaVersion");
  const wrapper = readOwn(root, "miroCanvas");
  const looksLikeCanvasRoot = !hasSchema && (
    wrapper !== ABSENT
    || hasOwnKey(root, "nodes")
    || hasOwnKey(root, "edges")
    || hasOwnKey(root, "miroSource")
  );
  const metadata = looksLikeCanvasRoot && isRecord(wrapper)
    ? cloneMergeRecord(wrapper)
    : looksLikeCanvasRoot
      ? {}
      : root;

  const validation = validateAppearanceState(stateInput);
  if (!validation.valid || validation.value === undefined) {
    if (looksLikeCanvasRoot) {
      defineOwn(root, "miroCanvas", metadata);
    }
    return root;
  }
  const payload = toAppearanceMetadata(validation.value);

  const existingSettings = cloneMergeRecord(metadata.settings);
  const nextSettings = payload.settings as unknown as UnknownRecord;
  for (const key of ownKeys(nextSettings)) {
    if (!isSafeObjectKey(key)) {
      continue;
    }
    const value = readOwn(nextSettings, key);
    if (value === ABSENT) {
      continue;
    }
    const copy = cloneUnknown(value);
    if (copy !== INVALID) {
      defineOwn(existingSettings, key, copy);
    }
  }
  // These three fields are always emitted by the normalized appearance state.
  // Keeping this explicit documents the ownership boundary and protects it if
  // a future optional state field is added.
  for (const field of APPEARANCE_SETTINGS_FIELDS) {
    if (!hasOwnKey(nextSettings, field)) {
      delete existingSettings[field];
    }
  }
  defineOwn(metadata, "settings", existingSettings);

  const existingOverrides = cloneMergeRecord(metadata.localOverrides);
  const payloadOverrides = payload.localOverrides as unknown as UnknownRecord;
  const nodeIds = new Set<string>([
    ...ownKeys(existingOverrides),
    ...ownKeys(payloadOverrides),
  ]);
  const mergedOverrides: UnknownRecord = {};
  for (const nodeId of nodeIds) {
    if (!isSafeObjectKey(nodeId)) {
      continue;
    }
    const currentValue = readOwn(existingOverrides, nodeId);
    const current = currentValue === ABSENT ? {} : cloneMergeRecord(currentValue);
    const nextValue = readOwn(payloadOverrides, nodeId);
    const next = nextValue !== ABSENT && isRecord(nextValue) ? nextValue : undefined;

    if (next === undefined) {
      // A node can still carry lock/attachment/M2 data after appearance reset;
      // remove only the fields appearance owns.  Unknown nested fields under
      // those owned containers remain available for a later schema version.
      const typography = removeOwnedTypographyMetadata(current.typography);
      if (typography === undefined) {
        delete current.typography;
      } else {
        defineOwn(current, "typography", typography);
      }
      const colors = removeOwnedColorsMetadata(current.colors);
      if (colors === undefined) {
        delete current.colors;
      } else {
        defineOwn(current, "colors", colors);
      }
    } else {
      const nextTypography = readOwn(next, "typography");
      if (nextTypography === ABSENT) {
        const typography = removeOwnedTypographyMetadata(current.typography);
        if (typography === undefined) {
          delete current.typography;
        } else {
          defineOwn(current, "typography", typography);
        }
      } else {
        defineOwn(current, "typography", mergeTypographyMetadata(current.typography, nextTypography));
      }
      const nextColors = readOwn(next, "colors");
      if (nextColors === ABSENT) {
        const colors = removeOwnedColorsMetadata(current.colors);
        if (colors === undefined) {
          delete current.colors;
        } else {
          defineOwn(current, "colors", colors);
        }
      } else {
        defineOwn(current, "colors", mergeColorsMetadata(current.colors, nextColors));
      }
      // Preserve and carry through any opaque fields present in the next state.
      // Missing opaque fields never delete the original value.
      for (const key of ownKeys(next)) {
        if (APPEARANCE_OVERRIDE_FIELDS.has(key) || !isSafeObjectKey(key)) {
          continue;
        }
        const value = readOwn(next, key);
        if (value === ABSENT) {
          continue;
        }
        const copy = cloneUnknown(value);
        if (copy !== INVALID) {
          defineOwn(current, key, copy);
        }
      }
    }

    if (ownKeys(current).length > 0) {
      defineOwn(mergedOverrides, nodeId, current);
    }
  }
  defineOwn(metadata, "localOverrides", mergedOverrides);

  if (looksLikeCanvasRoot) {
    defineOwn(root, "miroCanvas", metadata);
    return root;
  }
  return metadata;
}

export const mergeAppearanceIntoMetadata = mergeAppearanceMetadata;

export const APPEARANCE_ACTIONS = Object.freeze({
  setDisplayTheme: "appearance.set-display-theme",
  setTypography: "appearance.set-typography",
  setFontFamily: "appearance.set-font-family",
  setFontSize: "appearance.set-font-size",
  setFormat: "appearance.set-format",
  setAlignment: "appearance.set-alignment",
  setLineHeight: "appearance.set-line-height",
  setVerticalAlign: "appearance.set-vertical-align",
  setColor: "appearance.set-color",
  setColors: "appearance.set-colors",
  resetTypography: "appearance.reset-typography",
  resetColors: "appearance.reset-colors",
  addPaletteColor: "appearance.add-palette-color",
  removePaletteColor: "appearance.remove-palette-color",
  addRecentColor: "appearance.add-recent-color",
  clearRecentColors: "appearance.clear-recent-colors",
});

export const APPEARANCE_COMMANDS = APPEARANCE_ACTIONS;
export type AppearanceActionType = typeof APPEARANCE_ACTIONS[keyof typeof APPEARANCE_ACTIONS]
  | "set-theme"
  | "set-display-theme"
  | "set-node-typography"
  | "set-node-color"
  | "set-node-colors"
  | "reset-node-typography"
  | "reset-node-colors";

/**
 * The index signature intentionally permits a UI adapter to carry a typed
 * command payload without coupling this core to a framework event class.
 */
export interface AppearanceAction {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface AppearanceCommandDefinition {
  readonly type: string;
  readonly label: string;
}

export const APPEARANCE_COMMAND_LABELS: Readonly<Record<string, string>> = Object.freeze({
  [APPEARANCE_ACTIONS.setDisplayTheme]: "Change board theme",
  [APPEARANCE_ACTIONS.setTypography]: "Set typography",
  [APPEARANCE_ACTIONS.setFontFamily]: "Choose font family",
  [APPEARANCE_ACTIONS.setFontSize]: "Set font size",
  [APPEARANCE_ACTIONS.setFormat]: "Format text",
  [APPEARANCE_ACTIONS.setAlignment]: "Align text",
  [APPEARANCE_ACTIONS.setLineHeight]: "Set line height",
  [APPEARANCE_ACTIONS.setVerticalAlign]: "Set vertical alignment",
  [APPEARANCE_ACTIONS.setColor]: "Set color",
  [APPEARANCE_ACTIONS.setColors]: "Set colors",
  [APPEARANCE_ACTIONS.resetTypography]: "Reset typography",
  [APPEARANCE_ACTIONS.resetColors]: "Reset colors",
  [APPEARANCE_ACTIONS.addPaletteColor]: "Add palette color",
  [APPEARANCE_ACTIONS.removePaletteColor]: "Remove palette color",
  [APPEARANCE_ACTIONS.addRecentColor]: "Use recent color",
  [APPEARANCE_ACTIONS.clearRecentColors]: "Clear recent colors",
});

export const APPEARANCE_COMMAND_DEFINITIONS: readonly AppearanceCommandDefinition[] = Object.freeze(
  Object.entries(APPEARANCE_COMMAND_LABELS).map(([type, label]) => Object.freeze({ type, label })),
);

export const appearanceCommandLabels = APPEARANCE_COMMAND_LABELS;

export function getAppearanceCommandLabel(command: unknown): string {
  if (typeof command !== "string") {
    return "Appearance";
  }
  return APPEARANCE_COMMAND_LABELS[command] ?? "Appearance";
}

function copyOverrides(value: Readonly<Record<string, AppearanceLocalOverride>>): Record<string, AppearanceLocalOverride> {
  const result: Record<string, AppearanceLocalOverride> = {};
  for (const key of ownKeys(value as UnknownRecord)) {
    if (!isSafeObjectKey(key)) {
      continue;
    }
    const override = readOwn(value as UnknownRecord, key);
    if (override !== ABSENT) {
      defineOwn(result, key, override);
    }
  }
  return result;
}

function buildState(settings: AppearanceSettings, overrides: Readonly<Record<string, AppearanceLocalOverride>>): AppearanceState {
  const ownedSettings = normalizeSettings(settings);
  const ownedOverrides: Record<string, AppearanceLocalOverride> = {};
  for (const key of ownKeys(overrides as UnknownRecord)) {
    if (!isSafeObjectKey(key)) {
      continue;
    }
    const override = readOwn(overrides as UnknownRecord, key);
    if (override !== ABSENT) {
      defineOwn(ownedOverrides, key, override);
    }
  }
  return freeze({ settings: ownedSettings, localOverrides: freeze(ownedOverrides) });
}

function actionValue(action: UnknownRecord, ...keys: readonly string[]): unknown | typeof ABSENT {
  for (const key of keys) {
    const value = readOwn(action, key);
    if (value !== ABSENT) {
      return value;
    }
  }
  return ABSENT;
}

function actionNodeId(action: UnknownRecord): string | undefined {
  const value = actionValue(action, "nodeId", "canvasNodeId");
  return isSafeObjectKey(value) ? value.trim() : undefined;
}

function updateOverride(
  state: AppearanceState,
  nodeId: string,
  update: (current: AppearanceLocalOverride | undefined) => AppearanceLocalOverride | undefined,
): AppearanceState {
  const nextOverrides = copyOverrides(state.localOverrides);
  const current = readOwn(state.localOverrides as UnknownRecord, nodeId);
  const next = update(current === ABSENT ? undefined : current as AppearanceLocalOverride);
  if (next === undefined) {
    delete nextOverrides[nodeId];
  } else {
    defineOwn(nextOverrides, nodeId, freeze(next));
  }
  return buildState(state.settings, nextOverrides);
}

function updateRecent(state: AppearanceState, color: unknown): AppearanceState {
  const recentColors = addRecentColor(state.settings.recentColors, color);
  if (JSON.stringify(recentColors) === JSON.stringify(state.settings.recentColors)) {
    return state;
  }
  return buildState({ ...state.settings, recentColors }, state.localOverrides);
}

function withPaletteEntry(state: AppearanceState, action: UnknownRecord): AppearanceState {
  const color = parseColor(actionValue(action, "color", "value"));
  if (color === INVALID || color === null) {
    return state;
  }
  if (state.settings.palette.some((item) => item.color === color)) {
    return updateRecent(state, color);
  }
  const rawId = actionValue(action, "id");
  const rawLabel = actionValue(action, "label");
  const rawSource = actionValue(action, "source");
  const entry = normalizePaletteEntry({
    id: rawId === ABSENT ? paletteIdForColor(color) : rawId,
    label: rawLabel === ABSENT ? `Custom ${color}` : rawLabel,
    source: rawSource === ABSENT ? "custom" : rawSource,
    color,
  }, state.settings.palette.length);
  if (entry === undefined) {
    return state;
  }
  const palette = [...state.settings.palette, entry].slice(-MAX_PALETTE_COLORS);
  return buildState({ ...state.settings, palette, recentColors: addRecentColor(state.settings.recentColors, color) }, state.localOverrides);
}

/**
 * Pure immutable reducer.  Invalid commands are ignored and hostile payloads
 * fail closed.  The input state and action are never mutated or retained.
 */
export function appearanceReducer(state: AppearanceState | unknown, action: AppearanceAction | unknown): AppearanceState {
  const current = normalizeAppearanceState(state);
  if (!isRecord(action)) {
    return current;
  }
  try {
    const type = readOwn(action, "type");
    if (typeof type !== "string") {
      return current;
    }
    if (type === APPEARANCE_ACTIONS.setDisplayTheme || type === "set-theme" || type === "set-display-theme") {
      const value = actionValue(action, "displayTheme", "theme", "value");
      if (!isDisplayTheme(value)) {
        return current;
      }
      if (value === current.settings.displayTheme) {
        return current;
      }
      return buildState({ ...current.settings, displayTheme: value }, current.localOverrides);
    }

    if (type === APPEARANCE_ACTIONS.addPaletteColor) {
      return withPaletteEntry(current, action);
    }
    if (type === APPEARANCE_ACTIONS.removePaletteColor) {
      const target = actionValue(action, "id", "color", "value");
      const targetColor = parseColor(target);
      const palette = current.settings.palette.filter((item) => {
        if (typeof target === "string" && item.id === target.trim()) {
          return false;
        }
        return targetColor === INVALID || targetColor === null || item.color !== targetColor;
      });
      if (palette.length === current.settings.palette.length) {
        return current;
      }
      return buildState({ ...current.settings, palette }, current.localOverrides);
    }
    if (type === APPEARANCE_ACTIONS.addRecentColor) {
      return updateRecent(current, actionValue(action, "color", "value"));
    }
    if (type === APPEARANCE_ACTIONS.clearRecentColors) {
      if (current.settings.recentColors.length === 0) {
        return current;
      }
      return buildState({ ...current.settings, recentColors: [] }, current.localOverrides);
    }

    const nodeId = actionNodeId(action);
    if (nodeId === undefined) {
      return current;
    }
    const existing = readOwn(current.localOverrides as UnknownRecord, nodeId);
    const currentOverride = existing === ABSENT ? undefined : existing as AppearanceLocalOverride;

    if (type === APPEARANCE_ACTIONS.setTypography || type === "set-node-typography") {
      const value = actionValue(action, "typography", "value");
      const validation = validateTypography(value);
      if (!validation.valid || validation.value === undefined) {
        return current;
      }
      const typography = normalizeTypography(value, currentOverride?.typography ?? DEFAULT_TYPOGRAPHY);
      return updateOverride(current, nodeId, (override) => ({ ...override, typography }));
    }
    if (type === APPEARANCE_ACTIONS.setFontFamily) {
      const value = actionValue(action, "fontFamily", "value");
      if (!isSafeFontFamily(value)) {
        return current;
      }
      const typography = normalizeTypography({ fontFamily: value }, currentOverride?.typography ?? DEFAULT_TYPOGRAPHY);
      return updateOverride(current, nodeId, (override) => ({ ...override, typography }));
    }
    if (type === APPEARANCE_ACTIONS.setFontSize) {
      const value = actionValue(action, "fontSize", "value");
      if (!isValidFontSize(value)) {
        return current;
      }
      const typography = normalizeTypography({ fontSize: value }, currentOverride?.typography ?? DEFAULT_TYPOGRAPHY);
      return updateOverride(current, nodeId, (override) => ({ ...override, typography }));
    }
    if (type === APPEARANCE_ACTIONS.setFormat) {
      const value = actionValue(action, "format", "value");
      if (value === ABSENT || !validateTypography({ format: value }).valid) {
        return current;
      }
      const base = currentOverride?.typography ?? DEFAULT_TYPOGRAPHY;
      const typography = normalizeTypography({ format: value }, base);
      return updateOverride(current, nodeId, (override) => ({ ...override, typography }));
    }
    if (type === APPEARANCE_ACTIONS.setAlignment) {
      const value = actionValue(action, "alignment", "value");
      if (!isTextAlignment(value) && value !== "start" && value !== "end" && value !== "centre") {
        return current;
      }
      const base = currentOverride?.typography ?? DEFAULT_TYPOGRAPHY;
      const typography = normalizeTypography({ alignment: value }, base);
      return updateOverride(current, nodeId, (override) => ({ ...override, typography }));
    }
    if (type === APPEARANCE_ACTIONS.setLineHeight || type === "set-line-height" || type === "set-node-line-height") {
      const value = actionValue(action, "lineHeight", "value");
      if (!isValidLineHeight(value)) {
        return current;
      }
      const base = currentOverride?.typography ?? DEFAULT_TYPOGRAPHY;
      const typography = normalizeTypography({ lineHeight: value }, base);
      return updateOverride(current, nodeId, (override) => ({ ...override, typography }));
    }
    if (
      type === APPEARANCE_ACTIONS.setVerticalAlign
      || type === "set-vertical-align"
      || type === "set-node-vertical-align"
    ) {
      const value = actionValue(action, "verticalAlign", "value");
      if (!isVerticalAlign(value)) {
        return current;
      }
      const base = currentOverride?.typography ?? DEFAULT_TYPOGRAPHY;
      const typography = normalizeTypography({ verticalAlign: value }, base);
      return updateOverride(current, nodeId, (override) => ({ ...override, typography }));
    }
    if (type === APPEARANCE_ACTIONS.resetTypography || type === "reset-node-typography") {
      return updateOverride(current, nodeId, (override) => {
        if (override === undefined) {
          return undefined;
        }
        // Typography is an owned field.  Keep colors, locks, UI flags, and
        // opaque fields introduced by later schema versions intact.
        const next = { ...override } as Record<string, unknown>;
        delete next.typography;
        return Object.keys(next).length === 0 ? undefined : next;
      });
    }
    if (type === APPEARANCE_ACTIONS.setColors || type === "set-node-colors") {
      const value = actionValue(action, "colors", "value");
      if (!isRecord(value)) {
        return current;
      }
      const base = currentOverride?.colors ?? DEFAULT_COLORS;
      const nextColors: Record<ColorSlot, AppearanceColor> = { ...base };
      let changed = false;
      for (const slot of COLOR_SLOTS) {
        const item = readOwn(value, slot);
        if (item === ABSENT) {
          continue;
        }
        if (!isValidColor(item)) {
          return current;
        }
        nextColors[slot] = normalizeColor(item);
        changed = true;
      }
      if (!changed) {
        return current;
      }
      const colors = normalizeColors(nextColors);
      const recent = [...colors.text !== null ? [colors.text] : [], ...colors.fill !== null ? [colors.fill] : [], ...colors.border !== null ? [colors.border] : [], ...colors.edge !== null ? [colors.edge] : []]
        .reduce<readonly string[]>((items, item) => addRecentColor(items, item), current.settings.recentColors);
      return updateOverride(buildState({ ...current.settings, recentColors: recent }, current.localOverrides), nodeId, (override) => ({ ...override, colors }));
    }
    if (type === APPEARANCE_ACTIONS.setColor || type === "set-node-color") {
      const slot = actionValue(action, "slot", "target");
      const value = actionValue(action, "color", "value");
      if (!isColorSlot(slot) || !isValidColor(value)) {
        return current;
      }
      const base = currentOverride?.colors ?? DEFAULT_COLORS;
      const colors = normalizeColors({ ...base, [slot]: normalizeColor(value) });
      const recent = addRecentColor(current.settings.recentColors, value);
      return updateOverride(buildState({ ...current.settings, recentColors: recent }, current.localOverrides), nodeId, (override) => ({ ...override, colors }));
    }
    if (type === APPEARANCE_ACTIONS.resetColors || type === "reset-node-colors") {
      return updateOverride(current, nodeId, (override) => {
        if (override === undefined) {
          return undefined;
        }
        // Colors is an owned field.  Preserve typography and every
        // non-appearance/M2 field while removing only this override.
        const next = { ...override } as Record<string, unknown>;
        delete next.colors;
        return Object.keys(next).length === 0 ? undefined : next;
      });
    }
  } catch {
    return current;
  }
  return current;
}

export const reduceAppearance = appearanceReducer;

export function selectTypography(state: AppearanceState, nodeId: string): TypographySettings {
  const override = isSafeObjectKey(nodeId) ? state.localOverrides[nodeId]?.typography : undefined;
  return override ?? DEFAULT_TYPOGRAPHY;
}

export function selectColors(state: AppearanceState, nodeId: string): ColorSettings {
  const override = isSafeObjectKey(nodeId) ? state.localOverrides[nodeId]?.colors : undefined;
  return override ?? DEFAULT_COLORS;
}

export const getNodeTypography = selectTypography;
export const getNodeColors = selectColors;
