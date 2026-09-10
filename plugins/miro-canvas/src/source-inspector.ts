/** Bounded, read-only projection for the source/provenance inspector. */

import { buildSourceScene } from "./source-model";

type UnknownRecord = Record<string, unknown>;
export type InspectionValueType = "array" | "boolean" | "null" | "number" | "object" | "string" | "unknown";
export type CompletenessState = "false" | "invalid" | "missing" | "true";

export interface InspectionCount {
  readonly label: string;
  readonly count: number;
}

export interface InspectedField {
  readonly path: string;
  readonly type: InspectionValueType;
}

export interface CompletenessFlag {
  readonly path: string;
  readonly state: CompletenessState;
}

export interface SourceInspection {
  readonly status: "absent" | "malformed" | "ready";
  readonly counts: Readonly<{
    items: number;
    connectors: number;
    comments: number;
    assets: number;
    tags: number;
  }>;
  readonly typeCounts: readonly InspectionCount[];
  readonly selected: Readonly<{
    canvasItems: number;
    matchedSourceItems: number;
    itemsWithProvenance: number;
    typeCounts: readonly InspectionCount[];
  }>;
  readonly provenance: Readonly<{
    itemsWithProvenance: number;
    fieldSourceEntries: number;
    selectedFieldSourceEntries: number;
    originalSourceCopies: number;
  }>;
  readonly completeness: readonly CompletenessFlag[];
  readonly declaredLimitationCount: number;
  readonly diagnosticCounts: readonly InspectionCount[];
  readonly unknownFields: readonly InspectedField[];
  readonly truncated: boolean;
}

const MAX_RECORDS = 20_000;
const MAX_UNKNOWN_FIELDS = 160;
const MAX_TYPE_GROUPS = 80;
const SAFE_TYPE = /^[a-z][a-z0-9_-]{0,63}$/u;

const ROOT_FIELDS = new Set([
  "id", "type", "name", "board", "board_id", "createdAt", "modifiedAt", "created_at", "modified_at",
  "items", "connectors", "comments", "assets", "tags", "completeness", "source_provenance", "original_items",
  "metadata", "profile", "export_profile", "exported_at", "version", "schemaVersion", "schema_version",
]);
const ITEM_FIELDS = new Set([
  "id", "type", "subtype", "data", "style", "geometry", "position", "parent", "links", "createdAt", "modifiedAt",
  "createdBy", "modifiedBy", "ownedBy", "origin", "tagIds", "tags", "assignee", "dueDate", "fields", "zIndex",
  "groupId", "frameId", "children", "plain_text", "title", "description", "url", "link", "resource", "asset",
  "preview", "source_provenance",
]);
const DATA_FIELDS = new Set([
  "content", "title", "description", "plain_text", "url", "link", "provider", "thumbnail", "imageUrl", "documentUrl",
  "fields", "tagIds", "tags", "assignee", "dueDate", "isRoot", "nodeView", "shape", "subtype", "type", "language",
  "lineNumbers", "showLineNumbers", "code", "text",
]);
const STYLE_FIELDS = new Set([
  "color", "textColor", "fillColor", "backgroundColor", "cardTheme", "borderColor", "borderWidth", "borderStyle",
  "strokeColor", "strokeWidth", "strokeOpacity", "strokeStyle", "startStrokeCap", "endStrokeCap", "opacity",
  "fillOpacity", "borderOpacity", "fontSize", "fontFamily", "fontWeight", "fontStyle", "textAlign", "verticalAlign",
  "lineHeight", "textDecoration", "shape", "nodeColor",
]);
const GEOMETRY_FIELDS = new Set(["width", "height", "rotation"]);
const PROVENANCE_FIELDS = new Set(["field_sources", "selected_field_sources", "original_items"]);

