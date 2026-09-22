/**
 * Local Canvas anchor model.  Anchors are plain JSON values so they can be
 * placed under `miroCanvas.freeAnchors` without teaching the native Canvas or
 * the Miro source snapshot about local edits.
 */

export type AnchorType = "free" | "node" | "image" | "edge" | "comment";
export interface CommentAnchor {
  readonly type: "comment";
  readonly commentId: string;
  readonly origin: "local" | "imported";
  readonly [key: string]: unknown;
}

export interface FreePointAnchor {
  readonly type: "free";
  readonly x: number;
  readonly y: number;
  readonly [key: string]: unknown;
}

export interface NodeAnchor {
  readonly type: "node";
  readonly nodeId: string;
  readonly u: number;
  readonly v: number;
  readonly [key: string]: unknown;
}

export interface ImageAnchor {
  readonly type: "image";
  readonly nodeId: string;
  readonly u: number;
  readonly v: number;
  readonly [key: string]: unknown;
}

export interface EdgeAnchor {
  readonly type: "edge";
  readonly edgeId: string;
  readonly t: number;
  readonly [key: string]: unknown;
}

export type CanvasAnchor = FreePointAnchor | NodeAnchor | ImageAnchor | EdgeAnchor | CommentAnchor;
export type Anchor = CanvasAnchor;

export interface AnchorDiagnostic {
  readonly code: "anchor-invalid" | "missing-target" | "geometry-invalid" | "anchor-id-invalid";
  readonly message: string;
  readonly path?: string;
  readonly targetId?: string;
}

export interface AnchorNormalizationResult {
  readonly valid: boolean;
  readonly anchor?: CanvasAnchor;
  readonly diagnostics: readonly AnchorDiagnostic[];
}

export interface AnchorPoint {
  readonly x: number;
  readonly y: number;
}

export interface AnchorRect extends AnchorPoint {
  readonly width: number;
  readonly height: number;
  readonly rotation?: number;
  readonly rotationCenterX?: number;
  readonly rotationCenterY?: number;
}

export interface AnchorEdgeGeometry {
  readonly start?: AnchorPoint;
  readonly end?: AnchorPoint;
  readonly points?: readonly AnchorPoint[];
  readonly [key: string]: unknown;
}

export interface AnchorGeometry {
  readonly comments?: Readonly<Record<string, AnchorPoint>>;
  readonly nodes?: Readonly<Record<string, AnchorRect>>;
  readonly images?: Readonly<Record<string, AnchorRect>>;
  readonly edges?: Readonly<Record<string, AnchorEdgeGeometry>>;
}

export interface ResolvedAnchorPoint extends AnchorPoint {
  readonly anchor: CanvasAnchor;
}

export interface AnchorResolutionResult {
  readonly valid: boolean;
  readonly point?: ResolvedAnchorPoint;
  readonly diagnostics: readonly AnchorDiagnostic[];
}

export interface AnchorMutationOptions {
  readonly idFactory?: (kind: "anchor") => string;
  readonly createId?: (kind: "anchor") => string;
  readonly now?: () => string | Date;
  readonly clock?: () => string | Date;
}

export interface AnchorMutationResult {
  readonly ok: boolean;
  readonly changed: boolean;
  readonly metadata?: Record<string, unknown>;
  readonly anchor?: CanvasAnchor & { readonly id?: string };
  readonly diagnostics: readonly AnchorDiagnostic[];
}

type UnknownRecord = Record<string, unknown>;
const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const ABSENT = Symbol("anchor-absent");

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

function hasOwn(record: UnknownRecord, key: string): boolean {
  try {
    return Object.prototype.hasOwnProperty.call(record, key);
  } catch {
    return false;
  }
}

