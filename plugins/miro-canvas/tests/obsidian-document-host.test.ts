import { describe, expect, it, vi } from "vitest";

import type { TFile, App } from "obsidian";
import { applyNativePdfFit, createObsidianDocumentHost } from "../src/obsidian-document-host";
import { describeLocalDocument } from "../src/document-viewer";

describe("native document host", () => {
  it("uses native page navigation and an explicitly detected PDF fit bridge", async () => {
    const file = {} as TFile;
    const pdf = { currentScaleValue: "page-width" };
    const openFile = vi.fn();
    const leaf = { openFile, view: { viewer: Promise.resolve({ pdfViewer: { pdfViewer: pdf } }) } };
    const app = {
      vault: { getAbstractFileByPath: (path: string) => path === "local.pdf" ? file : null },
      workspace: { getLeaf: vi.fn(() => leaf) },
    } as unknown as App;
    const diagnostic = vi.fn();
    const host = createObsidianDocumentHost(app, diagnostic, (value): value is TFile => value === file);
    expect(host.hasFile("local.pdf")).toBe(true);
    expect(host.hasFile("missing.pdf")).toBe(false);
    expect(openFile).not.toHaveBeenCalled();
    await host.openFile(describeLocalDocument("local.pdf", { page: 3 })!);
    expect(openFile).toHaveBeenCalledWith(file, { active: true, eState: { subpath: "#page=3" } });
    expect(pdf.currentScaleValue).toBe("page-fit");
    expect(diagnostic).not.toHaveBeenCalled();
  });

  it("does not pretend unknown native fit fields were supported", async () => {
    expect(await applyNativePdfFit({}, describeLocalDocument("local.pdf")!)).toBe(false);
    expect(await applyNativePdfFit({ viewer: Promise.reject(new Error("closed")) }, describeLocalDocument("local.pdf")!)).toBe(false);
    expect(await applyNativePdfFit({}, describeLocalDocument("local.md")!)).toBe(true);
  });

  it("times out a never-ready PDF viewer without writing anything", async () => {
    vi.useFakeTimers();
    try {
      const result = applyNativePdfFit({ viewer: new Promise(() => {}) }, describeLocalDocument("local.pdf")!);
      await vi.advanceTimersByTimeAsync(2001);
      expect(await result).toBe(false);
    } finally { vi.useRealTimers(); }
  });
});
