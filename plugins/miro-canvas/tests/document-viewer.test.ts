import { describe, expect, it, vi } from "vitest";
import { describeLocalDocument, localDocumentPath, navigateDocument, openLocalDocument } from "../src/document-viewer";

describe("local document viewer", () => {
  it("accepts only vault-relative local paths, without interpreting source URLs", () => {
    for (const path of ["https://example.org/a.pdf", "file:///C:/a.pdf", "data:text/html,x",
      "javascript:x", "C:\\a.pdf", "\\\\server\\a.pdf", "/a.pdf", "../a.pdf", "a/../b.pdf",
      "a//b.pdf", "a/./b.pdf", "%2e%2e/a.pdf", "a%2fb.pdf", "%252e%252e/a.pdf", "a\u0000.pdf", " a.pdf"])
      expect(localDocumentPath(path), path).toBeNull();
    expect(localDocumentPath("attachments\\Отчёт #1.pdf")).toBe("attachments/Отчёт #1.pdf");
  });

  it("classifies documents without inventing previews for unsupported formats", () => {
    expect(describeLocalDocument("file.PDF", { subpath: "#page=4", fit: "width" }))
      .toMatchObject({ kind: "pdf", page: 4, fit: "width", subpath: "#page=4" });
    expect(describeLocalDocument("note.md", { page: 4 })?.page).toBe(1);
    expect(describeLocalDocument("note.md", { subpath: "#Section 2" })?.subpath).toBe("#Section 2");
    expect(describeLocalDocument("image.png")?.kind).toBe("image");
    for (const file of ["image.svg", "document.docx", "page.html"])
      expect(describeLocalDocument(file)?.kind).toBe("file");
  });

  it("bounds navigation without pretending to know the page count", () => {
    const document = describeLocalDocument("a.pdf")!;
    expect(navigateDocument(document, -10).page).toBe(1);
    expect(navigateDocument(document, 1).page).toBe(2);
    expect(navigateDocument(document, 1).subpath).toBe("#page=2");
    expect(navigateDocument(document, Infinity)).toBe(document);
    expect(describeLocalDocument("a.pdf", { page: NaN })?.page).toBe(1);
    expect(describeLocalDocument("a.pdf", { page: 5_000_000 })?.page).toBe(1_000_000);
    expect(document.page).toBe(1);
  });

  it("opens only an existing local file after the explicit call", async () => {
    const openFile = vi.fn();
    const host = { hasFile: (path: string) => path === "a.pdf", openFile };
    expect(openFile).not.toHaveBeenCalled();
    expect(await openLocalDocument(host, "missing.pdf")).toEqual({ ok: false, reason: "missing-file" });
    expect(await openLocalDocument(host, "https://example.org/a.pdf")).toEqual({ ok: false, reason: "invalid-path" });
    expect(openFile).not.toHaveBeenCalled();
    expect((await openLocalDocument(host, "a.pdf", { page: 2 })).ok).toBe(true);
    expect(openFile).toHaveBeenCalledOnce();
    expect(openFile.mock.calls[0][0]).toMatchObject({ path: "a.pdf", page: 2 });
  });

  it("reports host errors without exposing paths or mutating the source", async () => {
    expect(await openLocalDocument({ hasFile: () => true, openFile: () => { throw new Error("private"); } }, "a.pdf"))
      .toEqual({ ok: false, reason: "open-failed" });
  });
});