function readOwn(record: UnknownRecord, key: string): unknown | typeof ABSENT {
  if (!hasOwn(record, key)) {
    return ABSENT;
  }
  try {
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

function cloneJson(value: unknown, visiting = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("non-finite number");
    }
    return value;
  }
  if (typeof value !== "object" || visiting.has(value)) {
    throw new Error("unsupported or cyclic metadata");
  }
  visiting.add(value);
  try {
    if (Array.isArray(value)) {
      return Array.from(value, (item) => cloneJson(item, visiting));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) {
      throw new Error("non-plain metadata object");
    }
    const copy: UnknownRecord = {};
    for (const key of ownKeys(value as UnknownRecord)) {
      if (!isSafeKey(key)) {
        throw new Error("unsafe metadata key");
      }
      const item = readOwn(value as UnknownRecord, key);
      if (item === ABSENT) {
        throw new Error("metadata property could not be read");
      }
      Object.defineProperty(copy, key, {
        configurable: true,
        enumerable: true,
        value: cloneJson(item, visiting),
        writable: true,
      });
    }
    return copy;
  } finally {
    visiting.delete(value);
  }
}

function isSafeKey(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && !RESERVED_KEYS.has(value.toLowerCase())
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function safeId(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.trim().length <= 256
    && isSafeKey(value.trim());
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function unit(value: unknown): value is number {
  return finite(value) && value >= 0 && value <= 1;
}

function diagnostic(
  code: AnchorDiagnostic["code"],
  message: string,
  path?: string,
  targetId?: string,
): AnchorDiagnostic {
  return { code, message, ...(path === undefined ? {} : { path }), ...(targetId === undefined ? {} : { targetId }) };
}

function unknownFields(value: UnknownRecord, known: ReadonlySet<string>): UnknownRecord {
  const copy: UnknownRecord = {};
  for (const key of ownKeys(value)) {
    if (known.has(key) || !isSafeKey(key)) {
      continue;
    }
    const item = readOwn(value, key);
    if (item === ABSENT) {
      continue;
    }
    try {
      Object.defineProperty(copy, key, {
        configurable: true,
        enumerable: true,
        value: cloneJson(item),
        writable: true,
      });
    } catch {
      // Unknown non-JSON values cannot cross the metadata writer boundary.
    }
  }
  return copy;
}

function targetId(value: UnknownRecord, primary: string): unknown {
  const direct = readOwn(value, primary);
  if (direct !== ABSENT) {
    return direct;
  }
  for (const key of ["targetId", "elementId"]) {
    const candidate = readOwn(value, key);
    if (candidate !== ABSENT) {
      return candidate;
    }
  }
  return ABSENT;
}

/** Normalize a free, node/image-relative, or edge-relative anchor. */
export function normalizeAnchor(value: unknown): AnchorNormalizationResult {
  const diagnostics: AnchorDiagnostic[] = [];
  if (!isRecord(value)) {
    return { valid: false, diagnostics: [diagnostic("anchor-invalid", "Anchor must be an object.")] };
  }
  const rawType = readOwn(value, "type");
  const kind = readOwn(value, "kind");
  const typeValue = rawType !== ABSENT ? rawType : kind;
  const type = typeValue === "point" ? "free" : typeValue;
  const common = unknownFields(value, new Set([
    "type", "kind", "x", "y", "nodeId", "edgeId", "targetId", "elementId", "u", "v", "t",
  ]));
  if (type === "free") {
    const x = readOwn(value, "x");
    const y = readOwn(value, "y");
    if (x === ABSENT || !finite(x)) {
      diagnostics.push(diagnostic("anchor-invalid", "Free anchor x must be finite.", "x"));
    }
    if (y === ABSENT || !finite(y)) {
      diagnostics.push(diagnostic("anchor-invalid", "Free anchor y must be finite.", "y"));
    }
    if (diagnostics.length > 0) {
      return { valid: false, diagnostics };
    }
    return { valid: true, anchor: { ...common, type: "free", x: x as number, y: y as number }, diagnostics };
  }
  if (type === "comment") {
    const id = readOwn(value, "commentId"), origin = readOwn(value, "origin");
    if (!safeId(id) || (origin !== "local" && origin !== "imported")) {
      return {valid: false, diagnostics: [diagnostic("anchor-invalid", "Comment anchor needs an ID and origin.")]};
    }
    return {valid: true, anchor: {...common, type: "comment", commentId: id.trim(), origin}, diagnostics};
  }
  if (type === "node" || type === "image") {
    const id = targetId(value, "nodeId");
    const u = readOwn(value, "u");
    const v = readOwn(value, "v");
    if (!safeId(id)) {
      diagnostics.push(diagnostic("anchor-invalid", "Node/image anchor needs a safe target ID.", "nodeId"));
    }
    if (u === ABSENT || !unit(u)) {
      diagnostics.push(diagnostic("anchor-invalid", "Anchor u must be finite and between 0 and 1.", "u"));
    }
    if (v === ABSENT || !unit(v)) {
      diagnostics.push(diagnostic("anchor-invalid", "Anchor v must be finite and between 0 and 1.", "v"));
    }
    if (diagnostics.length > 0) {
      return { valid: false, diagnostics };
    }
    if (!safeId(id) || !unit(u) || !unit(v)) {
      return { valid: false, diagnostics: [diagnostic("anchor-invalid", "Anchor values are invalid.")] };
    }
    return {
      valid: true,
      anchor: { ...common, type, nodeId: id.trim(), u, v } as NodeAnchor | ImageAnchor,
      diagnostics,
    };
  }
  if (type === "edge") {
    const id = targetId(value, "edgeId");
    const t = readOwn(value, "t");
    if (!safeId(id)) {
      diagnostics.push(diagnostic("anchor-invalid", "Edge anchor needs a safe target ID.", "edgeId"));
    }
    if (t === ABSENT || !unit(t)) {
      diagnostics.push(diagnostic("anchor-invalid", "Edge anchor t must be finite and between 0 and 1.", "t"));
    }
    if (diagnostics.length > 0) {
      return { valid: false, diagnostics };
    }
    if (!safeId(id) || !unit(t)) {
      return { valid: false, diagnostics: [diagnostic("anchor-invalid", "Anchor values are invalid.")] };
    }
    return { valid: true, anchor: { ...common, type: "edge", edgeId: id.trim(), t }, diagnostics };
  }
  return { valid: false, diagnostics: [diagnostic("anchor-invalid", "Anchor type must be free, node, image, or edge.", "type")] };
}

export function isCanvasAnchor(value: unknown): value is CanvasAnchor {
  return normalizeAnchor(value).valid;
}

function geometryPoint(value: unknown, path: string): AnchorPoint | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const x = readOwn(value, "x");
  const y = readOwn(value, "y");
  return x !== ABSENT && y !== ABSENT && finite(x) && finite(y)
    ? { x, y }
    : undefined;
}

function geometryRect(value: unknown): AnchorRect | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const x = readOwn(value, "x");
  const y = readOwn(value, "y");
  const width = readOwn(value, "width");
  const height = readOwn(value, "height");
  const rotation = readOwn(value, "rotation");
  const rotationCenterX = readOwn(value, "rotationCenterX");
  const rotationCenterY = readOwn(value, "rotationCenterY");
  return x !== ABSENT && y !== ABSENT && width !== ABSENT && height !== ABSENT
    && finite(x) && finite(y) && finite(width) && finite(height) && width >= 0 && height >= 0
    && (rotation === ABSENT || finite(rotation))
    && (rotationCenterX === ABSENT || finite(rotationCenterX))
    && (rotationCenterY === ABSENT || finite(rotationCenterY))
    ? { x, y, width, height,
      ...(rotation === ABSENT ? {} : { rotation }),
      ...(rotationCenterX === ABSENT ? {} : { rotationCenterX }),
      ...(rotationCenterY === ABSENT ? {} : { rotationCenterY }) }
    : undefined;
}

