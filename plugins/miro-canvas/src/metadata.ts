/**
 * The small, dependency-free metadata boundary used by the miro-canvas
 * plugin.
 *
 * `miroCanvas` is deliberately kept separate from `miroSource`.  The latter
 * is an immutable import snapshot owned by the converter.  These helpers only
 * read the root Canvas document and validate/copy the metadata needed for an
 * in-memory migration; they never write a file and never inspect or copy
 * `miroSource`.
 */

import {
  isSafeFontFamily,
  isValidFontSize,
  isValidLineHeight,
} from "./appearance";
import { normalizeAnchor } from "./anchors";
import { readLocalItem } from "./local-items";
import type {
  AppearanceColor,
  PaletteColor,
  TextAlignment,
  TypographyFormat,
  VerticalAlign,
} from "./appearance";

export const MIRO_CANVAS_SCHEMA_VERSION = 1 as const;

/**
 * Root keys this plugin owns.  Native Canvas rebuilds the document from its own
 * model when it saves and keeps only the keys it knows, so these two have to be
 * carried across a rebuild explicitly or an ordinary native edit would erase
 * local metadata and the imported source snapshot.
 */
export const PLUGIN_ROOT_KEYS = ["miroCanvas", "miroSource"] as const;

export type MiroCanvasSchemaVersion = typeof MIRO_CANVAS_SCHEMA_VERSION;

export type MiroCanvasMetadataStatus =
  | "absent"
  | "valid"
  | "invalid"
  | "unsupported";

export type MiroCanvasDiagnosticSeverity = "error" | "warning";

/**
 * Diagnostics intentionally carry stable codes and paths, rather than raw
 * source values.  New metadata fields can therefore be reported as warnings
 * without making a newer, otherwise-readable file unusable.
 */
export interface MiroCanvasDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly severity: MiroCanvasDiagnosticSeverity;
  readonly details?: Readonly<Record<string, string | number | boolean>>;
}

