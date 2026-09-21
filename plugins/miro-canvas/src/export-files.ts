/**
 * Packs whiteboard export pages — JPEG pictures plus page geometry — into
 * standalone PDF and PPTX files, and exposes the small PDF/ZIP/JPEG
 * primitives that back them. No third-party libraries: a PDF and Office
 * document reader is a lot of bundle weight for "paste some JPEGs onto
 * pages," so every byte here is written by hand.
 */

/** One page of an export: its size on paper and the picture that fills it. */
export interface ExportPage {
  /** The page's size in points (1/72 inch). */
  readonly width: number;
  readonly height: number;
  /** A baseline JPEG and its size in pixels. */
  readonly image: Uint8Array;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  /** Where the picture sits, in points from the page's top-left; the whole page when left out. */
  readonly placement?: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  /** The page's name: a PDF bookmark, a slide title (hidden, for the outline / accessibility). */
  readonly title?: string;
}

export interface ExportInfo {
  readonly title?: string;
  readonly author?: string;
}

const EMU_PER_POINT = 12700;
const UTF8_ENCODER = new TextEncoder();

// ---------------------------------------------------------------------------
// Shared byte plumbing
// ---------------------------------------------------------------------------

/**
 * Accumulates output as a list of byte chunks and joins them once at the
 * end. Every write here takes bytes or plain-ASCII text; nothing is ever
 * round-tripped through a JS string as Latin-1, so bytes above 127 (JPEG
 * data, UTF-8 names) survive untouched.
 */
class ByteWriter {
  private readonly chunks: Uint8Array[] = [];
  private total = 0;

  get size(): number {
    return this.total;
  }

  bytes(data: Uint8Array): this {
    this.chunks.push(data);
    this.total += data.length;
    return this;
  }

  /** Writes text known to be ASCII-only (PDF syntax, hex strings, XML we generated). */
  ascii(text: string): this {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff;
    return this.bytes(out);
  }

  utf8(text: string): this {
    return this.bytes(UTF8_ENCODER.encode(text));
  }

  u16(value: number): this {
    return this.bytes(Uint8Array.of(value & 0xff, (value >>> 8) & 0xff));
  }

  u32(value: number): this {
    return this.bytes(Uint8Array.of(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff));
  }

  build(): Uint8Array {
    const out = new Uint8Array(this.total);
    let offset = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }
}

function validatePages(pages: readonly ExportPage[]): void {
  if (pages.length === 0) throw new Error("Cannot export with no pages.");
  pages.forEach((page, index) => {
    const at = `Page ${index + 1}`;
    if (!Number.isFinite(page.width) || page.width <= 0 || !Number.isFinite(page.height) || page.height <= 0) {
      throw new Error(`${at} has an invalid page size: width and height must be positive, finite numbers.`);
    }
    if (page.image.length === 0) {
      throw new Error(`${at} has no image data.`);
    }
    if (!Number.isFinite(page.pixelWidth) || page.pixelWidth <= 0 || !Number.isFinite(page.pixelHeight) || page.pixelHeight <= 0) {
      throw new Error(`${at} has an invalid pixel size: width and height must be positive numbers.`);
    }
  });
}

/** The picture's placement, defaulting to the whole page when none was given. */
function resolvedPlacement(page: ExportPage): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  return page.placement ?? { x: 0, y: 0, width: page.width, height: page.height };
}

// ---------------------------------------------------------------------------
// CRC-32 and ZIP
// ---------------------------------------------------------------------------

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE) of some bytes. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// A fixed DOS date/time (1980-01-01, midnight — the oldest date the format
// allows) instead of the real clock, so the same input always produces the
// same ZIP bytes.
const DOS_TIME = 0;
const DOS_DATE = 0x21;

