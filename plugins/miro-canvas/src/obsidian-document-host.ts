import type { TFile, App } from "obsidian";
import type { DocumentHost, LocalDocument } from "./document-viewer";

function get(value: unknown, key: string): unknown {
  try { return value && typeof value === "object" ? Reflect.get(value, key) : undefined; }
  catch { return undefined; }
}

/** Only the native PDF fit bridge uses private fields, and fails to native UI. */
export async function applyNativePdfFit(view: unknown, document: LocalDocument): Promise<boolean> {
  if (document.kind !== "pdf") return true;
  try {
    const ready = get(view, "viewer");
    if (typeof get(ready, "then") !== "function") return false;
    // A closed/unloaded view must not keep a plugin action waiting indefinitely.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const renderer = await Promise.race([
      Promise.resolve(ready),
      new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 2000); }),
    ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
    const pdf = get(get(renderer, "pdfViewer"), "pdfViewer");
    if (!pdf || typeof pdf !== "object" || typeof get(pdf, "currentScaleValue") !== "string") return false;
    return Reflect.set(pdf, "currentScaleValue", document.fit === "width" ? "page-width" : "page-fit");
  } catch { return false; }
}

export function createObsidianDocumentHost(
  app: App,
  diagnostic: (message: string) => void,
  isFile: (value: unknown) => value is TFile,
): DocumentHost {
  return {
    hasFile: (path) => isFile(app.vault.getAbstractFileByPath(path)),
    async openFile(document) {
      const file = app.vault.getAbstractFileByPath(document.path);
      if (!isFile(file)) throw new Error("Local file is unavailable.");
      const leaf = app.workspace.getLeaf("tab");
      await leaf.openFile(file, { active: true, ...(document.kind === "pdf"
        ? { eState: { subpath: `#page=${document.page}` } } : {}) });
      if (!await applyNativePdfFit(leaf.view, document)) {
        diagnostic("PDF opened. Automatic fit is unavailable in this Obsidian version; use the native viewer controls.");
      }
    },
  };
}