export interface MiroCanvasTransform {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

export interface MiroCanvasBinding {
  readonly sourceId: string;
  /**
   * Roles are intentionally open-ended.  The contract currently names
   * `item`, comments, diagnostics, document slots, and slide sequence edges;
   * a future role should remain readable by this core.
   */
  readonly role: string;
  readonly [key: string]: unknown;
}

export interface MiroCanvasSlide {
  readonly id?: string;
  readonly sourceId?: string;
  readonly nodeId?: string;
  readonly syntheticLayout?: boolean;
  readonly [key: string]: unknown;
}

export interface MiroCanvasDeck {
  readonly id?: string;
  readonly sourceId?: string;
  readonly startNode?: string;
  readonly syntheticLayout?: boolean;
  readonly slides?: readonly MiroCanvasSlide[];
  readonly [key: string]: unknown;
}

export interface MiroCanvasTypographyOverride {
  readonly fontFamily?: string;
  readonly fontSize?: number;
  /** Canonical appearance representation. */
  readonly format?: TypographyFormat | string;
  readonly alignment?: TextAlignment | "start" | "end" | "centre";
  readonly lineHeight?: number;
  readonly verticalAlign?: VerticalAlign | "middle";
  /** M0/M1 flat aliases accepted when reading older metadata. */
  readonly fontWeight?: "normal" | "bold" | number;
  readonly fontStyle?: "normal" | "italic";
  readonly textDecoration?: "none" | "underline" | "line-through" | "underline line-through" | "line-through underline";
  readonly textAlign?: TextAlignment | "start" | "end" | "centre";
  readonly [key: string]: unknown;
}

export interface MiroCanvasColorOverride {
  readonly text?: AppearanceColor;
  readonly fill?: AppearanceColor;
  readonly border?: AppearanceColor;
  readonly edge?: AppearanceColor;
  readonly [key: string]: unknown;
}

export interface MiroCanvasLocalOverride {
  readonly typography?: MiroCanvasTypographyOverride;
  readonly colors?: MiroCanvasColorOverride;
  readonly locked?: boolean;
  readonly showAttachmentName?: boolean;
  readonly rotation?: number;
  readonly [key: string]: unknown;
}

export type MiroCanvasDisplayTheme = "system" | "light" | "dark";

export interface MiroCanvasSettings {
  readonly displayTheme?: MiroCanvasDisplayTheme;
  readonly reviewMode?: boolean;
  readonly showAttachmentNames?: boolean;
  readonly minimapVisible?: boolean;
  /** Object entries are canonical; string entries remain readable from M0. */
  readonly palette?: readonly (PaletteColor | string)[];
  readonly recentColors?: readonly string[];
  readonly [key: string]: unknown;
}

/**
 * Comment and anchor records intentionally stay open-ended until their
 * editing contracts are specified by the M2 work.  M0 validates their map /
 * list boundaries and the primitive fields that already have a documented
 * meaning, while preserving future fields.
 */
export interface MiroCanvasLocalComment {
  readonly id?: string;
  readonly sourceId?: string;
  readonly text?: string;
  readonly body?: string;
  readonly origin?: string;
  readonly resolved?: boolean;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly resolvedAt?: string | null;
  readonly immutable?: boolean;
  readonly author?: Readonly<Record<string, unknown>>;
  readonly anchor?: Readonly<Record<string, unknown>>;
  readonly replies?: readonly MiroCanvasLocalCommentReply[];
  readonly source?: unknown;
  readonly [key: string]: unknown;
}

export interface MiroCanvasLocalCommentReply {
  readonly id?: string;
  readonly text?: string;
  readonly body?: string;
  readonly content?: string;
  readonly origin?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly immutable?: boolean;
  readonly author?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

export interface MiroCanvasFreeAnchor {
  readonly id?: string;
  readonly type?: "free" | "node" | "image" | "edge" | string;
  readonly nodeId?: string;
  readonly edgeId?: string;
  readonly x?: number;
  readonly y?: number;
  readonly u?: number;
  readonly v?: number;
  readonly t?: number;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly source?: unknown;
  readonly [key: string]: unknown;
}

export interface MiroCanvasMetadata {
  readonly schemaVersion: MiroCanvasSchemaVersion;
  readonly settings?: MiroCanvasSettings;
  readonly transform?: MiroCanvasTransform;
  readonly bindings?: Readonly<Record<string, MiroCanvasBinding>>;
  readonly zOrder?: readonly string[];
  readonly decks?: readonly MiroCanvasDeck[];
  readonly localOverrides?: Readonly<Record<string, MiroCanvasLocalOverride>>;
  readonly localComments?: readonly MiroCanvasLocalComment[];
  readonly freeAnchors?: Readonly<Record<string, MiroCanvasFreeAnchor>>;
  readonly [key: string]: unknown;
}

export interface MiroCanvasMetadataValidationResult {
  readonly status: Exclude<MiroCanvasMetadataStatus, "absent">;
  readonly valid: boolean;
  readonly schemaVersion?: number;
  readonly metadata?: MiroCanvasMetadata;
  readonly diagnostics: readonly MiroCanvasDiagnostic[];
}

export interface MiroCanvasMetadataParseResult {
  readonly status: MiroCanvasMetadataStatus;
  readonly metadata?: MiroCanvasMetadata;
  readonly sourceVersion?: number;
  readonly migrated: boolean;
  readonly diagnostics: readonly MiroCanvasDiagnostic[];
}

export interface MiroCanvasMigrationContext {
  readonly fromVersion: number;
  readonly toVersion: number;
}

/**
 * A migration may mutate the private in-memory copy it receives, or return a
 * replacement object.  It must not perform persistence; `parse...` never
 * supplies a file writer or the root Canvas document to a migration.
 */
export type MiroCanvasMigration = (
  metadata: Record<string, unknown>,
  context: MiroCanvasMigrationContext,
) => Record<string, unknown> | void;

export type MiroCanvasMigrationRegistry =
  | ReadonlyMap<number, MiroCanvasMigration>
  | Readonly<Record<number, MiroCanvasMigration>>;

export interface MiroCanvasMetadataParseOptions {
  readonly migrations?: MiroCanvasMigrationRegistry;
}

type UnknownRecord = Record<string, unknown>;

type PropertyRead =
  | { readonly state: "absent" }
  | { readonly state: "present"; readonly value: unknown }
  | { readonly state: "error" };

const METADATA_FIELDS = new Set([
  "schemaVersion",
  "settings",
  "transform",
  "bindings",
  "zOrder",
  "decks",
  "localOverrides",
  "localComments",
  "freeAnchors",
]);

const TRANSFORM_FIELDS = new Set(["scale", "offsetX", "offsetY"]);
const BINDING_FIELDS = new Set(["sourceId", "role"]);
const DECK_FIELDS = new Set(["id", "sourceId", "startNode", "syntheticLayout", "slides"]);
const SLIDE_FIELDS = new Set(["id", "sourceId", "nodeId", "syntheticLayout"]);
const SETTINGS_FIELDS = new Set([
  "displayTheme",
  "reviewMode",
  "showAttachmentNames",
  "minimapVisible",
  "palette",
  "recentColors",
]);
const OVERRIDE_FIELDS = new Set(["typography", "colors", "locked", "showAttachmentName", "rotation", "item"]);
const TYPOGRAPHY_FIELDS = new Set([
  "fontFamily",
  "fontSize",
  "format",
  "alignment",
  "fontWeight",
  "fontStyle",
  "textDecoration",
  "textAlign",
  "lineHeight",
  "verticalAlign",
]);
const COLOR_FIELDS = new Set(["text", "fill", "border", "edge"]);
const COMMENT_FIELDS = new Set([
  "id",
  "sourceId",
  "text",
  "body",
  "content",
  "origin",
  "resolved",
  "createdAt",
  "updatedAt",
  "resolvedAt",
  "immutable",
  "author",
  "anchor",
  "replies",
  "source",
]);
const COMMENT_REPLY_FIELDS = new Set([
  "id",
  "text",
  "body",
  "content",
  "origin",
  "createdAt",
  "updatedAt",
  "immutable",
  "author",
]);

const ANCHOR_NUMBER_FIELDS = new Set(["x", "y", "u", "v"]);
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;
const PALETTE_SOURCES = new Set(["miro", "obsidian", "custom"]);
const MAX_PALETTE_COLORS = 128;
const MAX_RECENT_COLORS = 12;

/**
 * `Array.isArray` normally cannot fail for JSON values, but a revoked Proxy
 * can make the ECMAScript IsArray operation throw.  Metadata is an unknown
 * boundary, so treat that shape as unsupported instead of letting the
 * exception escape a validator.
 */
function isArray(value: unknown): value is readonly unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

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

function readOwn(record: UnknownRecord, key: string): PropertyRead {
  let present = false;
  try {
    present = Object.prototype.hasOwnProperty.call(record, key);
  } catch {
    return { state: "error" };
  }

  if (!present) {
    return { state: "absent" };
  }

  try {
    return { state: "present", value: record[key] };
  } catch {
    return { state: "error" };
  }
}

function pathFor(base: string, key: string): string {
  return base ? `${base}.${key}` : key;
}

function addDiagnostic(
  diagnostics: MiroCanvasDiagnostic[],
  severity: MiroCanvasDiagnosticSeverity,
  code: string,
  path: string,
  message: string,
  details?: Readonly<Record<string, string | number | boolean>>,
): void {
  diagnostics.push({
    code,
    path,
    message,
    severity,
    ...(details === undefined ? {} : { details }),
  });
}

function addError(
  diagnostics: MiroCanvasDiagnostic[],
  code: string,
  path: string,
  message: string,
  details?: Readonly<Record<string, string | number | boolean>>,
): void {
  addDiagnostic(diagnostics, "error", code, path, message, details);
}

function addWarning(
  diagnostics: MiroCanvasDiagnostic[],
  code: string,
  path: string,
  message: string,
): void {
  addDiagnostic(diagnostics, "warning", code, path, message);
}

function readRequired(
  record: UnknownRecord,
  key: string,
  path: string,
  diagnostics: MiroCanvasDiagnostic[],
): PropertyRead {
  const result = readOwn(record, key);
  if (result.state === "error") {
    addError(diagnostics, "property-read-failed", pathFor(path, key), "The property could not be read safely.");
  } else if (result.state === "absent") {
    addError(diagnostics, "required-field-missing", pathFor(path, key), "A required field is missing.");
  }
  return result;
}

/**
 * Iterate an array using only safe own-index reads.  Calling `.forEach` would
 * invoke a user-overridable getter/method and can throw even when the value is
 * an Array.  The fixed length also matches native Array#forEach semantics.
 */
function forEachArrayIndex(
  value: readonly unknown[],
  path: string,
  diagnostics: MiroCanvasDiagnostic[],
  callback: (item: unknown, index: number) => void,
): void {
  const length = readOwn(value as unknown as UnknownRecord, "length");
  if (length.state === "error") {
    addError(diagnostics, "property-read-failed", path, "The array length could not be read safely.");
    return;
  }
  if (
    length.state !== "present" ||
    typeof length.value !== "number" ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0
  ) {
    addError(diagnostics, "array-length-invalid", path, "The array length is invalid.");
    return;
  }

  for (let index = 0; index < length.value; index += 1) {
    const item = readOwn(value as unknown as UnknownRecord, String(index));
    const itemPath = `${path}[${index}]`;
    if (item.state === "error") {
      addError(diagnostics, "property-read-failed", itemPath, "The array item could not be read safely.");
      continue;
    }
    // Match Array#forEach for sparse arrays: holes are not visited.
    if (item.state === "present") {
      callback(item.value, index);
    }
  }
}

function warnUnknownFields(
  record: UnknownRecord,
  knownFields: ReadonlySet<string>,
  path: string,
  diagnostics: MiroCanvasDiagnostic[],
): void {
  let keys: string[];
  try {
    keys = Object.keys(record);
  } catch {
    addError(diagnostics, "field-enumeration-failed", path, "Fields could not be enumerated safely.");
    return;
  }

  for (const key of keys) {
    if (!knownFields.has(key)) {
      addWarning(
        diagnostics,
        "unknown-metadata-field",
        pathFor(path, key),
        "Unknown metadata is preserved for forward compatibility.",
      );
    }
  }
}

function requireFiniteNumber(
  value: unknown,
  path: string,
  diagnostics: MiroCanvasDiagnostic[],
  options: { readonly positive?: boolean } = {},
): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    addError(diagnostics, "number-expected", path, "Expected a finite number.");
    return false;
  }
  if (options.positive === true && value <= 0) {
    addError(diagnostics, "positive-number-expected", path, "Expected a number greater than zero.");
    return false;
  }
  return true;
}