/** A ZIP archive of the given files, stored without compression. */
export function makeZip(files: readonly { readonly path: string; readonly data: Uint8Array }[]): Uint8Array {
  const entries = files.map((file) => ({
    nameBytes: UTF8_ENCODER.encode(file.path),
    data: file.data,
    crc: crc32(file.data),
  }));

  const writer = new ByteWriter();
  const central = new ByteWriter();

  for (const entry of entries) {
    const localOffset = writer.size;
    writer
      .u32(0x04034b50)
      .u16(20) // version needed to extract
      .u16(0x0800) // general purpose flag: bit 11, UTF-8 names
      .u16(0) // method: stored
      .u16(DOS_TIME)
      .u16(DOS_DATE)
      .u32(entry.crc)
      .u32(entry.data.length) // compressed size == uncompressed size (stored)
      .u32(entry.data.length)
      .u16(entry.nameBytes.length)
      .u16(0) // extra field length
      .bytes(entry.nameBytes)
      .bytes(entry.data);

    central
      .u32(0x02014b50)
      .u16(20) // version made by
      .u16(20) // version needed to extract
      .u16(0x0800)
      .u16(0)
      .u16(DOS_TIME)
      .u16(DOS_DATE)
      .u32(entry.crc)
      .u32(entry.data.length)
      .u32(entry.data.length)
      .u16(entry.nameBytes.length)
      .u16(0) // extra field length
      .u16(0) // file comment length
      .u16(0) // disk number start
      .u16(0) // internal file attributes
      .u32(0) // external file attributes
      .u32(localOffset)
      .bytes(entry.nameBytes);
  }

  const centralOffset = writer.size;
  const centralBytes = central.build();
  writer.bytes(centralBytes);

  writer
    .u32(0x06054b50)
    .u16(0) // disk number
    .u16(0) // disk where central directory starts
    .u16(entries.length)
    .u16(entries.length)
    .u32(centralBytes.length)
    .u32(centralOffset)
    .u16(0); // comment length

  return writer.build();
}

// ---------------------------------------------------------------------------
// JPEG size sniffing
// ---------------------------------------------------------------------------