function rotateRectPoint(point: AnchorPoint, rect: AnchorRect): AnchorPoint {
  if (rect.rotation === undefined || rect.rotation === 0) return point;
  const cx = rect.rotationCenterX ?? rect.x + rect.width / 2;
  const cy = rect.rotationCenterY ?? rect.y + rect.height / 2;
  const radians = rect.rotation * Math.PI / 180;
  const dx = point.x - cx, dy = point.y - cy;
  return { x: cx + dx * Math.cos(radians) - dy * Math.sin(radians), y: cy + dx * Math.sin(radians) + dy * Math.cos(radians) };
}

function mapValue(map: unknown, id: string): unknown | typeof ABSENT {
  if (!isRecord(map)) {
    return ABSENT;
  }
  return readOwn(map, id);
}

function pointOnPolyline(points: readonly AnchorPoint[], t: number): AnchorPoint | undefined {
  if (points.length < 2) {
    return undefined;
  }
  const lengths: number[] = [];
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    const dx = points[index].x - points[index - 1].x;
    const dy = points[index].y - points[index - 1].y;
    const length = Math.hypot(dx, dy);
    if (!Number.isFinite(length)) {
      return undefined;
    }
    lengths.push(length);
    total += length;
  }
  if (!Number.isFinite(total)) {
    return undefined;
  }
  if (total === 0) {
    return points[0];
  }
  let remaining = t * total;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index];
    if (remaining <= length || index === lengths.length - 1) {
      const ratio = length === 0 ? 0 : remaining / length;
      return {
        x: points[index].x + (points[index + 1].x - points[index].x) * ratio,
        y: points[index].y + (points[index + 1].y - points[index].y) * ratio,
      };
    }
    remaining -= length;
  }
  return points[points.length - 1];
}