function requireNonEmptyString(
  value: unknown,
  path: string,
  diagnostics: MiroCanvasDiagnostic[],
): value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    addError(diagnostics, "non-empty-string-expected", path, "Expected a non-empty string.");
    return false;
  }
  return true;
}

function requireBoolean(
  value: unknown,
  path: string,
  diagnostics: MiroCanvasDiagnostic[],
): value is boolean {
  if (typeof value !== "boolean") {
    addError(diagnostics, "boolean-expected", path, "Expected a boolean.");
    return false;
  }
  return true;
}

function validateTransform(
  value: unknown,
  path: string,
  diagnostics: MiroCanvasDiagnostic[],
): void {
  if (!isRecord(value)) {
    addError(diagnostics, "object-expected", path, "Transform must be an object.");
    return;
  }

  warnUnknownFields(value, TRANSFORM_FIELDS, path, diagnostics);
  for (const field of TRANSFORM_FIELDS) {
    const property = readRequired(value, field, path, diagnostics);
    if (property.state === "present") {
      requireFiniteNumber(property.value, pathFor(path, field), diagnostics, {
        positive: field === "scale",
      });
    }
  }
}

function validateBindings(
  value: unknown,
  path: string,
  diagnostics: MiroCanvasDiagnostic[],
): void {
  if (!isRecord(value)) {
    addError(diagnostics, "object-expected", path, "Bindings must be an object map.");
    return;
  }

  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    addError(diagnostics, "field-enumeration-failed", path, "Binding IDs could not be enumerated safely.");
    return;
  }

  for (const key of keys) {
    const bindingPath = pathFor(path, key);
    requireNonEmptyString(key, bindingPath, diagnostics);
    const property = readOwn(value, key);
    if (property.state === "error") {
      addError(diagnostics, "property-read-failed", bindingPath, "The binding could not be read safely.");
      continue;
    }
    if (property.state !== "present" || !isRecord(property.value)) {
      addError(diagnostics, "object-expected", bindingPath, "Each binding must be an object.");
      continue;
    }

    warnUnknownFields(property.value, BINDING_FIELDS, bindingPath, diagnostics);
    const sourceId = readRequired(property.value, "sourceId", bindingPath, diagnostics);
    if (sourceId.state === "present") {
      requireNonEmptyString(sourceId.value, pathFor(bindingPath, "sourceId"), diagnostics);
    }
    const role = readRequired(property.value, "role", bindingPath, diagnostics);
    if (role.state === "present") {
      requireNonEmptyString(role.value, pathFor(bindingPath, "role"), diagnostics);
    }
  }
}

function validateStringIfPresent(
  record: UnknownRecord,
  field: string,
  path: string,
  diagnostics: MiroCanvasDiagnostic[],
): void {
  const property = readOwn(record, field);
  if (property.state === "error") {
    addError(diagnostics, "property-read-failed", pathFor(path, field), "The property could not be read safely.");
  } else if (property.state === "present") {
    requireNonEmptyString(property.value, pathFor(path, field), diagnostics);
  }
}

function validateNullableStringIfPresent(
  record: UnknownRecord,
  field: string,
  path: string,
  diagnostics: MiroCanvasDiagnostic[],
): void {
  const property = readOwn(record, field);
  if (property.state === "error") {
    addError(diagnostics, "property-read-failed", pathFor(path, field), "The property could not be read safely.");
  } else if (property.state === "present" && property.value !== null) {
    requireNonEmptyString(property.value, pathFor(path, field), diagnostics);
  }
}

function validateBooleanIfPresent(
  record: UnknownRecord,
  field: string,
  path: string,
  diagnostics: MiroCanvasDiagnostic[],
): void {
  const property = readOwn(record, field);
  if (property.state === "error") {
    addError(diagnostics, "property-read-failed", pathFor(path, field), "The property could not be read safely.");
  } else if (property.state === "present") {
    requireBoolean(property.value, pathFor(path, field), diagnostics);
  }
}

function validateSlide(
  value: unknown,
  path: string,
  diagnostics: MiroCanvasDiagnostic[],
): void {
  if (!isRecord(value)) {
    addError(diagnostics, "object-expected", path, "Each slide must be an object.");
    return;
  }
  warnUnknownFields(value, SLIDE_FIELDS, path, diagnostics);
  validateStringIfPresent(value, "id", path, diagnostics);
  validateStringIfPresent(value, "sourceId", path, diagnostics);
  validateStringIfPresent(value, "nodeId", path, diagnostics);
  validateBooleanIfPresent(value, "syntheticLayout", path, diagnostics);
}

function validateDecks(
  value: unknown,
  path: string,
  diagnostics: MiroCanvasDiagnostic[],
): void {
  if (!isArray(value)) {
    addError(diagnostics, "array-expected", path, "Decks must be an array.");
    return;
  }

  forEachArrayIndex(value, path, diagnostics, (deck, index) => {
    const deckPath = `${path}[${index}]`;
    if (!isRecord(deck)) {
      addError(diagnostics, "object-expected", deckPath, "Each deck must be an object.");
      return;
    }
    warnUnknownFields(deck, DECK_FIELDS, deckPath, diagnostics);
    validateStringIfPresent(deck, "id", deckPath, diagnostics);
    validateStringIfPresent(deck, "sourceId", deckPath, diagnostics);
    validateStringIfPresent(deck, "startNode", deckPath, diagnostics);
    validateBooleanIfPresent(deck, "syntheticLayout", deckPath, diagnostics);

    const slides = readOwn(deck, "slides");
    if (slides.state === "error") {
      addError(diagnostics, "property-read-failed", pathFor(deckPath, "slides"), "The slides list could not be read safely.");
    } else if (slides.state === "present") {
      if (!isArray(slides.value)) {
        addError(diagnostics, "array-expected", pathFor(deckPath, "slides"), "Deck slides must be an array.");
      } else {
        forEachArrayIndex(slides.value, pathFor(deckPath, "slides"), diagnostics, (slide, slideIndex) => {
          validateSlide(slide, `${pathFor(deckPath, "slides")}[${slideIndex}]`, diagnostics);
        });
      }
    }
  });
}

function validateEnumIfPresent(
  record: UnknownRecord,
  field: string,
  allowed: ReadonlySet<string>,
  path: string,
  diagnostics: MiroCanvasDiagnostic[],
): void {
  const property = readOwn(record, field);
  if (property.state === "error") {
    addError(diagnostics, "property-read-failed", pathFor(path, field), "The property could not be read safely.");
  } else if (
    property.state === "present" &&
    (typeof property.value !== "string" || !allowed.has(property.value))
  ) {
    addError(diagnostics, "enum-value-invalid", pathFor(path, field), "The value is not one of the supported options.");
  }
}

function validateColor(
  value: unknown,
  path: string,
  diagnostics: MiroCanvasDiagnostic[],
  options: { readonly nullable?: boolean } = {},
): void {
  if (options.nullable === true && value === null) {
    return;
  }
  if (typeof value !== "string" || !HEX_COLOR_PATTERN.test(value)) {
    addError(diagnostics, "color-invalid", path, "Colors must use #RRGGBB, #RRGGBBAA, or null for a transparent slot.");
  }
}