// SOF0..SOF15 mark a frame header, except DHT (C4), the reserved JPG
// extension (C8) and DAC (CC), which share the C0-CF range but are not frames.
function isSofMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function isStandaloneMarker(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

/** The size of a JPEG in pixels, read from its SOF marker, or undefined for data that is not one. */
export function jpegSize(image: Uint8Array): { readonly width: number; readonly height: number } | undefined {
  if (image.length < 4 || image[0] !== 0xff || image[1] !== 0xd8) return undefined;
  let offset = 2;
  while (offset + 3 < image.length) {
    if (image[offset] !== 0xff) return undefined;
    const marker = image[offset + 1]!;
    offset += 2;
    if (marker === 0xd9) return undefined; // EOI reached before any SOF
    if (isStandaloneMarker(marker)) continue;
    if (offset + 1 >= image.length) return undefined;
    const length = (image[offset]! << 8) | image[offset + 1]!;
    if (isSofMarker(marker)) {
      const payloadStart = offset + 2; // precision(1) height(2) width(2) ...
      if (payloadStart + 5 > image.length) return undefined;
      const height = (image[payloadStart + 1]! << 8) | image[payloadStart + 2]!;
      const width = (image[payloadStart + 3]! << 8) | image[payloadStart + 4]!;
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    if (marker === 0xda || length < 2) return undefined; // scan data reached, no SOF found
    offset += length;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

function pdfNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 10000) / 10000;
  const text = rounded.toFixed(4).replace(/0+$/u, "").replace(/\.$/u, "");
  return text === "" || text === "-0" ? "0" : text;
}

// Titles are user text (Cyrillic board and page names, say), and PDF's plain
// literal strings only cover Latin-1. Hex strings prefixed with a UTF-16BE
// byte-order mark are the one PDF string form that round-trips any script
// and never needs escaping.
function pdfTextString(text: string): string {
  let hex = "feff";
  for (let i = 0; i < text.length; i += 1) hex += text.charCodeAt(i).toString(16).padStart(4, "0");
  return `<${hex}>`;
}

function pdfDate(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `(D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z)`;
}

function hasTitle(page: ExportPage): page is ExportPage & { readonly title: string } {
  return typeof page.title === "string" && page.title.length > 0;
}

/** A PDF with one page per entry, each showing its picture. */
export function makePdf(pages: readonly ExportPage[], info: ExportInfo = {}): Uint8Array {
  validatePages(pages);

  // Object numbers are allocated up front so every dictionary can reference
  // forward (Pages -> Kids, Catalog -> Outlines) without a patch-up pass.
  let nextId = 1;
  const catalogId = nextId++;
  const pagesId = nextId++;
  const pageIds: number[] = [];
  const contentIds: number[] = [];
  const imageIds: number[] = [];
  for (const _page of pages) {
    pageIds.push(nextId++);
    contentIds.push(nextId++);
    imageIds.push(nextId++);
  }
  const infoId = nextId++;

  const titledIndices: number[] = [];
  pages.forEach((page, index) => { if (hasTitle(page)) titledIndices.push(index); });
  let outlinesId: number | undefined;
  const outlineItemIds: number[] = [];
  if (titledIndices.length > 0) {
    outlinesId = nextId++;
    for (const _index of titledIndices) outlineItemIds.push(nextId++);
  }

  const writer = new ByteWriter();
  const offsets = new Map<number, number>();

  writer.ascii("%PDF-1.4\n");
  writer.bytes(Uint8Array.of(0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a)); // binary comment line

  const beginObj = (id: number): void => {
    offsets.set(id, writer.size);
    writer.ascii(`${id} 0 obj\n`);
  };
  const endObj = (): void => {
    writer.ascii("\nendobj\n");
  };

  // Catalog
  beginObj(catalogId);
  writer.ascii(outlinesId !== undefined
    ? `<< /Type /Catalog /Pages ${pagesId} 0 R /PageMode /UseOutlines /Outlines ${outlinesId} 0 R >>`
    : `<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  endObj();

  // Pages
  beginObj(pagesId);
  writer.ascii(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  endObj();

  pages.forEach((page, index) => {
    const placement = resolvedPlacement(page);
    // Convert the top-left placement PowerPoint/Canvas use to PDF's
    // bottom-left page origin.
    const w = pdfNumber(placement.width);
    const h = pdfNumber(placement.height);
    const x = pdfNumber(placement.x);
    const y = pdfNumber(page.height - placement.y - placement.height);

    beginObj(pageIds[index]!);
    writer.ascii(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${pdfNumber(page.width)} ${pdfNumber(page.height)}] ` +
      `/Resources << /XObject << /Im0 ${imageIds[index]} 0 R >> >> /Contents ${contentIds[index]} 0 R >>`,
    );
    endObj();

    const content = UTF8_ENCODER.encode(`q ${w} 0 0 ${h} ${x} ${y} cm /Im0 Do Q\n`);
    beginObj(contentIds[index]!);
    writer.ascii(`<< /Length ${content.length} >>\nstream\n`).bytes(content).ascii("\nendstream");
    endObj();

    beginObj(imageIds[index]!);
    writer.ascii(
      `<< /Type /XObject /Subtype /Image /Width ${page.pixelWidth} /Height ${page.pixelHeight} ` +
      `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.image.length} >>\nstream\n`,
    ).bytes(page.image).ascii("\nendstream");
    endObj();
  });

  // Info
  const infoEntries: string[] = [];
  if (info.title) infoEntries.push(`/Title ${pdfTextString(info.title)}`);
  if (info.author) infoEntries.push(`/Author ${pdfTextString(info.author)}`);
  infoEntries.push(`/Producer ${pdfTextString("Miro Canvas")}`);
  infoEntries.push(`/CreationDate ${pdfDate(new Date())}`);
  beginObj(infoId);
  writer.ascii(`<< ${infoEntries.join(" ")} >>`);
  endObj();

  // Outlines (bookmarks), only when at least one page has a title.
  if (outlinesId !== undefined) {
    const firstId = outlineItemIds[0]!;
    const lastId = outlineItemIds[outlineItemIds.length - 1]!;
    beginObj(outlinesId);
    writer.ascii(`<< /Type /Outlines /First ${firstId} 0 R /Last ${lastId} 0 R /Count ${outlineItemIds.length} >>`);
    endObj();

    titledIndices.forEach((pageIndex, k) => {
      const page = pages[pageIndex]!;
      const parts = [`/Title ${pdfTextString(page.title!)}`, `/Parent ${outlinesId} 0 R`];
      if (k > 0) parts.push(`/Prev ${outlineItemIds[k - 1]} 0 R`);
      if (k < outlineItemIds.length - 1) parts.push(`/Next ${outlineItemIds[k + 1]} 0 R`);
      parts.push(`/Dest [${pageIds[pageIndex]} 0 R /Fit]`);
      beginObj(outlineItemIds[k]!);
      writer.ascii(`<< ${parts.join(" ")} >>`);
      endObj();
    });
  }

  const xrefOffset = writer.size;
  const totalObjects = nextId - 1;
  writer.ascii(`xref\n0 ${totalObjects + 1}\n`);
  writer.ascii("0000000000 65535 f\r\n");
  for (let id = 1; id <= totalObjects; id += 1) {
    writer.ascii(`${String(offsets.get(id)!).padStart(10, "0")} 00000 n\r\n`);
  }
  writer.ascii(
    `trailer\n<< /Size ${totalObjects + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\n` +
    `startxref\n${xrefOffset}\n%%EOF`,
  );

  return writer.build();
}

