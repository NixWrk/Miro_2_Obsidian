/**
 * Offline local-comment model for a Canvas document.
 *
 * Imported comments are read from `miroSource.comments`, copied, and marked
 * immutable.  Local mutations only clone and return `miroCanvas` metadata;
 * persistence remains the MetadataWriter's explicit responsibility.
 */

import {
  normalizeAnchor,
  type CanvasAnchor,
} from "./anchors";

export type CommentOrigin = "local" | "imported";
export type CommentScope = "board" | "selection";

export interface CommentAuthor {
  readonly id?: string;
  readonly name?: string;
  readonly [key: string]: unknown;
}

export interface CommentReply {
  readonly id: string;
  readonly text: string;
  readonly origin: CommentOrigin;
  readonly createdAt: string;
  readonly updatedAt?: string;
  readonly author?: CommentAuthor;
  readonly immutable?: boolean;
  readonly [key: string]: unknown;
}

export interface CommentThread {
  readonly id: string;
  readonly text: string;
  readonly origin: CommentOrigin;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly resolved: boolean;
  readonly immutable?: boolean;
  readonly author?: CommentAuthor;
  readonly anchor?: CanvasAnchor;
  readonly replies: readonly CommentReply[];
  readonly source?: unknown;
  readonly [key: string]: unknown;
}

export interface CommentListOptions {
  readonly scope?: CommentScope;
  readonly selectedElementIds?: readonly string[];
  readonly includeResolved?: boolean;
}

export interface CommentDisplayOptions {
  readonly locale?: string;
  readonly timeZone?: string;
}

/** Presentation only: never replace stored author or timestamp evidence. */
export function commentAuthorLabel(message: { readonly author?: CommentAuthor }): string {
  for (const value of [message.author?.name, message.author?.displayName, message.author?.id]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "Unknown author";
}

export function commentTimeLabel(value: unknown, options: CommentDisplayOptions = {}): string {
  if (typeof value !== "string" || !value.trim()) return "Time unavailable";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat(options.locale, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", timeZoneName: "short",
    timeZone: options.timeZone,
  }).format(date);
}

export interface CommentMutationOptions {
  readonly idFactory?: (kind: "comment" | "reply") => string;
  readonly createId?: (kind: "comment" | "reply") => string;
  readonly nextId?: (kind: "comment" | "reply") => string;
  readonly now?: () => string | Date;
  readonly clock?: () => string | Date;
  readonly author?: CommentAuthor;
}

export interface LocalCommentInput {
  readonly text?: unknown;
  readonly body?: unknown;
  readonly content?: unknown;
  readonly anchor?: unknown;
  readonly author?: CommentAuthor;
  readonly [key: string]: unknown;
}

export interface CommentMutationDiagnostic {
  readonly code:
    | "metadata-invalid"
    | "comments-invalid"
    | "comment-not-found"
    | "comment-immutable"
    | "text-invalid"
    | "id-invalid"
    | "anchor-invalid"
    | "reply-invalid";
  readonly message: string;
  readonly id?: string;
}

export interface CommentMutationResult {
  readonly ok: boolean;
  readonly changed: boolean;
  readonly metadata?: Record<string, unknown>;
  readonly comment?: CommentThread;
  readonly reply?: CommentReply;
  readonly diagnostics: readonly CommentMutationDiagnostic[];
}

type UnknownRecord = Record<string, unknown>;
const ABSENT = Symbol("comments-absent");
let fallbackIdCounter = 0;

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

function safeKey(value: unknown): value is string {
  return typeof value === "string"
    && value.trim().length > 0
    && value.trim().length <= 256
    && !/^[\u0000-\u001f\u007f]/u.test(value)
    && !/[\u0000-\u001f\u007f]/u.test(value)
    && !["__proto__", "prototype", "constructor"].includes(value.trim().toLowerCase());
}