/** Resolve an anchor against detached, supplied geometry only. */
export function resolveAnchor(anchorValue: unknown, geometry: AnchorGeometry | unknown): AnchorResolutionResult {
  const normalized = normalizeAnchor(anchorValue);
  if (!normalized.valid || normalized.anchor === undefined) {
    return { valid: false, diagnostics: normalized.diagnostics };
  }
  const anchor = normalized.anchor;
  if (anchor.type === "free") {
    return { valid: true, point: { x: anchor.x, y: anchor.y, anchor }, diagnostics: [] };
  }
  if (!isRecord(geometry)) {
    return {
      valid: false,
      diagnostics: [diagnostic("missing-target", "Anchor geometry is unavailable.")],
    };
  }
  if (anchor.type === "node" || anchor.type === "image") {
    const map = anchor.type === "image" ? readOwn(geometry, "images") : readOwn(geometry, "nodes");
    const item = map === ABSENT ? ABSENT : mapValue(map, anchor.nodeId);
    const rect = item === ABSENT ? undefined : geometryRect(item);
    if (rect === undefined) {
      return {
        valid: false,
        diagnostics: [diagnostic("missing-target", "Anchor target geometry is missing or invalid.", anchor.type, anchor.nodeId)],
      };
    }
    const point = rotateRectPoint({ x: rect.x + rect.width * anchor.u, y: rect.y + rect.height * anchor.v }, rect);
    return finite(point.x) && finite(point.y)
      ? { valid: true, point: { ...point, anchor }, diagnostics: [] }
      : { valid: false, diagnostics: [diagnostic("geometry-invalid", "Resolved node/image point is not finite.", anchor.type, anchor.nodeId)] };
  }
  if (anchor.type === "comment") {
    const map = readOwn(geometry, "comments");
    const point = map === ABSENT ? undefined : geometryPoint(mapValue(map, `${anchor.origin}:${anchor.commentId}`), "comments");
    return point ? {valid: true, point: {...point, anchor}, diagnostics: []}
      : {valid: false, diagnostics: [diagnostic("missing-target", "Comment anchor target is missing.", "comment", anchor.commentId)]};
  }
  const edges = readOwn(geometry, "edges");
  const item = edges === ABSENT ? ABSENT : mapValue(edges, anchor.edgeId);
  if (item === ABSENT || !isRecord(item)) {
    return { valid: false, diagnostics: [diagnostic("missing-target", "Anchor edge geometry is missing.", "edge", anchor.edgeId)] };
  }
  const rawPoints = readOwn(item, "points");
  let points: AnchorPoint[] | undefined;
  if (rawPoints !== ABSENT && Array.isArray(rawPoints)) {
    points = rawPoints.map((point) => geometryPoint(point, "points")).filter((point): point is AnchorPoint => point !== undefined);
    if (points.length !== rawPoints.length) {
      points = undefined;
    }
  }
  let point = points === undefined ? undefined : pointOnPolyline(points, anchor.t);
  if (point === undefined) {
    const start = geometryPoint(readOwn(item, "start") === ABSENT ? undefined : readOwn(item, "start"), "start");
    const end = geometryPoint(readOwn(item, "end") === ABSENT ? undefined : readOwn(item, "end"), "end");
    if (start !== undefined && end !== undefined) {
      point = { x: start.x + (end.x - start.x) * anchor.t, y: start.y + (end.y - start.y) * anchor.t };
    }
  }
  if (point === undefined || !finite(point.x) || !finite(point.y)) {
    return { valid: false, diagnostics: [diagnostic("geometry-invalid", "Edge geometry needs finite start/end or points.", "edge", anchor.edgeId)] };
  }
  return { valid: true, point: { ...point, anchor }, diagnostics: [] };
}