// ---------------------------------------------------------------------------
// PPTX
// ---------------------------------------------------------------------------

function xmlEscape(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&apos;");
}

function toEmu(points: number): number {
  return Math.round(points * EMU_PER_POINT);
}

// PowerPoint has exactly one slide size per file; later pages can have a
// different point size (a different frame captured at a different aspect),
// so each picture is fitted (uniform scale, centred) into the slide the
// same way a page itself would be fitted onto a different-shaped sheet.
// When a page's own size equals the slide size (always true for the first
// page) this reduces to the identity: the placement maps straight through.
function slidePicture(
  page: ExportPage,
  slideWidthPt: number,
  slideHeightPt: number,
): { readonly x: number; readonly y: number; readonly width: number; readonly height: number } {
  const box = resolvedPlacement(page);
  const scale = Math.min(slideWidthPt / page.width, slideHeightPt / page.height);
  const offsetX = (slideWidthPt - page.width * scale) / 2;
  const offsetY = (slideHeightPt - page.height * scale) / 2;
  return {
    x: offsetX + box.x * scale,
    y: offsetY + box.y * scale,
    width: box.width * scale,
    height: box.height * scale,
  };
}

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const FIXED_DATE = "1980-01-01T00:00:00Z"; // deterministic output, same spirit as the ZIP's fixed DOS date

function contentTypesXml(slideCount: number): string {
  const slideOverrides = Array.from({ length: slideCount }, (_, i) =>
    `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Default Extension="jpeg" ContentType="image/jpeg"/>` +
    `<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>` +
    `<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>` +
    `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
    `<Override PartName="/ppt/presProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"/>` +
    `<Override PartName="/ppt/viewProps.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"/>` +
    `<Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/>` +
    `<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>` +
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>` +
    `<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>` +
    slideOverrides +
    `</Types>`;
}

const ROOT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<Relationships xmlns="${PKG_REL}">` +
  `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/>` +
  `<Relationship Id="rId2" Type="${PKG_REL}/metadata/core-properties" Target="docProps/core.xml"/>` +
  `<Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/>` +
  `</Relationships>`;

function corePropsXml(info: ExportInfo): string {
  const titleEl = info.title ? `<dc:title>${xmlEscape(info.title)}</dc:title>` : "";
  const creatorEl = info.author ? `<dc:creator>${xmlEscape(info.author)}</dc:creator>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ` +
    `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `${titleEl}${creatorEl}` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${FIXED_DATE}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${FIXED_DATE}</dcterms:modified>` +
    `</cp:coreProperties>`;
}

function appPropsXml(pages: readonly ExportPage[]): string {
  const titles = pages.map((page, i) => `<vt:lpstr>${xmlEscape(page.title ?? `Slide ${i + 1}`)}</vt:lpstr>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ` +
    `xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
    `<Application>Miro Canvas</Application><PresentationFormat>Custom</PresentationFormat>` +
    `<Slides>${pages.length}</Slides>` +
    `<TitlesOfParts><vt:vector size="${pages.length}" baseType="lpstr">${titles}</vt:vector></TitlesOfParts>` +
    `</Properties>`;
}