function validatePaletteEntry(value: unknown, path: string, diagnostics: MiroCanvasDiagnostic[]): string | undefined {
  if (typeof value === "string") {
    validateColor(value, path, diagnostics);
    return HEX_COLOR_PATTERN.test(value) ? value.toUpperCase() : undefined;
  }
  if (!isRecord(value)) {
    addError(diagnostics, "palette-entry-invalid", path, "Palette entries must be colors or palette objects.");
    return undefined;
  }
  const color = readOwn(value, "color");
  if (color.state === "error") {
    addError(diagnostics, "property-read-failed", pathFor(path, "color"), "The palette color could not be read safely.");
  } else if (color.state !== "present") {
    addError(diagnostics, "palette-color-missing", pathFor(path, "color"), "Palette objects must contain a color.");
  } else {
    validateColor(color.value, pathFor(path, "color"), diagnostics);
  }
  validateStringIfPresent(value, "id", path, diagnostics);
  validateStringIfPresent(value, "label", path, diagnostics);
  validateEnumIfPresent(value, "source", PALETTE_SOURCES, path, diagnostics);
  return color.state === "present" && typeof color.value === "string" && HEX_COLOR_PATTERN.test(color.value)
    ? color.value.toUpperCase()
    : undefined;
}

function validateColorList(
  value: unknown,
  path: string,
  diagnostics: MiroCanvasDiagnostic[],
  maximum: number,
  options: { readonly palette?: boolean; readonly nullable?: boolean } = {},
): void {
  if (!isArray(value)) {
    addError(diagnostics, "array-expected", path, "The color collection must be an array.");
    return;
  }
  const length = readOwn(value as unknown as UnknownRecord, "length");
  if (
    length.state !== "present" ||
    typeof length.value !== "number" ||
    !Number.isSafeInteger(length.value) ||
    length.value < 0
  ) {
    addError(diagnostics, "array-length-invalid", path, "The color collection length is invalid.");
    return;
  }
  if (length.value > maximum) {
    addError(
      diagnostics,
      "color-limit-exceeded",
      path,
      `The color collection may contain at most ${maximum} entries.`,
    );
  }
  const seen = new Set<string>();
  forEachArrayIndex(value, path, diagnostics, (item, index) => {
    const normalized = options.palette === true
      ? validatePaletteEntry(item, `${path}[${index}]`, diagnostics)
      : (validateColor(item, `${path}[${index}]`, diagnostics, options),
        typeof item === "string" && HEX_COLOR_PATTERN.test(item) ? item.toUpperCase() : undefined);
    if (normalized !== undefined) {
      if (seen.has(normalized)) {
        addError(diagnostics, "duplicate-color", `${path}[${index}]`, "The color collection contains a duplicate.");
      }
      seen.add(normalized);
    }
  });
}

function validateSettings(
  value: unknown,
  path: string,
  diagnostics: MiroCanvasDiagnostic[],
): void {
  if (!isRecord(value)) {
    addError(diagnostics, "object-expected", path, "Board settings must be an object.");
    return;
  }
  warnUnknownFields(value, SETTINGS_FIELDS, path, diagnostics);
  validateEnumIfPresent(
    value,
    "displayTheme",
    new Set(["system", "light", "dark"]),
    path,
    diagnostics,
  );
  validateBooleanIfPresent(value, "reviewMode", path, diagnostics);
  validateBooleanIfPresent(value, "showAttachmentNames", path, diagnostics);
  validateBooleanIfPresent(value, "minimapVisible", path, diagnostics);

  const palette = readOwn(value, "palette");
  if (palette.state === "error") {
    addError(diagnostics, "property-read-failed", pathFor(path, "palette"), "The property could not be read safely.");
  } else if (palette.state === "present") {
    validateColorList(palette.value, pathFor(path, "palette"), diagnostics, MAX_PALETTE_COLORS, { palette: true });
  }
  const recentColors = readOwn(value, "recentColors");
  if (recentColors.state === "error") {
    addError(diagnostics, "property-read-failed", pathFor(path, "recentColors"), "The property could not be read safely.");
  } else if (recentColors.state === "present") {
    validateColorList(recentColors.value, pathFor(path, "recentColors"), diagnostics, MAX_RECENT_COLORS);
  }
}

function validateColors(
  value: unknown,
  path: string,
  diagnostics: MiroCanvasDiagnostic[],
): void {
  if (!isRecord(value)) {
    addError(diagnostics, "object-expected", path, "Color overrides must be an object.");
    return;
  }
  warnUnknownFields(value, COLOR_FIELDS, path, diagnostics);
  for (const field of COLOR_FIELDS) {
    const property = readOwn(value, field);
    if (property.state === "error") {
      addError(diagnostics, "property-read-failed", pathFor(path, field), "The property could not be read safely.");
    } else if (property.state === "present") {
      validateColor(property.value, pathFor(path, field), diagnostics, { nullable: true });
    }
  }
}

function validateTypographyFormat(value: unknown, path: string, diagnostics: MiroCanvasDiagnostic[]): void {
  if (typeof value === "string") {
    const words = value.toLowerCase().split(/[\s+,|]+/u).filter(Boolean);
    if (words.some((word) => !["normal", "bold", "italic", "underline", "strike", "strikethrough"].includes(word))) {
      addError(diagnostics, "format-invalid", path, "Typography format contains an unknown value.");
    }
    return;
  }
  if (!isRecord(value)) {
    addError(diagnostics, "format-invalid", path, "Typography format must be an object or known string.");
    return;
  }
  for (const field of ["bold", "italic", "underline", "strike", "strikethrough"]) {
    const flag = readOwn(value, field);
    if (flag.state === "error") {
      addError(diagnostics, "property-read-failed", pathFor(path, field), "The format flag could not be read safely.");
    } else if (flag.state === "present" && typeof flag.value !== "boolean") {
      addError(diagnostics, "format-flag-invalid", pathFor(path, field), "Format flags must be boolean.");
    }
  }
}

