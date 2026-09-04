/** Local document navigation only: no fetching, iframe URLs, or Canvas writes. */
export type DocumentKind = "pdf" | "markdown" | "image" | "file";
export type DocumentFit = "page" | "width";

export interface LocalDocument {
  readonly path: string;
  readonly title: string;
  readonly kind: DocumentKind;
  readonly page: number;
  readonly fit: DocumentFit;
  readonly subpath?: string;
}

export interface DocumentHost {
  /** Resolves a vault-relative path to an existing file, never a directory. */
  hasFile(path: string): boolean;
  /** Uses Obsidian's own viewer; unsupported formats retain its normal fallback. */
  openFile(document: LocalDocument): Promise<void> | void;
}

export type DocumentOpenResult =
  | { readonly ok: true; readonly document: LocalDocument }
  | { readonly ok: false; readonly reason: "invalid-path" | "missing-file" | "open-failed" };

/** Do not interpret URL schemes, aliases, fragments, or parent traversals. */
export function localDocumentPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096
    || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)) return null;
  const path = value.replace(/\\/g, "/");
  if (path.startsWith("/") || /[:?*<>|]/u.test(path)) return null;
  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  // Encoded path separators/parent references must not acquire a second meaning
  // when passed through a resource URL or a platform-specific vault adapter.
  if (/%(?:2e|2f|5c|00|25)/iu.test(path)) return null;
  return path;
}

export function describeLocalDocument(
  file: unknown,
  options: { page?: number; fit?: DocumentFit; subpath?: unknown } = {},
): LocalDocument | null {
  const path = localDocumentPath(file);
  if (!path) return null;
  const title = path.slice(path.lastIndexOf("/") + 1);
  const extension = title.slice(title.lastIndexOf(".") + 1).toLowerCase();
  const kind: DocumentKind = extension === "pdf" ? "pdf"
    : extension === "md" ? "markdown"
      : ["png", "jpg", "jpeg", "gif", "webp", "bmp", "avif"].includes(extension) ? "image" : "file";
  const safeSubpath = typeof options.subpath === "string"
    && options.subpath.length <= 1024
    && options.subpath === options.subpath.trim()
    && /^#[^\u0000-\u001f\u007f<>]*$/u.test(options.subpath)
    ? options.subpath : undefined;
  const subpage = safeSubpath === undefined ? undefined : /^#page=(\d+)$/u.exec(safeSubpath)?.[1];
  const requested = options.page ?? (subpage ? Number(subpage) : 1);
  const page = kind === "pdf" && Number.isSafeInteger(requested) && requested >= 1
    ? Math.min(requested, 1_000_000) : 1;
  const subpath = kind === "pdf" ? `#page=${page}` : safeSubpath;
  return Object.freeze({
    path, title, kind, page, fit: options.fit === "width" ? "width" : "page",
    ...(subpath === undefined ? {} : { subpath }),
  });
}

export function navigateDocument(document: LocalDocument, delta: number): LocalDocument {
  if (document.kind !== "pdf" || !Number.isSafeInteger(delta)) return document;
  const page = Math.max(1, Math.min(1_000_000, document.page + delta));
  return Object.freeze({ ...document, page, subpath: `#page=${page}` });
}

export async function openLocalDocument(
  host: DocumentHost,
  file: unknown,
  options: { page?: number; fit?: DocumentFit; subpath?: unknown } = {},
): Promise<DocumentOpenResult> {
  const document = describeLocalDocument(file, options);
  if (!document) return { ok: false, reason: "invalid-path" };
  try {
    if (!host.hasFile(document.path)) return { ok: false, reason: "missing-file" };
    await host.openFile(document);
    return { ok: true, document };
  } catch {
    return { ok: false, reason: "open-failed" };
  }
}