function presentationXml(slideCount: number, widthEmu: number, heightEmu: number): string {
  const sldIds = Array.from({ length: slideCount }, (_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL}" ` +
    `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>` +
    `<p:sldIdLst>${sldIds}</p:sldIdLst>` +
    `<p:sldSz cx="${widthEmu}" cy="${heightEmu}"/>` +
    `<p:notesSz cx="6858000" cy="9144000"/>` +
    `</p:presentation>`;
}

function presentationRelsXml(slideCount: number): string {
  const slideRels = Array.from({ length: slideCount }, (_, i) =>
    `<Relationship Id="rId${i + 2}" Type="${REL}/slide" Target="slides/slide${i + 1}.xml"/>`).join("");
  const n = slideCount;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="${PKG_REL}">` +
    `<Relationship Id="rId1" Type="${REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/>` +
    slideRels +
    `<Relationship Id="rId${n + 2}" Type="${REL}/presProps" Target="presProps.xml"/>` +
    `<Relationship Id="rId${n + 3}" Type="${REL}/viewProps" Target="viewProps.xml"/>` +
    `<Relationship Id="rId${n + 4}" Type="${REL}/tableStyles" Target="tableStyles.xml"/>` +
    `</Relationships>`;
}

const PRES_PROPS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<p:presentationPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL}" ` +
  `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`;

const VIEW_PROPS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<p:viewPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL}" ` +
  `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"/>`;

const TABLE_STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ` +
  `def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`;

// A complete minimal theme: PowerPoint refuses one missing any of the 12
// scheme colours or the 3 fills / 3 lines / 3 effects / 3 background fills.
const THEME_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Miro Canvas Export">` +
  `<a:themeElements>` +
  `<a:clrScheme name="Miro Canvas">` +
  `<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>` +
  `<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>` +
  `<a:dk2><a:srgbClr val="44546A"/></a:dk2>` +
  `<a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>` +
  `<a:accent1><a:srgbClr val="4472C4"/></a:accent1>` +
  `<a:accent2><a:srgbClr val="ED7D31"/></a:accent2>` +
  `<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3>` +
  `<a:accent4><a:srgbClr val="FFC000"/></a:accent4>` +
  `<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5>` +
  `<a:accent6><a:srgbClr val="70AD47"/></a:accent6>` +
  `<a:hlink><a:srgbClr val="0563C1"/></a:hlink>` +
  `<a:folHlink><a:srgbClr val="954F72"/></a:folHlink>` +
  `</a:clrScheme>` +
  `<a:fontScheme name="Miro Canvas">` +
  `<a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>` +
  `<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>` +
  `</a:fontScheme>` +
  `<a:fmtScheme name="Miro Canvas">` +
  `<a:fillStyleLst>` +
  `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
  `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
  `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
  `</a:fillStyleLst>` +
  `<a:lnStyleLst>` +
  `<a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>` +
  `<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>` +
  `<a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>` +
  `</a:lnStyleLst>` +
  `<a:effectStyleLst>` +
  `<a:effectStyle><a:effectLst/></a:effectStyle>` +
  `<a:effectStyle><a:effectLst/></a:effectStyle>` +
  `<a:effectStyle><a:effectLst/></a:effectStyle>` +
  `</a:effectStyleLst>` +
  `<a:bgFillStyleLst>` +
  `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
  `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
  `<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>` +
  `</a:bgFillStyleLst>` +
  `</a:fmtScheme>` +
  `</a:themeElements>` +
  `</a:theme>`;

const GROUP_SHAPE_XML = `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
  `<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>`;