function validateTypography(
  value: unknown,
  path: string,
  diagnostics: MiroCanvasDiagnostic[],
): void {
  if (!isRecord(value)) {
    addError(diagnostics, "object-expected", path, "Typography overrides must be an object.");
    return;
  }
  warnUnknownFields(value, TYPOGRAPHY_FIELDS, path, diagnostics);
  const fontFamily = readOwn(value, "fontFamily");
  if (fontFamily.state === "error") {
    addError(diagnostics, "property-read-failed", pathFor(path, "fontFamily"), "The property could not be read safely.");
  } else if (fontFamily.state === "present" && !isSafeFontFamily(fontFamily.value)) {
    addError(diagnostics, "font-family-invalid", pathFor(path, "fontFamily"), "Font family contains unsupported CSS syntax.");
  }
  const fontSize = readOwn(value, "fontSize");
  if (fontSize.state === "error") {
    addError(diagnostics, "property-read-failed", pathFor(path, "fontSize"), "The property could not be read safely.");
  } else if (fontSize.state === "present" && !isValidFontSize(fontSize.value)) {
    addError(
      diagnostics,
      "font-size-invalid",
      pathFor(path, "fontSize"),
      "Font size must be finite and within the supported appearance range.",
    );
  }
  const format = readOwn(value, "format");
  if (format.state === "error") {
    addError(diagnostics, "property-read-failed", pathFor(path, "format"), "The format could not be read safely.");
  } else if (format.state === "present") {
    validateTypographyFormat(format.value, pathFor(path, "format"), diagnostics);
  }
  validateEnumIfPresent(
    value,
    "alignment",
    new Set(["left", "center", "right", "justify", "start", "end", "centre"]),
    path,
    diagnostics,
  );
  const fontWeight = readOwn(value, "fontWeight");
  if (fontWeight.state === "error") {
    addError(diagnostics, "property-read-failed", pathFor(path, "fontWeight"), "The font weight could not be read safely.");
  } else if (
    fontWeight.state === "present" &&
    fontWeight.value !== "normal" &&
    fontWeight.value !== "bold" &&
    (
      typeof fontWeight.value !== "number" ||
      !Number.isInteger(fontWeight.value) ||
      fontWeight.value < 100 ||
      fontWeight.value > 900 ||
      fontWeight.value % 100 !== 0
    )
  ) {
    addError(diagnostics, "font-weight-invalid", pathFor(path, "fontWeight"), "Font weight must be normal, bold, or 100-900.");
  }
  validateEnumIfPresent(value, "fontStyle", new Set(["normal", "italic"]), path, diagnostics);
  validateEnumIfPresent(
    value,
    "textDecoration",
    new Set(["none", "underline", "line-through", "underline line-through", "line-through underline"]),
    path,
    diagnostics,
  );
  validateEnumIfPresent(
    value,
    "textAlign",
    new Set(["left", "center", "right", "justify", "start", "end", "centre"]),
    path,
    diagnostics,
  );
  const lineHeight = readOwn(value, "lineHeight");
  if (lineHeight.state === "error") {
    addError(diagnostics, "property-read-failed", pathFor(path, "lineHeight"), "The line height could not be read safely.");
  } else if (lineHeight.state === "present") {
    if (!isValidLineHeight(lineHeight.value)) {
      if (typeof lineHeight.value === "number" && Number.isFinite(lineHeight.value) && lineHeight.value <= 0) {
        addError(diagnostics, "positive-number-expected", pathFor(path, "lineHeight"), "Expected a line height greater than zero.");
      } else {
        addError(diagnostics, "line-height-invalid", pathFor(path, "lineHeight"), "Line height is outside the supported appearance range.");
      }
    }
  }
  validateEnumIfPresent(value, "verticalAlign", new Set(["top", "center", "middle", "bottom"]), path, diagnostics);
}

function validateLocalOverrides(
  value: unknown,
  path: string,
  diagnostics: MiroCanvasDiagnostic[],
): void {
  if (!isRecord(value)) {
    addError(diagnostics, "object-expected", path, "Local overrides must be an object map.");
    return;
  }

  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    addError(diagnostics, "field-enumeration-failed", path, "Override IDs could not be enumerated safely.");
    return;
  }

  for (const key of keys) {
    const overridePath = pathFor(path, key);
    requireNonEmptyString(key, overridePath, diagnostics);
    const property = readOwn(value, key);
    if (property.state === "error") {
      addError(diagnostics, "property-read-failed", overridePath, "The override could not be read safely.");
      continue;
    }
    if (property.state !== "present" || !isRecord(property.value)) {
      addError(diagnostics, "object-expected", overridePath, "Each local override must be an object.");
      continue;
    }

    warnUnknownFields(property.value, OVERRIDE_FIELDS, overridePath, diagnostics);
    const typography = readOwn(property.value, "typography");
    if (typography.state === "error") {
      addError(diagnostics, "property-read-failed", pathFor(overridePath, "typography"), "The property could not be read safely.");
    } else if (typography.state === "present") {
      validateTypography(typography.value, pathFor(overridePath, "typography"), diagnostics);
    }
    const colors = readOwn(property.value, "colors");
    if (colors.state === "error") {
      addError(diagnostics, "property-read-failed", pathFor(overridePath, "colors"), "The property could not be read safely.");
    } else if (colors.state === "present") {
      validateColors(colors.value, pathFor(overridePath, "colors"), diagnostics);
    }
    validateBooleanIfPresent(property.value, "locked", overridePath, diagnostics);
    validateBooleanIfPresent(property.value, "showAttachmentName", overridePath, diagnostics);
    const rotation = readOwn(property.value, "rotation");
    if (rotation.state === "error") {
      addError(diagnostics, "property-read-failed", pathFor(overridePath, "rotation"), "The rotation could not be read safely.");
    } else if (rotation.state === "present") {
      requireFiniteNumber(rotation.value, pathFor(overridePath, "rotation"), diagnostics);
    }
    const item = readOwn(property.value, "item");
    if (item.state === "error") {
      addError(diagnostics, "property-read-failed", pathFor(overridePath, "item"), "The item could not be read safely.");
    } else if (item.state === "present" && readLocalItem(item.value) === undefined) {
      addError(diagnostics, "item-invalid", pathFor(overridePath, "item"),
        "A local item needs a known type, a Miro sticky colour name and a short title.");
    }
  }
}

function validateAnchorValue(
  value: unknown,
  path: string,
  diagnostics: MiroCanvasDiagnostic[],
): void {
  if (!isRecord(value)) {
    addError(diagnostics, "object-expected", path, "Anchor must be an object.");
    return;
  }
  const type = readOwn(value, "type");
  if (type.state === "error") {
    addError(diagnostics, "property-read-failed", pathFor(path, "type"), "The anchor type could not be read safely.");
    return;
  }
  if (type.state === "absent") {
    // M0 accepted a coordinate-only free point.  Keep it readable while all
    // typed M1/M2 anchors use normalizeAnchor's stricter contract.
    for (const field of ["x", "y"]) {
      const coordinate = readOwn(value, field);
      if (coordinate.state === "error") {
        addError(diagnostics, "property-read-failed", pathFor(path, field), "The anchor coordinate could not be read safely.");
      } else if (coordinate.state === "present") {
        requireFiniteNumber(coordinate.value, pathFor(path, field), diagnostics);
      }
    }
    return;
  }
  const normalized = normalizeAnchor(value);
  if (!normalized.valid) {
    addError(diagnostics, "anchor-invalid", path, "Anchor type, target, or normalized coordinates are invalid.");
  }
}

function validateCommentReplies(
  value: unknown,
  path: string,
  diagnostics: MiroCanvasDiagnostic[],
): void {
  if (!isArray(value)) {
    addError(diagnostics, "array-expected", path, "Comment replies must be an array.");
    return;
  }
  forEachArrayIndex(value, path, diagnostics, (reply, index) => {
    const replyPath = `${path}[${index}]`;
    if (!isRecord(reply)) {
      addError(diagnostics, "object-expected", replyPath, "Each comment reply must be an object.");
      return;
    }
    warnUnknownFields(reply, COMMENT_REPLY_FIELDS, replyPath, diagnostics);
    validateStringIfPresent(reply, "id", replyPath, diagnostics);
    validateStringIfPresent(reply, "text", replyPath, diagnostics);
    validateStringIfPresent(reply, "body", replyPath, diagnostics);
    validateStringIfPresent(reply, "content", replyPath, diagnostics);
    validateStringIfPresent(reply, "origin", replyPath, diagnostics);
    validateStringIfPresent(reply, "createdAt", replyPath, diagnostics);
    validateStringIfPresent(reply, "updatedAt", replyPath, diagnostics);
    validateBooleanIfPresent(reply, "immutable", replyPath, diagnostics);
  });
}