export function resolveAnchors(
  anchors: Readonly<Record<string, unknown>> | unknown,
  geometry: AnchorGeometry | unknown,
): Readonly<Record<string, AnchorResolutionResult>> {
  const result: Record<string, AnchorResolutionResult> = {};
  if (!isRecord(anchors)) {
    return result;
  }
  for (const id of ownKeys(anchors)) {
    const value = readOwn(anchors, id);
    if (value !== ABSENT) {
      result[id] = resolveAnchor(value, geometry);
    }
  }
  return result;
}

function timestamp(options: AnchorMutationOptions): string {
  const provider = options.now ?? options.clock;
  const value = provider?.();
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? new Date(0).toISOString() : value.toISOString();
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return new Date().toISOString();
}

function cloneMetadata(value: unknown): UnknownRecord | undefined {
  try {
    const copy = cloneJson(value);
    return isRecord(copy) ? copy : undefined;
  } catch {
    return undefined;
  }
}

function anchorMap(metadata: UnknownRecord): UnknownRecord | undefined {
  const value = readOwn(metadata, "freeAnchors");
  if (value === ABSENT) {
    return {};
  }
  return isRecord(value) ? value as UnknownRecord : undefined;
}

function mutationFailure(metadataInput: unknown, item: AnchorDiagnostic): AnchorMutationResult {
  return {
    ok: false,
    changed: false,
    metadata: cloneMetadata(metadataInput),
    diagnostics: [item],
  };
}

function nextAnchorId(existing: UnknownRecord, options: AnchorMutationOptions): string | undefined {
  const factory = options.idFactory ?? options.createId;
  const candidate = factory?.("anchor") ?? `anchor-${Date.now().toString(36)}`;
  if (!safeId(candidate)) {
    return undefined;
  }
  let id = candidate.trim();
  let suffix = 2;
  while (hasOwn(existing, id)) {
    id = `${candidate.trim()}-${suffix}`;
    suffix += 1;
  }
  return id;
}