function cloneJson(value: unknown, visiting = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("non-finite metadata value");
    }
    return value;
  }
  if (typeof value !== "object" || visiting.has(value)) {
    throw new Error("unsupported or cyclic metadata value");
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
      if (!safeKey(key)) {
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

function cloneMetadata(value: unknown): UnknownRecord | undefined {
  try {
    const copy = cloneJson(value);
    return isRecord(copy) ? copy : undefined;
  } catch {
    return undefined;
  }
}

function textOf(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = value.trim();
  return text.length > 0 && text.length <= 20_000 ? text : undefined;
}

function timestamp(options: CommentMutationOptions): string {
  const provider = options.now ?? options.clock;
  const value = provider?.();
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? new Date(0).toISOString() : value.toISOString();
  }
  if (typeof value === "string" && value.trim().length > 0 && value.trim().length <= 128) {
    return value.trim();
  }
  return new Date().toISOString();
}

function diagnostic(
  code: CommentMutationDiagnostic["code"],
  message: string,
  id?: string,
): CommentMutationDiagnostic {
  return { code, message, ...(id === undefined ? {} : { id }) };
}

function readComments(metadata: UnknownRecord): UnknownRecord[] | undefined {
  const value = readOwn(metadata, "localComments");
  if (value === ABSENT) {
    return [];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.every((item) => isRecord(item)) ? value as UnknownRecord[] : undefined;
}

function setComments(metadata: UnknownRecord, comments: readonly UnknownRecord[]): void {
  metadata.localComments = comments;
}

function originOf(value: UnknownRecord): CommentOrigin {
  return readOwn(value, "origin") === "imported" || readOwn(value, "immutable") === true ? "imported" : "local";
}

function textFromRecord(value: UnknownRecord): string {
  for (const key of ["text", "body", "content", "message"]) {
    const text = textOf(readOwn(value, key));
    if (text !== undefined) {
      return text;
    }
  }
  return "";
}

function safeAuthor(value: unknown): CommentAuthor | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  try {
    return cloneJson(value) as CommentAuthor;
  } catch {
    return undefined;
  }
}

function normalizeReply(value: unknown, index: number, parentId: string, imported: boolean): CommentReply | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const copied = (() => {
    try {
      return cloneJson(value) as UnknownRecord;
    } catch {
      return undefined;
    }
  })();
  if (copied === undefined) {
    return undefined;
  }
  const rawId = readOwn(copied, "id");
  const id = safeKey(rawId) ? rawId.trim() : `${parentId}-reply-${index + 1}`;
  const rawCreated = readOwn(copied, "createdAt");
  const createdAt = typeof rawCreated === "string" ? rawCreated : "";
  const text = textFromRecord(copied);
  return {
    ...copied,
    id,
    text,
    origin: imported ? "imported" : "local",
    createdAt,
    ...(safeAuthor(readOwn(copied, "author")) === undefined
      ? (safeAuthor(readOwn(copied, "createdBy")) === undefined ? {} : { author: safeAuthor(readOwn(copied, "createdBy")) })
      : { author: safeAuthor(readOwn(copied, "author")) }),
    ...(imported ? { immutable: true } : {}),
  };
}

function normalizeLocalThread(value: UnknownRecord): CommentThread | undefined {
  const copied = cloneJson(value) as UnknownRecord;
  const rawId = readOwn(copied, "id");
  if (!safeKey(rawId)) {
    return undefined;
  }
  const anchorValue = readOwn(copied, "anchor");
  const anchor = anchorValue === ABSENT ? undefined : normalizeAnchor(anchorValue).anchor;
  const repliesValue = readOwn(copied, "replies");
  const replies = Array.isArray(repliesValue)
    ? repliesValue.map((item, index) => normalizeReply(item, index, rawId.trim(), false)).filter((item): item is CommentReply => item !== undefined)
    : [];
  const createdAt = readOwn(copied, "createdAt");
  const updatedAt = readOwn(copied, "updatedAt");
  return {
    ...copied,
    id: rawId.trim(),
    text: textFromRecord(copied),
    origin: "local",
    resolved: readOwn(copied, "resolved") === true,
    ...(typeof createdAt === "string" ? { createdAt } : {}),
    ...(typeof updatedAt === "string" ? { updatedAt } : {}),
    ...(anchor === undefined ? {} : { anchor }),
    replies,
  };
}