function validateComments(
  value: unknown,
  path: string,
  diagnostics: MiroCanvasDiagnostic[],
): void {
  if (!isArray(value)) {
    addError(diagnostics, "array-expected", path, "Local comments must be an array.");
    return;
  }

  forEachArrayIndex(value, path, diagnostics, (comment, index) => {
    const commentPath = `${path}[${index}]`;
    if (!isRecord(comment)) {
      addError(diagnostics, "object-expected", commentPath, "Each local comment must be an object.");
      return;
    }
    warnUnknownFields(comment, COMMENT_FIELDS, commentPath, diagnostics);
    validateStringIfPresent(comment, "id", commentPath, diagnostics);
    validateStringIfPresent(comment, "sourceId", commentPath, diagnostics);
    validateStringIfPresent(comment, "text", commentPath, diagnostics);
    validateStringIfPresent(comment, "body", commentPath, diagnostics);
    validateStringIfPresent(comment, "content", commentPath, diagnostics);
    validateStringIfPresent(comment, "origin", commentPath, diagnostics);
    validateBooleanIfPresent(comment, "resolved", commentPath, diagnostics);
    validateStringIfPresent(comment, "createdAt", commentPath, diagnostics);
    validateStringIfPresent(comment, "updatedAt", commentPath, diagnostics);
    validateNullableStringIfPresent(comment, "resolvedAt", commentPath, diagnostics);
    validateBooleanIfPresent(comment, "immutable", commentPath, diagnostics);
    const anchor = readOwn(comment, "anchor");
    if (anchor.state === "error") {
      addError(diagnostics, "property-read-failed", pathFor(commentPath, "anchor"), "The comment anchor could not be read safely.");
    } else if (anchor.state === "present") {
      validateAnchorValue(anchor.value, pathFor(commentPath, "anchor"), diagnostics);
    }
    const replies = readOwn(comment, "replies");
    if (replies.state === "error") {
      addError(diagnostics, "property-read-failed", pathFor(commentPath, "replies"), "The comment replies could not be read safely.");
    } else if (replies.state === "present") {
      validateCommentReplies(replies.value, pathFor(commentPath, "replies"), diagnostics);
    }
  });
}

function validateFreeAnchors(
  value: unknown,
  path: string,
  diagnostics: MiroCanvasDiagnostic[],
): void {
  if (!isRecord(value)) {
    addError(diagnostics, "object-expected", path, "Free anchors must be an object map.");
    return;
  }

  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    addError(diagnostics, "field-enumeration-failed", path, "Anchor IDs could not be enumerated safely.");
    return;
  }

  for (const key of keys) {
    const anchorPath = pathFor(path, key);
    requireNonEmptyString(key, anchorPath, diagnostics);
    const property = readOwn(value, key);
    if (property.state === "error") {
      addError(diagnostics, "property-read-failed", anchorPath, "The anchor could not be read safely.");
      continue;
    }
    if (property.state !== "present" || !isRecord(property.value)) {
      addError(diagnostics, "object-expected", anchorPath, "Each free anchor must be an object.");
      continue;
    }

    const type = readOwn(property.value, "type");
    if (type.state === "error") {
      addError(diagnostics, "property-read-failed", pathFor(anchorPath, "type"), "The anchor type could not be read safely.");
    } else if (type.state === "present") {
      validateAnchorValue(property.value, anchorPath, diagnostics);
    } else {
      // M0 accepted coordinate-only free points; keep those values readable.
      for (const field of ANCHOR_NUMBER_FIELDS) {
        const coordinate = readOwn(property.value, field);
        if (coordinate.state === "error") {
          addError(diagnostics, "property-read-failed", pathFor(anchorPath, field), "The property could not be read safely.");
        } else if (coordinate.state === "present") {
          requireFiniteNumber(coordinate.value, pathFor(anchorPath, field), diagnostics);
        }
      }
    }
  }
}

