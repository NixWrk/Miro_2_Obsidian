import { describe, expect, it } from "vitest";
import {
  crc32,
  jpegSize,
  makePdf,
  makePptx,
  makeZip,
  type ExportPage,
} from "../src/export-files";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** A minimal, valid baseline JPEG: SOI, SOF0 carrying width/height, EOI. */
function fakeJpeg(width: number, height: number): Uint8Array {
  return Uint8Array.of(
    0xff, 0xd8, // SOI
    0xff, 0xc0, 0x00, 0x0b, // SOF0, length 11
    0x08, // precision
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, 0x11, 0x00, // 1 component
    0xff, 0xd9, // EOI
  );
}

function page(overrides: Partial<ExportPage> & { readonly width: number; readonly height: number }): ExportPage {
  const pixelWidth = overrides.pixelWidth ?? Math.round(overrides.width * 2);
  const pixelHeight = overrides.pixelHeight ?? Math.round(overrides.height * 2);
  return {
    image: fakeJpeg(pixelWidth, pixelHeight),
    pixelWidth,
    pixelHeight,
    ...overrides,
  };
}

function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]!);
  return out;
}

// --- a tiny central-directory ZIP reader, for the ZIP and PPTX tests ---

interface ZipEntry {
  readonly path: string;
  readonly crc: number;
  readonly size: number;
  readonly method: number;
  readonly versionNeeded: number;
  readonly flags: number;
  readonly localOffset: number;
}