function isObject(value: unknown): value is UnknownRecord {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function isRecord(value: unknown): value is UnknownRecord {
  if (!isObject(value)) return false;
  try { return !Array.isArray(value); } catch { return false; }
}

function ownNames(value: unknown): readonly string[] {
  if (!isObject(value)) return [];
  try { return Object.getOwnPropertyNames(value); } catch { return []; }
}

function valueOf(value: unknown, key: string): unknown {
  if (!isObject(value)) return undefined;
  try {
    return Object.prototype.hasOwnProperty.call(value, key) ? Reflect.get(value, key, value) : undefined;
  } catch {
    return undefined;
  }
}

function arrayOf(value: unknown): readonly unknown[] {
  try { return Array.isArray(value) ? value : []; } catch { return []; }
}

function boundedRecords(groups: readonly (readonly unknown[])[]): readonly unknown[] {
  const result: unknown[] = [];
  for (const group of groups) {
    for (let index = 0; index < group.length && result.length < MAX_RECORDS; index += 1) result.push(group[index]);
    if (result.length >= MAX_RECORDS) break;
  }
  return result;
}

function valueType(value: unknown): InspectionValueType {
  if (value === null) return "null";
  try { if (Array.isArray(value)) return "array"; } catch { return "unknown"; }
  const type = typeof value;
  if (type === "boolean" || type === "number" || type === "string") return type;
  return isRecord(value) ? "object" : "unknown";
}

function safeType(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const normalized = value.trim().toLowerCase();
  return SAFE_TYPE.test(normalized) ? normalized : "other";
}

function increment(counts: Map<string, number>, label: string, amount = 1): void {
  counts.set(label, (counts.get(label) ?? 0) + amount);
}

function sortedCounts(counts: ReadonlyMap<string, number>): readonly InspectionCount[] {
  return Object.freeze([...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .slice(0, MAX_TYPE_GROUPS)
    .map(([label, count]) => Object.freeze({ label, count })));
}

function countProvenance(records: readonly unknown[]): SourceInspection["provenance"] {
  let itemsWithProvenance = 0;
  let fieldSourceEntries = 0;
  let selectedFieldSourceEntries = 0;
  let originalSourceCopies = 0;
  for (const record of records.slice(0, MAX_RECORDS)) {
    const provenance = valueOf(record, "source_provenance");
    if (!isRecord(provenance)) continue;
    itemsWithProvenance += 1;
    fieldSourceEntries += ownNames(valueOf(provenance, "field_sources")).length;
    selectedFieldSourceEntries += ownNames(valueOf(provenance, "selected_field_sources")).length;
    originalSourceCopies += ownNames(valueOf(provenance, "original_items")).length;
  }
  return Object.freeze({ itemsWithProvenance, fieldSourceEntries, selectedFieldSourceEntries, originalSourceCopies });
}

function completenessState(value: unknown): CompletenessState {
  return value === true ? "true" : value === false ? "false" : value === undefined ? "missing" : "invalid";
}

function completenessFlags(source: UnknownRecord): readonly CompletenessFlag[] {
  const completeness = valueOf(source, "completeness");
  const paths: readonly [string, unknown][] = [
    ["complete", valueOf(completeness, "complete")],
    ["capture_complete", valueOf(completeness, "capture_complete")],
    ["board_complete", valueOf(completeness, "board_complete")],
    ["items.complete", valueOf(valueOf(completeness, "items"), "complete")],
    ["comments.complete", valueOf(valueOf(completeness, "comments"), "complete")],
    ["assets.complete", valueOf(valueOf(completeness, "assets"), "complete")],
    ["assets.checked", valueOf(valueOf(completeness, "assets"), "checked")],
  ];
  return Object.freeze(paths.map(([path, value]) => Object.freeze({ path, state: completenessState(value) })));
}

function countDeclaredLimitations(
  value: unknown,
  depth = 0,
  seen = new Set<object>(),
  budget: { remaining: number } = { remaining: MAX_RECORDS },
): number {
  if (!isObject(value) || depth > 4 || seen.has(value) || budget.remaining <= 0) return 0;
  seen.add(value);
  let count = 0;
  for (const key of ownNames(value)) {
    budget.remaining -= 1;
    if (budget.remaining < 0) break;
    const child = valueOf(value, key);
    if (key === "known_limitations") count += arrayOf(child).length;
    else if (isObject(child)) count += countDeclaredLimitations(child, depth + 1, seen, budget);
  }
  return count;
}

function collectUnknown(record: unknown, path: string, known: ReadonlySet<string>, output: InspectedField[]): void {
  if (!isRecord(record) || output.length >= MAX_UNKNOWN_FIELDS) return;
  for (const key of ownNames(record)) {
    if (output.length >= MAX_UNKNOWN_FIELDS) return;
    const child = valueOf(record, key);
    if (!known.has(key)) output.push(Object.freeze({ path: `${path}.${key}`.slice(0, 512), type: valueType(child) }));
  }
}

function collectUnknownFields(source: UnknownRecord, items: readonly unknown[], connectors: readonly unknown[]): readonly InspectedField[] {
  const result: InspectedField[] = [];
  collectUnknown(source, "miroSource", ROOT_FIELDS, result);
  const records = boundedRecords([items, connectors]);
  records.forEach((record, index) => {
    const base = `miroSource.records[${index}]`;
    collectUnknown(record, base, ITEM_FIELDS, result);
    collectUnknown(valueOf(record, "data"), `${base}.data`, DATA_FIELDS, result);
    collectUnknown(valueOf(record, "style"), `${base}.style`, STYLE_FIELDS, result);
    collectUnknown(valueOf(record, "geometry"), `${base}.geometry`, GEOMETRY_FIELDS, result);
    collectUnknown(valueOf(record, "source_provenance"), `${base}.source_provenance`, PROVENANCE_FIELDS, result);
  });
  return Object.freeze(result);
}

function diagnosticCounts(document: unknown): readonly InspectionCount[] {
  const counts = new Map<string, number>();
  try {
    for (const diagnostic of buildSourceScene(document).diagnostics) {
      const separator = diagnostic.indexOf(":");
      const candidate = (separator < 0 ? diagnostic : diagnostic.slice(0, separator)).trim().toLowerCase();
      increment(counts, SAFE_TYPE.test(candidate) ? candidate : "source-diagnostic");
    }
  } catch {
    increment(counts, "source-scene-build-failed");
  }
  return sortedCounts(counts);
}

function selectedRecords(document: unknown, source: UnknownRecord, selectedIds: readonly string[]): readonly unknown[] {
  const records = boundedRecords([arrayOf(valueOf(source, "items")), arrayOf(valueOf(source, "connectors"))]);
  const byId = new Map<string, unknown>();
  for (const record of records) {
    const id = valueOf(record, "id");
    if (typeof id === "string" && !byId.has(id)) byId.set(id, record);
  }
  const bindings = valueOf(valueOf(document, "miroCanvas"), "bindings");
  const found: unknown[] = [];
  const seen = new Set<unknown>();
  for (const canvasId of selectedIds.slice(0, MAX_RECORDS)) {
    const sourceId = valueOf(valueOf(bindings, canvasId), "sourceId");
    const record = byId.get(typeof sourceId === "string" ? sourceId : canvasId);
    if (record !== undefined && !seen.has(record)) { seen.add(record); found.push(record); }
  }
  return Object.freeze(found);
}

/** Build an inspector model without exposing source values or mutating the document. */
export function buildSourceInspection(document: unknown, selectedIds: readonly string[] = []): SourceInspection {
  const source = valueOf(document, "miroSource");
  const status: SourceInspection["status"] = source === undefined ? "absent" : isRecord(source) ? "ready" : "malformed";
  const root = isRecord(source) ? source : {};
  const items = arrayOf(valueOf(root, "items"));
  const connectors = arrayOf(valueOf(root, "connectors"));
  const comments = arrayOf(valueOf(root, "comments"));
  const assets = arrayOf(valueOf(root, "assets"));
  const tags = arrayOf(valueOf(root, "tags"));
  const records = boundedRecords([items, connectors, comments]);
  const sourceItems = boundedRecords([items, connectors]);
  const typeMap = new Map<string, number>();
  let itemTagCount = 0;
  for (const record of sourceItems) {
    const type = safeType(valueOf(record, "type"));
    increment(typeMap, type);
    if (type === "tag") itemTagCount += 1;
  }
  const selected = selectedRecords(document, root, selectedIds);
  const selectedTypes = new Map<string, number>();
  for (const record of selected) increment(selectedTypes, safeType(valueOf(record, "type")));
  const selectedProvenance = countProvenance(selected);
  const unknownFields = collectUnknownFields(root, items, connectors);
  const recordLimitReached = items.length + connectors.length + comments.length > MAX_RECORDS;
  return Object.freeze({
    status,
    counts: Object.freeze({ items: items.length, connectors: connectors.length, comments: comments.length, assets: assets.length, tags: tags.length + itemTagCount }),
    typeCounts: sortedCounts(typeMap),
    selected: Object.freeze({
      canvasItems: Math.min(selectedIds.length, MAX_RECORDS),
      matchedSourceItems: selected.length,
      itemsWithProvenance: selectedProvenance.itemsWithProvenance,
      typeCounts: sortedCounts(selectedTypes),
    }),
    provenance: countProvenance(records),
    completeness: completenessFlags(root),
    declaredLimitationCount: countDeclaredLimitations(valueOf(root, "completeness")),
    diagnosticCounts: diagnosticCounts(document),
    unknownFields,
    truncated: recordLimitReached || unknownFields.length >= MAX_UNKNOWN_FIELDS || typeMap.size > MAX_TYPE_GROUPS,
  });
}