function validateMetadataObject(value: unknown): MiroCanvasMetadataValidationResult {
  const diagnostics: MiroCanvasDiagnostic[] = [];
  if (!isRecord(value)) {
    addError(diagnostics, "metadata-object-expected", "miroCanvas", "miroCanvas metadata must be an object.");
    return {
      status: "invalid",
      valid: false,
      diagnostics,
    };
  }

  warnUnknownFields(value, METADATA_FIELDS, "miroCanvas", diagnostics);
  const schemaVersion = readRequired(value, "schemaVersion", "miroCanvas", diagnostics);
  if (schemaVersion.state !== "present") {
    return {
      status: "invalid",
      valid: false,
      diagnostics,
    };
  }

  if (typeof schemaVersion.value !== "number" || !Number.isInteger(schemaVersion.value)) {
    addError(
      diagnostics,
      "schema-version-invalid",
      "miroCanvas.schemaVersion",
      "schemaVersion must be an integer.",
    );
    return {
      status: "invalid",
      valid: false,
      diagnostics,
    };
  }

  if (schemaVersion.value !== MIRO_CANVAS_SCHEMA_VERSION) {
    addError(
      diagnostics,
      "schema-version-unsupported",
      "miroCanvas.schemaVersion",
      "This metadata schema version is not supported by the plugin.",
      { schemaVersion: schemaVersion.value },
    );
    return {
      status: "unsupported",
      valid: false,
      schemaVersion: schemaVersion.value,
      diagnostics,
    };
  }

  const settings = readOwn(value, "settings");
  if (settings.state === "error") {
    addError(diagnostics, "property-read-failed", "miroCanvas.settings", "The property could not be read safely.");
  } else if (settings.state === "present") {
    validateSettings(settings.value, "miroCanvas.settings", diagnostics);
  }

  const transform = readOwn(value, "transform");
  if (transform.state === "error") {
    addError(diagnostics, "property-read-failed", "miroCanvas.transform", "The property could not be read safely.");
  } else if (transform.state === "present") {
    validateTransform(transform.value, "miroCanvas.transform", diagnostics);
  }

  const bindings = readOwn(value, "bindings");
  if (bindings.state === "error") {
    addError(diagnostics, "property-read-failed", "miroCanvas.bindings", "The property could not be read safely.");
  } else if (bindings.state === "present") {
    validateBindings(bindings.value, "miroCanvas.bindings", diagnostics);
  }

  const zOrder = readOwn(value, "zOrder");
  if (zOrder.state === "error") {
    addError(diagnostics, "property-read-failed", "miroCanvas.zOrder", "The property could not be read safely.");
  } else if (zOrder.state === "present") {
    if (!isArray(zOrder.value)) {
      addError(diagnostics, "array-expected", "miroCanvas.zOrder", "zOrder must be an array of IDs.");
    } else {
      const seen = new Set<string>();
      forEachArrayIndex(zOrder.value, "miroCanvas.zOrder", diagnostics, (item, index) => {
        const itemPath = `miroCanvas.zOrder[${index}]`;
        if (requireNonEmptyString(item, itemPath, diagnostics)) {
          if (seen.has(item)) {
            addError(diagnostics, "duplicate-z-order-id", itemPath, "zOrder must not contain duplicate IDs.");
          }
          seen.add(item);
        }
      });
    }
  }

  const decks = readOwn(value, "decks");
  if (decks.state === "error") {
    addError(diagnostics, "property-read-failed", "miroCanvas.decks", "The property could not be read safely.");
  } else if (decks.state === "present") {
    validateDecks(decks.value, "miroCanvas.decks", diagnostics);
  }

  const localOverrides = readOwn(value, "localOverrides");
  if (localOverrides.state === "error") {
    addError(diagnostics, "property-read-failed", "miroCanvas.localOverrides", "The property could not be read safely.");
  } else if (localOverrides.state === "present") {
    validateLocalOverrides(localOverrides.value, "miroCanvas.localOverrides", diagnostics);
  }

  const localComments = readOwn(value, "localComments");
  if (localComments.state === "error") {
    addError(diagnostics, "property-read-failed", "miroCanvas.localComments", "The property could not be read safely.");
  } else if (localComments.state === "present") {
    validateComments(localComments.value, "miroCanvas.localComments", diagnostics);
  }

  const freeAnchors = readOwn(value, "freeAnchors");
  if (freeAnchors.state === "error") {
    addError(diagnostics, "property-read-failed", "miroCanvas.freeAnchors", "The property could not be read safely.");
  } else if (freeAnchors.state === "present") {
    validateFreeAnchors(freeAnchors.value, "miroCanvas.freeAnchors", diagnostics);
  }

  const valid = !diagnostics.some((diagnostic) => diagnostic.severity === "error");
  if (!valid) {
    return {
      status: "invalid",
      valid: false,
      schemaVersion: MIRO_CANVAS_SCHEMA_VERSION,
      diagnostics,
    };
  }

  let safeMetadata: unknown;
  try {
    // Keep the validated result detached from the caller.  This also walks
    // unknown forward-compatible fields, rejecting cycles and values that
    // cannot survive the next JSON Canvas write without mutating the input.
    safeMetadata = cloneForMigration(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Metadata could not be copied safely.";
    addError(diagnostics, "metadata-copy-failed", "miroCanvas", message);
    return {
      status: "invalid",
      valid: false,
      schemaVersion: MIRO_CANVAS_SCHEMA_VERSION,
      diagnostics,
    };
  }
  return {
    status: "valid",
    valid: true,
    schemaVersion: MIRO_CANVAS_SCHEMA_VERSION,
    metadata: safeMetadata as MiroCanvasMetadata,
    diagnostics,
  };
}

function readSchemaVersion(value: unknown):
  | { readonly status: "valid"; readonly value: number }
  | { readonly status: "invalid"; readonly diagnostics: readonly MiroCanvasDiagnostic[] } {
  const diagnostics: MiroCanvasDiagnostic[] = [];
  if (!isRecord(value)) {
    addError(diagnostics, "metadata-object-expected", "miroCanvas", "miroCanvas metadata must be an object.");
    return { status: "invalid", diagnostics };
  }
  const schemaVersion = readOwn(value, "schemaVersion");
  if (schemaVersion.state === "error") {
    addError(diagnostics, "property-read-failed", "miroCanvas.schemaVersion", "The property could not be read safely.");
    return { status: "invalid", diagnostics };
  }
  if (schemaVersion.state === "absent") {
    addError(diagnostics, "required-field-missing", "miroCanvas.schemaVersion", "A required field is missing.");
    return { status: "invalid", diagnostics };
  }
  if (typeof schemaVersion.value !== "number" || !Number.isInteger(schemaVersion.value)) {
    addError(diagnostics, "schema-version-invalid", "miroCanvas.schemaVersion", "schemaVersion must be an integer.");
    return { status: "invalid", diagnostics };
  }
  return { status: "valid", value: schemaVersion.value };
}

function getMigration(
  registry: MiroCanvasMigrationRegistry | undefined,
  version: number,
): MiroCanvasMigration | undefined {
  if (registry === undefined) {
    return undefined;
  }
  let isMap = false;
  try {
    isMap = registry instanceof Map;
  } catch {
    return undefined;
  }
  if (isMap) {
    try {
      return (registry as ReadonlyMap<number, MiroCanvasMigration>).get(version);
    } catch {
      return undefined;
    }
  }
  try {
    const key = String(version);
    if (!Object.prototype.hasOwnProperty.call(registry, key)) {
      return undefined;
    }
    const migration = (registry as Readonly<Record<number, MiroCanvasMigration>>)[version];
    return typeof migration === "function" ? migration : undefined;
  } catch {
    return undefined;
  }
}

class MetadataCloneError extends Error {}

interface MetadataCloneState {
  readonly clone: unknown;
  visiting: boolean;
}

function assertSerializablePrimitive(value: unknown): void {
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new MetadataCloneError("Metadata contains a value that cannot be represented in JSON.");
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new MetadataCloneError("Metadata contains a non-finite number.");
  }
}

function assertPlainObject(value: object): void {
  let prototype: object | null;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    throw new MetadataCloneError("Metadata object prototype could not be read.");
  }
  if (prototype !== null && prototype !== Object.prototype) {
    throw new MetadataCloneError("Metadata contains a non-plain object.");
  }
}

function assertNoEnumerableSymbols(value: object): void {
  let symbols: symbol[];
  try {
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    throw new MetadataCloneError("Metadata symbols could not be inspected.");
  }
  for (const symbol of symbols) {
    try {
      if (Object.prototype.propertyIsEnumerable.call(value, symbol)) {
        throw new MetadataCloneError("Metadata contains an enumerable symbol field.");
      }
    } catch (error) {
      if (error instanceof MetadataCloneError) {
        throw error;
      }
      throw new MetadataCloneError("Metadata symbol fields could not be read.");
    }
  }
}

function isArrayIndexKey(key: string, length: number): boolean {
  if (key.length === 0) {
    return false;
  }
  const index = Number(key);
  return Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key;
}

function cloneForMigration(value: unknown, seen = new Map<object, MetadataCloneState>()): unknown {
  if (value === null || typeof value !== "object") {
    assertSerializablePrimitive(value);
    return value;
  }

  const existing = seen.get(value);
  if (existing !== undefined) {
    if (existing.visiting) {
      throw new MetadataCloneError("Metadata contains a cyclic value.");
    }
    return existing.clone;
  }

  if (isArray(value)) {
    const result: unknown[] = [];
    seen.set(value, { clone: result, visiting: true });
    const length = readOwn(value as unknown as UnknownRecord, "length");
    if (
      length.state !== "present" ||
      typeof length.value !== "number" ||
      !Number.isSafeInteger(length.value) ||
      length.value < 0
    ) {
      throw new MetadataCloneError("Metadata array length could not be read safely.");
    }
    result.length = length.value;
    for (let index = 0; index < length.value; index += 1) {
      const property = readOwn(value as unknown as UnknownRecord, String(index));
      if (property.state === "error") {
        throw new MetadataCloneError("Metadata array value could not be read.");
      }
      if (property.state === "present") {
        result[index] = cloneForMigration(property.value, seen);
      }
    }
    let keys: string[];
    try {
      keys = Object.keys(value);
    } catch {
      throw new MetadataCloneError("Metadata array fields could not be enumerated.");
    }
    assertNoEnumerableSymbols(value);
    for (const key of keys) {
      if (isArrayIndexKey(key, length.value)) {
        continue;
      }
      const property = readOwn(value as unknown as UnknownRecord, key);
      if (property.state !== "present") {
        throw new MetadataCloneError("Metadata array field could not be read.");
      }
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: cloneForMigration(property.value, seen),
        writable: true,
      });
    }
    const state = seen.get(value);
    if (state !== undefined) {
      state.visiting = false;
    }
    return result;
  }

  assertPlainObject(value);
  assertNoEnumerableSymbols(value);
  const result = Object.create(null) as UnknownRecord;
  seen.set(value, { clone: result, visiting: true });
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    throw new MetadataCloneError("Metadata fields could not be enumerated.");
  }
  for (const key of keys) {
    const property = readOwn(value as UnknownRecord, key);
    if (property.state !== "present") {
      throw new MetadataCloneError("Metadata field could not be read.");
    }
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: cloneForMigration(property.value, seen),
      writable: true,
    });
  }
  const state = seen.get(value);
  if (state !== undefined) {
    state.visiting = false;
  }
  return result;
}