function importedAnchor(value: UnknownRecord): CanvasAnchor | undefined {
  const direct = readOwn(value, "anchor");
  if (direct !== ABSENT) {
    return normalizeAnchor(direct).anchor;
  }
  const position = readOwn(value, "position");
  if (!isRecord(position)) {
    return undefined;
  }
  const type = readOwn(position, "type");
  if (type === "canvas") {
    const x = readOwn(position, "x");
    const y = readOwn(position, "y");
    return normalizeAnchor({ type: "free", x, y }).anchor;
  }
  if (type === "item") {
    const id = readOwn(position, "itemId");
    const u = readOwn(position, "u");
    const v = readOwn(position, "v");
    return normalizeAnchor({
      type: "node",
      nodeId: id,
      u: unitOrDefault(u),
      v: unitOrDefault(v),
    }).anchor;
  }
  return undefined;
}

function unitOrDefault(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : 0.5;
}

function sourceRecord(input: unknown): UnknownRecord | undefined {
  if (!isRecord(input)) {
    return undefined;
  }
  const direct = readOwn(input, "miroSource");
  if (isRecord(direct)) {
    return direct;
  }
  const wrapper = readOwn(input, "miroCanvas");
  if (isRecord(wrapper)) {
    const nestedSource = readOwn(wrapper, "miroSource");
    return isRecord(nestedSource) ? nestedSource : undefined;
  }
  return undefined;
}

function importedThreads(input: unknown): CommentThread[] {
  const source = sourceRecord(input);
  const comments = source === undefined ? undefined : readOwn(source, "comments");
  if (!Array.isArray(comments)) {
    return [];
  }
  const result: CommentThread[] = [];
  comments.forEach((raw, index) => {
    if (!isRecord(raw)) {
      return;
    }
    let copied: UnknownRecord;
    try {
      copied = cloneJson(raw) as UnknownRecord;
    } catch {
      return;
    }
    const rawId = readOwn(copied, "id");
    if (!safeKey(rawId)) {
      return;
    }
    const parentId = rawId.trim();
    const repliesValue = readOwn(copied, "messages") !== ABSENT ? readOwn(copied, "messages") : readOwn(copied, "replies");
    const replies = Array.isArray(repliesValue)
      ? repliesValue.map((item, replyIndex) => normalizeReply(item, replyIndex, parentId, true)).filter((item): item is CommentReply => item !== undefined)
      : [];
    const createdAt = readOwn(copied, "createdAt");
    const authorValue = readOwn(copied, "createdBy") !== ABSENT ? readOwn(copied, "createdBy") : readOwn(copied, "author");
    const thread: CommentThread = {
      ...copied,
      id: parentId,
      origin: "imported",
      immutable: true,
      text: textFromRecord(copied) || (replies[0]?.text ?? ""),
      resolved: readOwn(copied, "resolved") === true,
      ...(typeof createdAt === "string" ? { createdAt } : {}),
      ...(safeAuthor(authorValue) === undefined ? {} : { author: safeAuthor(authorValue) }),
      ...(importedAnchor(copied) === undefined ? {} : { anchor: importedAnchor(copied) }),
      replies,
      source: copied,
    };
    result.push(thread);
    void index;
  });
  return result;
}