/** Add one anchor and return a detached metadata document for the writer. */
export function addAnchor(
  metadataInput: unknown,
  anchorInput: unknown,
  options: AnchorMutationOptions = {},
): AnchorMutationResult {
  const metadata = cloneMetadata(metadataInput);
  if (metadata === undefined) {
    return mutationFailure(metadataInput, diagnostic("geometry-invalid", "Metadata must be a JSON object."));
  }
  const map = anchorMap(metadata);
  if (map === undefined) {
    return mutationFailure(metadataInput, diagnostic("geometry-invalid", "freeAnchors must be an object map.", "freeAnchors"));
  }
  const normalized = normalizeAnchor(isRecord(anchorInput) && hasOwn(anchorInput, "anchor")
    ? readOwn(anchorInput, "anchor")
    : anchorInput);
  if (!normalized.valid || normalized.anchor === undefined) {
    return { ok: false, changed: false, metadata, diagnostics: normalized.diagnostics };
  }
  const id = nextAnchorId(map, options);
  if (id === undefined) {
    return mutationFailure(metadata, diagnostic("anchor-id-invalid", "Anchor ID factory returned an unsafe ID."));
  }
  const now = timestamp(options);
  const stored = { ...normalized.anchor, id, createdAt: now };
  Object.defineProperty(map, id, { configurable: true, enumerable: true, value: stored, writable: true });
  metadata.freeAnchors = map;
  return { ok: true, changed: true, metadata, anchor: stored, diagnostics: [] };
}

export const addFreeAnchor = addAnchor;

/** Update an existing anchor, preserving its opaque fields and source data. */
export function updateAnchor(
  metadataInput: unknown,
  idInput: unknown,
  patch: unknown,
  options: AnchorMutationOptions = {},
): AnchorMutationResult {
  const metadata = cloneMetadata(metadataInput);
  if (metadata === undefined) {
    return mutationFailure(metadataInput, diagnostic("geometry-invalid", "Metadata must be a JSON object."));
  }
  if (!safeId(idInput)) {
    return mutationFailure(metadata, diagnostic("anchor-id-invalid", "Anchor ID is unsafe.", "id"));
  }
  const map = anchorMap(metadata);
  const existing = map === undefined ? undefined : readOwn(map, idInput.trim());
  if (map === undefined || existing === ABSENT || !isRecord(existing) || !isRecord(patch)) {
    return mutationFailure(metadata, diagnostic("missing-target", "Anchor to update was not found.", "id", idInput.trim()));
  }
  const merged = { ...existing, ...patch };
  const normalized = normalizeAnchor(merged);
  if (!normalized.valid || normalized.anchor === undefined) {
    return { ok: false, changed: false, metadata, diagnostics: normalized.diagnostics };
  }
  const stored = { ...normalized.anchor, id: idInput.trim(), updatedAt: timestamp(options) };
  map[idInput.trim()] = stored;
  metadata.freeAnchors = map;
  return { ok: true, changed: true, metadata, anchor: stored, diagnostics: [] };
}

export const setAnchor = updateAnchor;

/** Remove one local anchor; imported source objects are never consulted. */
export function removeAnchor(metadataInput: unknown, idInput: unknown): AnchorMutationResult {
  const metadata = cloneMetadata(metadataInput);
  if (metadata === undefined) {
    return mutationFailure(metadataInput, diagnostic("geometry-invalid", "Metadata must be a JSON object."));
  }
  if (!safeId(idInput)) {
    return mutationFailure(metadata, diagnostic("anchor-id-invalid", "Anchor ID is unsafe.", "id"));
  }
  const map = anchorMap(metadata);
  if (map === undefined || !hasOwn(map, idInput.trim())) {
    return mutationFailure(metadata, diagnostic("missing-target", "Anchor to remove was not found.", "id", idInput.trim()));
  }
  delete map[idInput.trim()];
  metadata.freeAnchors = map;
  return { ok: true, changed: true, metadata, diagnostics: [] };
}

export const deleteAnchor = removeAnchor;

export function readAnchors(metadataOrRoot: unknown): Readonly<Record<string, unknown>> {
  if (!isRecord(metadataOrRoot)) {
    return {};
  }
  const wrapper = readOwn(metadataOrRoot, "miroCanvas");
  const metadata = wrapper !== ABSENT && isRecord(wrapper) ? wrapper : metadataOrRoot;
  const map = readOwn(metadata, "freeAnchors");
  if (!isRecord(map)) {
    return {};
  }
  try {
    return cloneJson(map) as Readonly<Record<string, unknown>>;
  } catch {
    return {};
  }
}