function readCentralDirectory(data: Uint8Array): ZipEntry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const eocdOffset = data.length - 22;
  expect(view.getUint32(eocdOffset, true)).toBe(0x06054b50);
  const totalEntries = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  expect(centralOffset + centralSize).toBe(eocdOffset);

  const entries: ZipEntry[] = [];
  let offset = centralOffset;
  for (let i = 0; i < totalEntries; i += 1) {
    expect(view.getUint32(offset, true)).toBe(0x02014b50);
    const versionNeeded = view.getUint16(offset + 6, true);
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const crc = view.getUint32(offset + 16, true);
    const size = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nameBytes = data.slice(offset + 46, offset + 46 + nameLen);
    entries.push({ path: textDecoder.decode(nameBytes), crc, size, method, versionNeeded, flags, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readZipFiles(data: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const files = new Map<string, Uint8Array>();
  for (const entry of readCentralDirectory(data)) {
    expect(view.getUint32(entry.localOffset, true)).toBe(0x04034b50);
    const nameLen = view.getUint16(entry.localOffset + 26, true);
    const extraLen = view.getUint16(entry.localOffset + 28, true);
    const dataStart = entry.localOffset + 30 + nameLen + extraLen;
    files.set(entry.path, data.slice(dataStart, dataStart + entry.size));
  }
  return files;
}

describe("crc32", () => {
  it("matches the standard test vectors", () => {
    expect(crc32(textEncoder.encode(""))).toBe(0);
    expect(crc32(textEncoder.encode("123456789"))).toBe(0xcbf43926);
  });
});

describe("makeZip", () => {
  it("produces entries a central-directory reader can recover, with correct sizes and CRCs", () => {
    const files = [
      { path: "[Content_Types].xml", data: textEncoder.encode("<Types/>") },
      { path: "a/b.txt", data: textEncoder.encode("hello world") },
      { path: "empty.txt", data: new Uint8Array(0) },
    ];
    const zip = makeZip(files);
    const entries = readCentralDirectory(zip);
    expect(entries.map((e) => e.path)).toEqual(files.map((f) => f.path));
    entries.forEach((entry, i) => {
      expect(entry.size).toBe(files[i]!.data.length);
      expect(entry.crc).toBe(crc32(files[i]!.data));
      expect(entry.method).toBe(0); // stored
      expect(entry.versionNeeded).toBe(20);
      expect(entry.flags & 0x0800).toBe(0x0800); // UTF-8 names
    });

    const extracted = readZipFiles(zip);
    for (const file of files) {
      expect(extracted.get(file.path)).toEqual(file.data);
    }
  });
});

describe("jpegSize", () => {
  it("reads width and height from a baseline JPEG's SOF0 marker", () => {
    expect(jpegSize(fakeJpeg(640, 480))).toEqual({ width: 640, height: 480 });
    expect(jpegSize(fakeJpeg(1, 1))).toEqual({ width: 1, height: 1 });
  });

  it("returns undefined for data that is not a JPEG", () => {
    expect(jpegSize(Uint8Array.of(0, 1, 2, 3))).toBeUndefined();
    expect(jpegSize(textEncoder.encode("not a jpeg at all"))).toBeUndefined();
    expect(jpegSize(new Uint8Array(0))).toBeUndefined();
    expect(jpegSize(Uint8Array.of(0xff, 0xd8, 0xff, 0xd9))).toBeUndefined(); // SOI, EOI, no SOF
  });
});

describe("makePdf", () => {
  it("throws a plain-English error for bad input", () => {
    expect(() => makePdf([])).toThrow(/no pages|page/iu);
    expect(() => makePdf([page({ width: 0, height: 100 })])).toThrow();
    expect(() => makePdf([page({ width: 100, height: Number.NaN })])).toThrow();
    expect(() => makePdf([page({ width: 100, height: 100, image: new Uint8Array(0) })])).toThrow();
    expect(() => makePdf([page({ width: 100, height: 100, pixelWidth: 0 })])).toThrow();
    expect(() => makePdf([page({ width: 100, height: 100, pixelHeight: -5 })])).toThrow();
  });

  it("writes a well-formed single-page PDF with a correct xref table", () => {
    const pages = [page({ width: 612, height: 792, pixelWidth: 1224, pixelHeight: 1584 })];
    const pdf = makePdf(pages);
    const text = latin1(pdf);

    expect(text.startsWith("%PDF-1.4\n")).toBe(true);

    const pageMatches = text.match(/\/Type\s*\/Page(?!s)\b/gu) ?? [];
    expect(pageMatches.length).toBe(1);

    const mediaBox = /\/MediaBox \[0 0 (\S+) (\S+)\]/u.exec(text);
    expect(mediaBox).not.toBeNull();
    expect(Number(mediaBox![1])).toBe(612);
    expect(Number(mediaBox![2])).toBe(792);

    const startxrefMatch = /startxref\n(\d+)\n%%EOF$/u.exec(text);
    expect(startxrefMatch).not.toBeNull();
    const xrefOffset = Number(startxrefMatch![1]);
    expect(text.slice(xrefOffset, xrefOffset + 4)).toBe("xref");

    const headerMatch = /^xref\n0 (\d+)\r?\n/u.exec(text.slice(xrefOffset));
    expect(headerMatch).not.toBeNull();
    const total = Number(headerMatch![1]);
    let pos = xrefOffset + headerMatch![0].length;
    for (let id = 0; id < total; id += 1) {
      const line = text.slice(pos, pos + 20);
      expect(line.length).toBe(20);
      pos += 20;
      if (id === 0) {
        expect(line).toBe("0000000000 65535 f\r\n");
        continue;
      }
      const objOffset = Number(line.slice(0, 10));
      expect(text.slice(objOffset, objOffset + `${id} 0 obj`.length)).toBe(`${id} 0 obj`);
    }
  });

  it("counts one /Type /Page per page, distinct from /Type /Pages", () => {
    const pages = [
      page({ width: 300, height: 300 }),
      page({ width: 300, height: 300 }),
      page({ width: 300, height: 300 }),
    ];
    const text = latin1(makePdf(pages));
    const pageMatches = text.match(/\/Type\s*\/Page(?!s)\b/gu) ?? [];
    expect(pageMatches.length).toBe(3);
    expect(text).toContain("/Type /Pages");
    expect(text).toContain("/Count 3");
  });

  it("encodes a Cyrillic title as a UTF-16BE hex string with a BOM", () => {
    const title = "Отчёт по доске";
    const pdf = makePdf([page({ width: 400, height: 300 })], { title, author: "Автор" });
    const text = latin1(pdf);
    const titleMatch = /\/Title <([0-9a-fA-F]+)>/u.exec(text);
    expect(titleMatch).not.toBeNull();
    const hex = titleMatch![1]!;
    expect(hex.slice(0, 4).toLowerCase()).toBe("feff");
    let decoded = "";
    for (let i = 4; i < hex.length; i += 4) decoded += String.fromCharCode(Number.parseInt(hex.slice(i, i + 4), 16));
    expect(decoded).toBe(title);

    const authorMatch = /\/Author <([0-9a-fA-F]+)>/u.exec(text);
    expect(authorMatch).not.toBeNull();
  });

  it("adds an outline only when at least one page has a title", () => {
    const untitled = latin1(makePdf([page({ width: 200, height: 200 }), page({ width: 200, height: 200 })]));
    expect(untitled).not.toContain("/Type /Outlines");
    expect(untitled).not.toContain("/PageMode");

    const titled = latin1(makePdf([
      page({ width: 200, height: 200, title: "First" }),
      page({ width: 200, height: 200 }),
      page({ width: 200, height: 200, title: "Third" }),
    ]));
    expect(titled).toContain("/Type /Outlines");
    expect(titled).toContain("/PageMode /UseOutlines");
    expect(titled.match(/\/Dest \[/gu) ?? []).toHaveLength(2);
  });

  it("places the image using the given placement, converted to PDF's bottom-left origin", () => {
    const pages = [page({
      width: 400,
      height: 300,
      placement: { x: 10, y: 20, width: 100, height: 50 },
    })];
    const text = latin1(makePdf(pages));
    // page.height - placement.y - placement.height = 300 - 20 - 50 = 230
    expect(text).toContain("q 100 0 0 50 10 230 cm /Im0 Do Q");
  });
});

describe("makePptx", () => {
  const RELATIONSHIPS_NS_TAG = "Relationship ";

  function resolveTarget(relsPath: string, target: string): string {
    if (target.startsWith("/")) return target.slice(1);
    // ".rels" files resolve relative to the folder containing their "_rels"
    // folder; the package-root one ("_rels/.rels") resolves to the root.
    const base = relsPath === "_rels/.rels" ? "" : relsPath.replace(/(^|\/)_rels\/[^/]+$/u, "");
    const parts = base.length > 0 ? base.split("/") : [];
    for (const segment of target.split("/")) {
      if (segment === "..") parts.pop();
      else if (segment !== ".") parts.push(segment);
    }
    return parts.join("/");
  }

  it("throws a plain-English error for bad input", () => {
    expect(() => makePptx([])).toThrow();
    expect(() => makePptx([page({ width: -1, height: 100 })])).toThrow();
    expect(() => makePptx([page({ width: 100, height: 100, image: new Uint8Array(0) })])).toThrow();
    expect(() => makePptx([page({ width: 100, height: 100, pixelWidth: Number.NaN })])).toThrow();
  });

  it("builds a package with every required part, correctly cross-referenced", () => {
    const pages = [
      page({ width: 720, height: 540, title: "Title & <special> \"chars\" 'here'" }),
      page({ width: 400, height: 100 }), // a different aspect ratio than the first page
    ];
    const pptx = makePptx(pages, { title: "My Deck", author: "Author" });
    const entries = readCentralDirectory(pptx);
    const files = readZipFiles(pptx);

    expect(entries[0]!.path).toBe("[Content_Types].xml");

    const required = [
      "[Content_Types].xml",
      "_rels/.rels",
      "docProps/core.xml",
      "docProps/app.xml",
      "ppt/presentation.xml",
      "ppt/_rels/presentation.xml.rels",
      "ppt/presProps.xml",
      "ppt/viewProps.xml",
      "ppt/tableStyles.xml",
      "ppt/theme/theme1.xml",
      "ppt/slideMasters/slideMaster1.xml",
      "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      "ppt/slideLayouts/slideLayout1.xml",
      "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
      "ppt/slides/slide1.xml",
      "ppt/slides/_rels/slide1.xml.rels",
      "ppt/media/image1.jpeg",
      "ppt/slides/slide2.xml",
      "ppt/slides/_rels/slide2.xml.rels",
      "ppt/media/image2.jpeg",
    ];
    for (const path of required) {
      expect(files.has(path), `missing part ${path}`).toBe(true);
    }

    // Every Override PartName in [Content_Types].xml resolves to a real part.
    const contentTypes = textDecoder.decode(files.get("[Content_Types].xml")!);
    const overrides = [...contentTypes.matchAll(/<Override PartName="([^"]+)"/gu)].map((m) => m[1]!);
    expect(overrides.length).toBeGreaterThan(0);
    for (const partName of overrides) {
      expect(files.has(partName.replace(/^\//u, "")), `Override part missing: ${partName}`).toBe(true);
    }
    // And every part with a distinct content type appears in the overrides (slides included).
    expect(overrides).toContain("/ppt/slides/slide1.xml");
    expect(overrides).toContain("/ppt/slides/slide2.xml");

    // Every relationship Target in every .rels part resolves to a part that exists.
    for (const [path, data] of files) {
      if (!path.endsWith(".rels")) continue;
      const xml = textDecoder.decode(data);
      const targets = [...xml.matchAll(/<Relationship[^>]*\sTarget="([^"]+)"/gu)].map((m) => m[1]!);
      expect(targets.length).toBeGreaterThan(0);
      for (const target of targets) {
        const resolved = resolveTarget(path, target);
        expect(files.has(resolved), `${path} -> ${target} (resolved: ${resolved})`).toBe(true);
      }
    }

    // Slide size equals the first page's size, in EMU (1 pt = 12700 EMU).
    const presentationXml = textDecoder.decode(files.get("ppt/presentation.xml")!);
    const sldSz = /<p:sldSz cx="(\d+)" cy="(\d+)"\/>/u.exec(presentationXml);
    expect(sldSz).not.toBeNull();
    expect(Number(sldSz![1])).toBe(720 * 12700);
    expect(Number(sldSz![2])).toBe(540 * 12700);

    // The second page, a different aspect ratio and no placement, is fitted
    // (uniform scale, no distortion) and centred within the fixed slide size.
    const slide2 = textDecoder.decode(files.get("ppt/slides/slide2.xml")!);
    const pic = /<p:spPr><a:xfrm><a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/u.exec(slide2);
    expect(pic).not.toBeNull();
    const slideWidthPt = 720;
    const slideHeightPt = 540;
    const pageWidthPt = 400;
    const pageHeightPt = 100;
    const scale = Math.min(slideWidthPt / pageWidthPt, slideHeightPt / pageHeightPt);
    const expectedWidth = Math.round(pageWidthPt * scale * 12700);
    const expectedHeight = Math.round(pageHeightPt * scale * 12700);
    const expectedX = Math.round(((slideWidthPt - pageWidthPt * scale) / 2) * 12700);
    const expectedY = Math.round(((slideHeightPt - pageHeightPt * scale) / 2) * 12700);
    expect(Number(pic![1])).toBe(expectedX);
    expect(Number(pic![2])).toBe(expectedY);
    expect(Number(pic![3])).toBe(expectedWidth);
    expect(Number(pic![4])).toBe(expectedHeight);
    // The picture keeps its aspect ratio: same scale on both axes.
    expect(expectedWidth / pageWidthPt).toBeCloseTo(expectedHeight / pageHeightPt, 5);

    // The first page's own size equals the slide size, so its picture fills it exactly.
    const slide1 = textDecoder.decode(files.get("ppt/slides/slide1.xml")!);
    const pic1 = /<p:spPr><a:xfrm><a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/u.exec(slide1);
    expect(pic1).not.toBeNull();
    expect(Number(pic1![1])).toBe(0);
    expect(Number(pic1![2])).toBe(0);
    expect(Number(pic1![3])).toBe(720 * 12700);
    expect(Number(pic1![4])).toBe(540 * 12700);

    // XML escaping: the raw special characters must not appear unescaped in the title's home (the picture's descr).
    expect(slide1).toContain("descr=\"Title &amp; &lt;special&gt; &quot;chars&quot; &apos;here&apos;\"");
    expect(slide1).not.toContain("descr=\"Title & <special>");

    // docProps/app.xml titles list is escaped too, and Slides count is right.
    const appXml = textDecoder.decode(files.get("docProps/app.xml")!);
    expect(appXml).toContain("<Slides>2</Slides>");
    expect(appXml).toContain("Title &amp; &lt;special&gt;");

    void RELATIONSHIPS_NS_TAG; // documents the tag we scan for above
  });

  it("honours an explicit placement, scaling it from the page's own point size", () => {
    // First page sets the slide size; give it a sub-rect placement and check
    // it maps through the identity transform (its own size == slide size).
    const pages = [page({
      width: 800,
      height: 600,
      placement: { x: 100, y: 50, width: 200, height: 150 },
    })];
    const pptx = makePptx(pages);
    const files = readZipFiles(pptx);
    const slide1 = textDecoder.decode(files.get("ppt/slides/slide1.xml")!);
    const pic = /<p:spPr><a:xfrm><a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(\d+)" cy="(\d+)"\/>/u.exec(slide1);
    expect(pic).not.toBeNull();
    expect(Number(pic![1])).toBe(100 * 12700);
    expect(Number(pic![2])).toBe(50 * 12700);
    expect(Number(pic![3])).toBe(200 * 12700);
    expect(Number(pic![4])).toBe(150 * 12700);
  });
});