function localThreads(input: unknown): CommentThread[] {
  if (!isRecord(input)) {
    return [];
  }
  const wrapper = readOwn(input, "miroCanvas");
  const metadata = wrapper !== ABSENT && isRecord(wrapper) ? wrapper : input;
  const value = readOwn(metadata, "localComments");
  if (!Array.isArray(value)) {
    return [];
  }
  const result: CommentThread[] = [];
  value.forEach((item) => {
    if (!isRecord(item) || originOf(item) === "imported") {
      return;
    }
    try {
      const thread = normalizeLocalThread(item);
      if (thread !== undefined) {
        result.push(thread);
      }
    } catch {
      // A malformed local record is reported by the metadata validator; it
      // must not prevent other comments from being displayed.
    }
  });
  return result;
}

function targetIds(thread: CommentThread): ReadonlySet<string> {
  const ids = new Set<string>();
  const anchor = thread.anchor;
  if (anchor?.type === "node" || anchor?.type === "image") {
    ids.add(anchor.nodeId);
  } else if (anchor?.type === "edge") {
    ids.add(anchor.edgeId);
  }
  for (const key of ["targetId", "elementId", "nodeId", "edgeId", "itemId"]) {
    const value = readOwn(thread as unknown as UnknownRecord, key);
    if (safeKey(value)) {
      ids.add(value.trim());
    }
  }
  return ids;
}

/** Combine immutable imported threads with local threads without retaining source references. */
export function listCommentThreads(input: unknown, options: CommentListOptions = {}): readonly CommentThread[] {
  const threads = [...importedThreads(input), ...localThreads(input)];
  const wrapper = isRecord(input) ? readOwn(input, "miroCanvas") : undefined;
  const metadata = isRecord(wrapper) ? wrapper : input;
  const hiddenValue = isRecord(metadata) ? readOwn(metadata, "hiddenImportedComments") : undefined;
  const hidden = new Set(Array.isArray(hiddenValue) ? hiddenValue : []);
  const selected = new Set((options.selectedElementIds ?? []).filter((id): id is string => safeKey(id)).map((id) => id.trim()));
  const includeResolved = options.includeResolved !== false;
  return Object.freeze(threads.filter((thread) => {
    if (thread.origin === "imported" && hidden.has(thread.id)) return false;
    if (!includeResolved && thread.resolved) {
      return false;
    }
    if (options.scope !== "selection") {
      return true;
    }
    if (selected.size === 0) {
      return false;
    }
    return [...targetIds(thread)].some((id) => selected.has(id));
  }));
}

export const listComments = listCommentThreads;
export const readCommentThreads = listCommentThreads;

export function filterCommentThreads(
  threads: readonly CommentThread[],
  options: CommentListOptions = {},
): readonly CommentThread[] {
  const selected = new Set((options.selectedElementIds ?? []).filter((id): id is string => safeKey(id)).map((id) => id.trim()));
  return Object.freeze(threads.filter((thread) => {
    if (options.includeResolved === false && thread.resolved) {
      return false;
    }
    return options.scope !== "selection"
      || (selected.size > 0 && [...targetIds(thread)].some((id) => selected.has(id)));
  }));
}

function allIds(comments: readonly UnknownRecord[]): Set<string> {
  const ids = new Set<string>();
  for (const comment of comments) {
    const id = readOwn(comment, "id");
    if (safeKey(id)) {
      ids.add(id.trim());
    }
    const replies = readOwn(comment, "replies");
    if (Array.isArray(replies)) {
      for (const reply of replies) {
        if (isRecord(reply) && safeKey(readOwn(reply, "id"))) {
          ids.add((readOwn(reply, "id") as string).trim());
        }
      }
    }
  }
  return ids;
}