function failedMigrationResult(
  diagnostics: readonly MiroCanvasDiagnostic[],
  sourceVersion?: number,
): MiroCanvasMetadataParseResult {
  return {
    status: "invalid",
    sourceVersion,
    migrated: false,
    diagnostics,
  };
}

/**
 * Validate a `miroCanvas` value without touching its containing Canvas
 * document.  Unknown fields are warnings and remain available to the caller.
 */
export function validateMiroCanvasMetadata(value: unknown): MiroCanvasMetadataValidationResult {
  return validateMetadataObject(value);
}

/**
 * Migrate and validate metadata entirely in memory.  The supplied metadata is
 * never passed directly to a migration callback.  With no registry (the M0
 * default), versions other than 1 are reported as `unsupported`.
 */
export function migrateMiroCanvasMetadata(
  value: unknown,
  registry?: MiroCanvasMigrationRegistry,
): MiroCanvasMetadataParseResult {
  const versionResult = readSchemaVersion(value);
  if (versionResult.status === "invalid") {
    return failedMigrationResult(versionResult.diagnostics);
  }

  const sourceVersion = versionResult.value;
  if (sourceVersion === MIRO_CANVAS_SCHEMA_VERSION) {
    const validation = validateMetadataObject(value);
    return {
      status: validation.status,
      metadata: validation.metadata,
      sourceVersion,
      migrated: false,
      diagnostics: validation.diagnostics,
    };
  }

  if (sourceVersion > MIRO_CANVAS_SCHEMA_VERSION) {
    const diagnostics: MiroCanvasDiagnostic[] = [
      {
        code: "schema-version-unsupported",
        path: "miroCanvas.schemaVersion",
        message: "This metadata schema version is newer than the supported version.",
        severity: "error",
        details: { schemaVersion: sourceVersion },
      },
    ];
    return {
      status: "unsupported",
      sourceVersion,
      migrated: false,
      diagnostics,
    };
  }

  let currentVersion = sourceVersion;
  let currentValue: unknown = value;
  let copiedForMigration = false;
  let migrated = false;
  const diagnostics: MiroCanvasDiagnostic[] = [];
  let steps = 0;
  while (currentVersion < MIRO_CANVAS_SCHEMA_VERSION) {
    steps += 1;
    if (steps > 32) {
      addError(diagnostics, "migration-limit-reached", "miroCanvas.schemaVersion", "Too many metadata migrations were requested.");
      return failedMigrationResult(diagnostics, sourceVersion);
    }

    const migration = getMigration(registry, currentVersion);
    if (migration === undefined) {
      addError(
        diagnostics,
        "migration-unavailable",
        "miroCanvas.schemaVersion",
        "No in-memory migration is registered for this metadata version.",
        { schemaVersion: currentVersion },
      );
      return {
        status: "unsupported",
        sourceVersion,
        migrated,
        diagnostics,
      };
    }

    if (!copiedForMigration) {
      try {
        currentValue = cloneForMigration(value);
        copiedForMigration = true;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Metadata could not be copied for migration.";
        addError(diagnostics, "metadata-copy-failed", "miroCanvas", message);
        return failedMigrationResult(diagnostics, sourceVersion);
      }
    }

    if (!isRecord(currentValue)) {
      addError(diagnostics, "metadata-object-expected", "miroCanvas", "A migration must return metadata as an object.");
      return failedMigrationResult(diagnostics, sourceVersion);
    }

    const nextVersion = currentVersion + 1;
    let migratedValue: unknown;
    try {
      const callbackResult = migration(currentValue, {
        fromVersion: currentVersion,
        toVersion: nextVersion,
      });
      migratedValue = callbackResult === undefined ? currentValue : callbackResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Metadata migration failed.";
      addError(diagnostics, "migration-failed", "miroCanvas", message);
      return failedMigrationResult(diagnostics, sourceVersion);
    }

    if (!isRecord(migratedValue)) {
      addError(diagnostics, "metadata-object-expected", "miroCanvas", "A migration must return metadata as an object.");
      return failedMigrationResult(diagnostics, sourceVersion);
    }

    const nextVersionValue = readOwn(migratedValue, "schemaVersion");
    if (nextVersionValue.state !== "present" || nextVersionValue.value !== nextVersion) {
      addError(
        diagnostics,
        "migration-version-mismatch",
        "miroCanvas.schemaVersion",
        "A migration must return the next consecutive schema version.",
        { expectedVersion: nextVersion },
      );
      return failedMigrationResult(diagnostics, sourceVersion);
    }

    try {
      currentValue = cloneForMigration(migratedValue);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Migrated metadata could not be copied.";
      addError(diagnostics, "metadata-copy-failed", "miroCanvas", message);
      return failedMigrationResult(diagnostics, sourceVersion);
    }
    currentVersion = nextVersion;
    migrated = true;
  }

  const validation = validateMetadataObject(currentValue);
  return {
    status: validation.status,
    metadata: validation.metadata,
    sourceVersion,
    migrated,
    diagnostics: [...diagnostics, ...validation.diagnostics],
  };
}

/**
 * Safely read and validate metadata from an unknown root Canvas document.
 * `absent` includes ordinary Canvas files and non-object roots without an
 * own `miroCanvas` property.  An inherited property is deliberately ignored.
 */
export function parseMiroCanvasMetadata(
  document: unknown,
  options: MiroCanvasMetadataParseOptions = {},
): MiroCanvasMetadataParseResult {
  if (!isRecord(document)) {
    return {
      status: "absent",
      migrated: false,
      diagnostics: [],
    };
  }

  const metadata = readOwn(document, "miroCanvas");
  if (metadata.state === "error") {
    return failedMigrationResult(
      [
        {
          code: "property-read-failed",
          path: "miroCanvas",
          message: "The root metadata property could not be read safely.",
          severity: "error",
        },
      ],
    );
  }
  if (metadata.state === "absent") {
    return {
      status: "absent",
      migrated: false,
      diagnostics: [],
    };
  }

  return migrateMiroCanvasMetadata(metadata.value, options.migrations);
}

/**
 * Return a fresh, complete v1 shell for an explicit metadata write.  Parsing
 * does not call this function and therefore never invents missing fields when
 * opening a board.
 */
export function createDefaultMiroCanvasMetadata(): MiroCanvasMetadata {
  return {
    schemaVersion: MIRO_CANVAS_SCHEMA_VERSION,
    settings: {
      displayTheme: "system",
      reviewMode: false,
      showAttachmentNames: true,
      minimapVisible: true,
      palette: [],
      recentColors: [],
    },
    transform: {
      scale: 1,
      offsetX: 0,
      offsetY: 0,
    },
    bindings: {},
    zOrder: [],
    decks: [],
    localOverrides: {},
    localComments: [],
    freeAnchors: {},
  };
}