const SLIDE_MASTER_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL}" ` +
  `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
  `<p:cSld><p:spTree>${GROUP_SHAPE_XML}</p:spTree></p:cSld>` +
  `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" ` +
  `accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
  `<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>` +
  `</p:sldMaster>`;

const SLIDE_MASTER_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<Relationships xmlns="${PKG_REL}">` +
  `<Relationship Id="rId1" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
  `<Relationship Id="rId2" Type="${REL}/theme" Target="../theme/theme1.xml"/>` +
  `</Relationships>`;

const SLIDE_LAYOUT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL}" ` +
  `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1">` +
  `<p:cSld name="Blank"><p:spTree>${GROUP_SHAPE_XML}</p:spTree></p:cSld>` +
  `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>` +
  `</p:sldLayout>`;

const SLIDE_LAYOUT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<Relationships xmlns="${PKG_REL}">` +
  `<Relationship Id="rId1" Type="${REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/>` +
  `</Relationships>`;

function slideXml(page: ExportPage, picture: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }): string {
  const descr = hasTitle(page) ? ` descr="${xmlEscape(page.title)}"` : "";
  const x = toEmu(picture.x);
  const y = toEmu(picture.y);
  const cx = toEmu(picture.width);
  const cy = toEmu(picture.height);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL}" ` +
    `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">` +
    `<p:cSld><p:spTree>${GROUP_SHAPE_XML}` +
    `<p:pic>` +
    `<p:nvPicPr><p:cNvPr id="2" name="Picture 1"${descr}/>` +
    `<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>` +
    `<p:blipFill><a:blip r:embed="rId1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>` +
    `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
    `</p:pic>` +
    `</p:spTree></p:cSld>` +
    `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>` +
    `</p:sld>`;
}

function slideRelsXml(slideNumber: number): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="${PKG_REL}">` +
    `<Relationship Id="rId1" Type="${REL}/image" Target="../media/image${slideNumber}.jpeg"/>` +
    `<Relationship Id="rId2" Type="${REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>` +
    `</Relationships>`;
}

/** A PowerPoint presentation (.pptx) with one slide per entry. */
export function makePptx(pages: readonly ExportPage[], info: ExportInfo = {}): Uint8Array {
  validatePages(pages);

  // PowerPoint has one slide size for the whole file; the first page sets it.
  const slideWidthPt = pages[0]!.width;
  const slideHeightPt = pages[0]!.height;
  const slideWidthEmu = toEmu(slideWidthPt);
  const slideHeightEmu = toEmu(slideHeightPt);

  const files: { path: string; data: Uint8Array }[] = [];
  const addXml = (path: string, xml: string): void => { files.push({ path, data: UTF8_ENCODER.encode(xml) }); };

  addXml("[Content_Types].xml", contentTypesXml(pages.length));
  addXml("_rels/.rels", ROOT_RELS_XML);
  addXml("docProps/core.xml", corePropsXml(info));
  addXml("docProps/app.xml", appPropsXml(pages));
  addXml("ppt/presentation.xml", presentationXml(pages.length, slideWidthEmu, slideHeightEmu));
  addXml("ppt/_rels/presentation.xml.rels", presentationRelsXml(pages.length));
  addXml("ppt/presProps.xml", PRES_PROPS_XML);
  addXml("ppt/viewProps.xml", VIEW_PROPS_XML);
  addXml("ppt/tableStyles.xml", TABLE_STYLES_XML);
  addXml("ppt/theme/theme1.xml", THEME_XML);
  addXml("ppt/slideMasters/slideMaster1.xml", SLIDE_MASTER_XML);
  addXml("ppt/slideMasters/_rels/slideMaster1.xml.rels", SLIDE_MASTER_RELS_XML);
  addXml("ppt/slideLayouts/slideLayout1.xml", SLIDE_LAYOUT_XML);
  addXml("ppt/slideLayouts/_rels/slideLayout1.xml.rels", SLIDE_LAYOUT_RELS_XML);

  pages.forEach((page, index) => {
    const n = index + 1;
    const picture = slidePicture(page, slideWidthPt, slideHeightPt);
    addXml(`ppt/slides/slide${n}.xml`, slideXml(page, picture));
    addXml(`ppt/slides/_rels/slide${n}.xml.rels`, slideRelsXml(n));
    files.push({ path: `ppt/media/image${n}.jpeg`, data: page.image });
  });

  return makeZip(files);
}