function nextId(comments: readonly UnknownRecord[], options: CommentMutationOptions, kind: "comment" | "reply"): string | undefined {
  const factory = options.idFactory ?? options.createId ?? options.nextId;
  const generated = factory?.(kind) ?? `${kind}-${Date.now().toString(36)}-${(fallbackIdCounter += 1)}`;
  if (!safeKey(generated)) {
    return undefined;
  }
  const ids = allIds(comments);
  let candidate = generated.trim();
  let suffix = 2;
  while (ids.has(candidate)) {
    candidate = `${generated.trim()}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function metadataForMutation(input: unknown): { readonly metadata?: UnknownRecord; readonly comments?: UnknownRecord[] } {
  const metadata = cloneMetadata(input);
  if (metadata === undefined) {
    return {};
  }
  const comments = readComments(metadata);
  return comments === undefined ? { metadata } : { metadata, comments };
}

function failure(input: unknown, item: CommentMutationDiagnostic): CommentMutationResult {
  return { ok: false, changed: false, metadata: cloneMetadata(input), diagnostics: [item] };
}

function inputRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function inputText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return textOf(value);
  }
  const record = inputRecord(value);
  return textOf(readOwn(record, "text")) ?? textOf(readOwn(record, "body")) ?? textOf(readOwn(record, "content"));
}

function inputAnchor(value: unknown): { readonly anchor?: CanvasAnchor; readonly diagnostic?: CommentMutationDiagnostic } {
  const record = inputRecord(value);
  const raw = readOwn(record, "anchor");
  if (raw === ABSENT || raw === null) {
    return {};
  }
  const normalized = normalizeAnchor(raw);
  return normalized.valid && normalized.anchor !== undefined
    ? { anchor: normalized.anchor }
    : { diagnostic: diagnostic("anchor-invalid", "Comment anchor is invalid.") };
}

function updateTextFields(record: UnknownRecord, text: string): void {
  record.text = text;
  if (hasOwn(record, "body")) {
    record.body = text;
  }
  if (hasOwn(record, "content")) {
    record.content = text;
  }
}

/** Create one local thread.  The returned metadata is ready for MetadataWriter.write. */
export function addLocalComment(
  metadataInput: unknown,
  input: LocalCommentInput | string,
  options: CommentMutationOptions = {},
): CommentMutationResult {
  const prepared = metadataForMutation(metadataInput);
  if (prepared.metadata === undefined) {
    return failure(metadataInput, diagnostic("metadata-invalid", "Metadata must be a JSON object."));
  }
  if (prepared.comments === undefined) {
    return failure(prepared.metadata, diagnostic("comments-invalid", "localComments must be an array of objects."));
  }
  const text = inputText(input);
  if (text === undefined) {
    return failure(prepared.metadata, diagnostic("text-invalid", "Comment text must be non-empty text."));
  }
  const anchor = inputAnchor(input);
  if (anchor.diagnostic !== undefined) {
    return failure(prepared.metadata, anchor.diagnostic);
  }
  const id = nextId(prepared.comments, options, "comment");
  if (id === undefined) {
    return failure(prepared.metadata, diagnostic("id-invalid", "Comment ID factory returned an unsafe ID."));
  }
  const source = inputRecord(input);
  let copied: UnknownRecord;
  try {
    copied = cloneJson(source) as UnknownRecord;
  } catch {
    copied = {};
  }
  const now = timestamp(options);
  const author = safeAuthor(readOwn(source, "author")) ?? options.author;
  const comment: UnknownRecord = {
    ...copied,
    id,
    origin: "local",
    immutable: false,
    text,
    createdAt: now,
    updatedAt: now,
    resolved: false,
    replies: [],
    ...(author === undefined ? {} : { author }),
    ...(anchor.anchor === undefined ? {} : { anchor: anchor.anchor }),
  };
  const comments = [...prepared.comments, comment];
  setComments(prepared.metadata, comments);
  return { ok: true, changed: true, metadata: prepared.metadata, comment: normalizeLocalThread(comment), diagnostics: [] };
}

export const createLocalComment = addLocalComment;
export const addComment = addLocalComment;

function findComment(comments: readonly UnknownRecord[], id: string): UnknownRecord | undefined {
  return comments.find((comment) => readOwn(comment, "id") === id);
}

function mutableLocalComment(
  comments: readonly UnknownRecord[],
  idInput: unknown,
  metadata?: unknown,
): { readonly id?: string; readonly comment?: UnknownRecord; readonly diagnostic?: CommentMutationDiagnostic } {
  if (!safeKey(idInput)) {
    return { diagnostic: diagnostic("id-invalid", "Comment ID is unsafe.") };
  }
  const id = idInput.trim();
  const comment = findComment(comments, id);
  if (comment === undefined) {
    if (metadata !== undefined && importedThreads(metadata).some((thread) => thread.id === id)) {
      return { id, diagnostic: diagnostic("comment-immutable", "Imported Miro comments are immutable.", id) };
    }
    return { id, diagnostic: diagnostic("comment-not-found", "Comment was not found.", id) };
  }
  if (originOf(comment) === "imported") {
    return { id, diagnostic: diagnostic("comment-immutable", "Imported Miro comments are immutable.", id) };
  }
  return { id, comment };
}

/** Edit local text while preserving every unknown comment field. */
export function editLocalComment(
  metadataInput: unknown,
  idInput: unknown,
  input: LocalCommentInput | string,
  options: CommentMutationOptions = {},
): CommentMutationResult {
  const prepared = metadataForMutation(metadataInput);
  if (prepared.metadata === undefined) {
    return failure(metadataInput, diagnostic("metadata-invalid", "Metadata must be a JSON object."));
  }
  if (prepared.comments === undefined) {
    return failure(prepared.metadata, diagnostic("comments-invalid", "localComments must be an array of objects."));
  }
  const located = mutableLocalComment(prepared.comments, idInput, prepared.metadata);
  if (located.diagnostic !== undefined || located.comment === undefined || located.id === undefined) {
    return failure(prepared.metadata, located.diagnostic ?? diagnostic("comment-not-found", "Comment was not found."));
  }
  const text = inputText(input);
  if (text === undefined) {
    return failure(prepared.metadata, diagnostic("text-invalid", "Comment text must be non-empty text.", located.id));
  }
  updateTextFields(located.comment, text);
  located.comment.origin = "local";
  located.comment.immutable = false;
  located.comment.updatedAt = timestamp(options);
  setComments(prepared.metadata, prepared.comments);
  return { ok: true, changed: true, metadata: prepared.metadata, comment: normalizeLocalThread(located.comment), diagnostics: [] };
}

export const updateLocalComment = editLocalComment;
export const editComment = editLocalComment;

/** Delete a local thread.  Imported source comments can never be deleted here. */
export function deleteLocalComment(metadataInput: unknown, idInput: unknown): CommentMutationResult {
  const prepared = metadataForMutation(metadataInput);
  if (prepared.metadata === undefined) {
    return failure(metadataInput, diagnostic("metadata-invalid", "Metadata must be a JSON object."));
  }
  if (prepared.comments === undefined) {
    return failure(prepared.metadata, diagnostic("comments-invalid", "localComments must be an array of objects."));
  }
  const located = mutableLocalComment(prepared.comments, idInput, prepared.metadata);
  if (located.diagnostic !== undefined || located.id === undefined) {
    return failure(prepared.metadata, located.diagnostic ?? diagnostic("comment-not-found", "Comment was not found."));
  }
  const comments = prepared.comments.filter((comment) => readOwn(comment, "id") !== located.id);
  setComments(prepared.metadata, comments);
  return { ok: true, changed: true, metadata: prepared.metadata, diagnostics: [] };
}

export const removeLocalComment = deleteLocalComment;
export const deleteComment = deleteLocalComment;

/** Add a local reply to a local thread; imported threads remain read-only. */
export function addReply(
  metadataInput: unknown,
  idInput: unknown,
  input: LocalCommentInput | string,
  options: CommentMutationOptions = {},
): CommentMutationResult {
  const prepared = metadataForMutation(metadataInput);
  if (prepared.metadata === undefined) {
    return failure(metadataInput, diagnostic("metadata-invalid", "Metadata must be a JSON object."));
  }
  if (prepared.comments === undefined) {
    return failure(prepared.metadata, diagnostic("comments-invalid", "localComments must be an array of objects."));
  }
  const located = mutableLocalComment(prepared.comments, idInput, prepared.metadata);
  if (located.diagnostic !== undefined || located.comment === undefined || located.id === undefined) {
    return failure(prepared.metadata, located.diagnostic ?? diagnostic("comment-not-found", "Comment was not found."));
  }
  const text = inputText(input);
  if (text === undefined) {
    return failure(prepared.metadata, diagnostic("reply-invalid", "Reply text must be non-empty text.", located.id));
  }
  const existingReplies = readOwn(located.comment, "replies");
  if (existingReplies !== ABSENT && !Array.isArray(existingReplies)) {
    return failure(prepared.metadata, diagnostic("reply-invalid", "Comment replies must be an array.", located.id));
  }
  const replies = existingReplies === ABSENT ? [] : existingReplies as unknown[];
  const id = nextId(prepared.comments, options, "reply");
  if (id === undefined) {
    return failure(prepared.metadata, diagnostic("id-invalid", "Reply ID factory returned an unsafe ID.", located.id));
  }
  const source = inputRecord(input);
  let copied: UnknownRecord;
  try {
    copied = cloneJson(source) as UnknownRecord;
  } catch {
    copied = {};
  }
  const now = timestamp(options);
  const author = safeAuthor(readOwn(source, "author")) ?? options.author;
  const reply: UnknownRecord = {
    ...copied,
    id,
    origin: "local",
    immutable: false,
    text,
    createdAt: now,
    updatedAt: now,
    ...(author === undefined ? {} : { author }),
  };
  located.comment.replies = [...replies, reply];
  located.comment.updatedAt = now;
  setComments(prepared.metadata, prepared.comments);
  return {
    ok: true,
    changed: true,
    metadata: prepared.metadata,
    reply: normalizeReply(reply, replies.length, located.id, false),
    comment: normalizeLocalThread(located.comment),
    diagnostics: [],
  };
}

export const replyToComment = addReply;
export const addLocalReply = addReply;

/** Resolve or reopen a local thread. */
export function setCommentResolved(
  metadataInput: unknown,
  idInput: unknown,
  resolvedInput: unknown,
  options: CommentMutationOptions = {},
): CommentMutationResult {
  if (typeof resolvedInput !== "boolean") {
    return failure(metadataInput, diagnostic("reply-invalid", "Resolved state must be boolean."));
  }
  const prepared = metadataForMutation(metadataInput);
  if (prepared.metadata === undefined) {
    return failure(metadataInput, diagnostic("metadata-invalid", "Metadata must be a JSON object."));
  }
  if (prepared.comments === undefined) {
    return failure(prepared.metadata, diagnostic("comments-invalid", "localComments must be an array of objects."));
  }
  const located = mutableLocalComment(prepared.comments, idInput, prepared.metadata);
  if (located.diagnostic !== undefined || located.comment === undefined || located.id === undefined) {
    return failure(prepared.metadata, located.diagnostic ?? diagnostic("comment-not-found", "Comment was not found."));
  }
  located.comment.origin = "local";
  located.comment.immutable = false;
  located.comment.resolved = resolvedInput;
  located.comment.updatedAt = timestamp(options);
  if (resolvedInput) {
    located.comment.resolvedAt = located.comment.updatedAt;
  } else {
    delete located.comment.resolvedAt;
  }
  setComments(prepared.metadata, prepared.comments);
  return { ok: true, changed: true, metadata: prepared.metadata, comment: normalizeLocalThread(located.comment), diagnostics: [] };
}

export const resolveComment = (metadata: unknown, id: unknown, options?: CommentMutationOptions): CommentMutationResult => setCommentResolved(metadata, id, true, options);
export const reopenComment = (metadata: unknown, id: unknown, options?: CommentMutationOptions): CommentMutationResult => setCommentResolved(metadata, id, false, options);
export const resolveLocalComment = resolveComment;
export const reopenLocalComment = reopenComment;
