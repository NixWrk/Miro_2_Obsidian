import { describe, expect, it } from "vitest";

import {
  MIRO_CANVAS_SCHEMA_VERSION,
  type MiroCanvasMigration,
  migrateMiroCanvasMetadata,
  parseMiroCanvasMetadata,
  validateMiroCanvasMetadata,
} from "../src/metadata";
import { createMetadataWriter, type MetadataDocumentStore } from "../src/metadata-writer";

describe("miroCanvas metadata boundary", () => {
  it("distinguishes a native Canvas without metadata", () => {
    const result = parseMiroCanvasMetadata({ nodes: [], edges: [] });

    expect(result.status).toBe("absent");
    expect(result.metadata).toBeUndefined();
    expect(result.diagnostics).toEqual([]);
    expect(result.migrated).toBe(false);
  });

  it("keeps where comment pins were moved to, as anchors, and refuses anything else", () => {
    const places = {
      "local:c1": { type: "free", x: 10, y: -20 },
      "imported:m1": { type: "node", nodeId: "n1", u: 0.5, v: 0.25 },
    };
    expect(validateMiroCanvasMetadata({ schemaVersion: 1, commentPlaces: places }).valid).toBe(true);
    expect(validateMiroCanvasMetadata({ schemaVersion: 1, commentPlaces: { "local:c1": { type: "free", x: "far" } } }).valid).toBe(false);
    expect(validateMiroCanvasMetadata({ schemaVersion: 1, commentPlaces: [] }).valid).toBe(false);
  });

  it("accepts the minimal v1 metadata document", () => {
    const result = parseMiroCanvasMetadata({
      nodes: [],
      edges: [],
      miroCanvas: { schemaVersion: MIRO_CANVAS_SCHEMA_VERSION },
    });

    expect(result.status).toBe("valid");
    expect(result.metadata?.schemaVersion).toBe(1);
    expect(result.migrated).toBe(false);
    expect(result.diagnostics).toEqual([]);
  });

  it("validates M1 board settings and local appearance overrides", () => {
    const result = validateMiroCanvasMetadata({
      schemaVersion: 1,
      settings: {
        displayTheme: "dark",
        reviewMode: true,
        showAttachmentNames: false,
        minimapVisible: true,
        palette: ["#112233", "#AABBCCDD"],
        recentColors: ["#AABBCC"],
      },
      localOverrides: {
        "node-a": {
          typography: {
            fontFamily: "Inter",
            fontSize: 18,
            fontWeight: 600,
            fontStyle: "italic",
            textDecoration: "underline",
            textAlign: "center",
            lineHeight: 1.4,
            verticalAlign: "middle",
          },
          colors: {
            text: "#FFFFFF",
            fill: "#223344CC",
            border: "#445566",
          },
          locked: true,
          showAttachmentName: false,
          rotation: -45,
        },
      },
    });

    expect(result.status).toBe("valid");
    expect(result.diagnostics).toEqual([]);
    expect(result.metadata?.settings?.displayTheme).toBe("dark");
    expect(result.metadata?.localOverrides?.["node-a"]?.rotation).toBe(-45);
    expect(validateMiroCanvasMetadata({ schemaVersion: 1, localOverrides: { node: { rotation: Number.NaN } } }).status)
      .toBe("invalid");
  });

  it("accepts the canonical appearance palette, typography, and transparent colors", () => {
    const result = validateMiroCanvasMetadata({
      schemaVersion: 1,
      settings: {
        palette: [
          { id: "custom-blue", label: "Blue", color: "#112233", source: "custom" },
        ],
        recentColors: ["#112233"],
      },
      localOverrides: {
        "node-a": {
          typography: {
            fontFamily: "Inter",
            fontSize: 18,
            format: { bold: true, italic: false, underline: true, strike: false },
            alignment: "center",
            lineHeight: 1.35,
            verticalAlign: "center",
          },
          colors: { text: null, fill: "#11223380", border: null, edge: "#445566" },
        },
      },
    });

    expect(result.status).toBe("valid");
    expect(result.metadata?.settings?.palette).toEqual([
      { id: "custom-blue", label: "Blue", color: "#112233", source: "custom" },
    ]);
    expect(result.metadata?.localOverrides?.["node-a"]?.colors?.text).toBeNull();
  });

  it("accepts the canonical appearance contract at the writer boundary", () => {
    let document: Record<string, unknown> = { nodes: [], edges: [] };
    const store: MetadataDocumentStore = {
      readDocument: () => document,
      commitDocument: (next, expected) => {
        if (JSON.stringify(document) !== JSON.stringify(expected)) {
          return false;
        }
        document = { ...next };
        return true;
      },
    };
    const writer = createMetadataWriter(store);
    const result = writer.write("appearance", (draft) => {
      draft.settings = {
        displayTheme: "dark",
        palette: [{ id: "custom-blue", label: "Blue", color: "#112233", source: "custom" }],
        recentColors: ["#112233"],
      };
      draft.localOverrides = {
        node: {
          typography: {
            fontFamily: "Inter",
            fontSize: 18,
            format: { bold: true, italic: false, underline: false, strike: false },
            alignment: "center",
            lineHeight: 1.35,
            verticalAlign: "bottom",
          },
          colors: { text: null, fill: "#11223380", border: null, edge: "#445566" },
        },
      };
    });

    expect(result.status).toBe("applied");
    expect((document.miroCanvas as Record<string, unknown>).settings).toMatchObject({
      palette: [{ color: "#112233" }],
    });
    expect(
      ((document.miroCanvas as Record<string, unknown>).localOverrides as Record<string, Record<string, unknown>>)
        .node.colors,
    ).toMatchObject({ text: null, border: null });
  });

  it("rejects unsafe M1 appearance values and oversized color history", () => {
    const result = validateMiroCanvasMetadata({
      schemaVersion: 1,
      settings: {
        displayTheme: "sepia<script>",
        reviewMode: "yes",
        palette: ["red", "#001122", "#001122"],
        recentColors: Array.from({ length: 17 }, (_, index) => `#0000${index.toString(16).padStart(2, "0")}`),
      },
      localOverrides: {
        "node-a": {
          typography: {
            fontWeight: 950,
            fontStyle: "oblique",
            lineHeight: 0,
          },
          colors: { text: "var(--dangerous)" },
        },
      },
    });

    expect(result.status).toBe("invalid");
    const codes = result.diagnostics.map((diagnostic) => diagnostic.code);
    expect(codes).toContain("enum-value-invalid");
    expect(codes).toContain("boolean-expected");
    expect(codes).toContain("color-invalid");
    expect(codes).toContain("duplicate-color");
    expect(codes).toContain("color-limit-exceeded");
    expect(codes).toContain("font-weight-invalid");
    expect(codes).toContain("positive-number-expected");
  });

  it("validates the M0 metadata containers and reports malformed fields", () => {
    const result = validateMiroCanvasMetadata({
      schemaVersion: 1,
      transform: { scale: 0, offsetX: 0 },
      bindings: [],
      zOrder: ["node-a", 2],
      decks: [null],
      localOverrides: { "node-a": null },
      localComments: ["not-a-comment"],
      freeAnchors: { anchor: [0, 0] },
    });

    expect(result.status).toBe("invalid");
    expect(result.valid).toBe(false);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "positive-number-expected")).toBe(true);
    expect(
      result.diagnostics.some(
        (diagnostic) => diagnostic.code === "object-expected" && diagnostic.path === "miroCanvas.bindings",
      ),
    ).toBe(true);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "required-field-missing")).toBe(true);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "object-expected")).toBe(true);
  });

  it("distinguishes an unsupported schema version", () => {
    const result = parseMiroCanvasMetadata({
      miroCanvas: { schemaVersion: 2 },
    });

    expect(result.status).toBe("unsupported");
    expect(result.sourceVersion).toBe(2);
    expect(result.metadata).toBeUndefined();
    expect(result.diagnostics[0]?.code).toBe("schema-version-unsupported");
  });

  it("migrates a private copy and leaves miroSource and the input untouched", () => {
    const sourceSnapshot = {
      items: [{ id: "miro-item", data: { content: "immutable" } }],
    };
    const document = {
      nodes: [],
      edges: [],
      miroSource: sourceSnapshot,
      miroCanvas: {
        schemaVersion: 0,
        legacyComments: [{ id: "legacy-comment" }],
      },
    };
    const before = JSON.parse(JSON.stringify(document));
    let callbackInput: Record<string, unknown> | undefined;

    const result = parseMiroCanvasMetadata(document, {
      migrations: new Map([
        [
          0,
          (metadata) => {
            callbackInput = metadata;
            metadata.schemaVersion = 1;
            metadata.localComments = metadata.legacyComments;
          },
        ],
      ]),
    });

    expect(result.status).toBe("valid");
    expect(result.migrated).toBe(true);
    expect(callbackInput).not.toBe(document.miroCanvas);
    expect(document).toEqual(before);
    expect(document.miroSource).toBe(sourceSnapshot);
    expect(result.metadata?.schemaVersion).toBe(1);
  });

  it("never writes when migration is unavailable", () => {
    const metadata = { schemaVersion: 0, futureData: { untouched: true } };
    const before = JSON.parse(JSON.stringify(metadata));

    const result = migrateMiroCanvasMetadata(metadata);

    expect(result.status).toBe("unsupported");
    expect(result.migrated).toBe(false);
    expect(metadata).toEqual(before);
  });

  it("fails closed for a revoked proxy instead of throwing from Array.isArray", () => {
    const revoked = Proxy.revocable({ schemaVersion: MIRO_CANVAS_SCHEMA_VERSION }, {});
    revoked.revoke();

    let result: ReturnType<typeof validateMiroCanvasMetadata> | undefined;
    expect(() => {
      result = validateMiroCanvasMetadata(revoked.proxy);
    }).not.toThrow();
    expect(result?.status).toBe("invalid");
    expect(result?.diagnostics.some((diagnostic) => diagnostic.code === "metadata-object-expected")).toBe(true);
  });

  it("does not call an overridden or throwing array forEach property", () => {
    const decks = [{ id: "deck-1" }];
    Object.defineProperty(decks, "forEach", {
      configurable: true,
      enumerable: false,
      get: () => {
        throw new Error("array iteration must not be used");
      },
    });

    let result: ReturnType<typeof validateMiroCanvasMetadata> | undefined;
    expect(() => {
      result = validateMiroCanvasMetadata({
        schemaVersion: MIRO_CANVAS_SCHEMA_VERSION,
        decks,
      });
    }).not.toThrow();
    expect(result?.status).toBe("valid");
    expect(result?.metadata?.decks).toEqual([{ id: "deck-1" }]);
  });

  it("rejects cyclic and non-JSON v1 extensions without mutating the input", () => {
    const cyclicMetadata: Record<string, unknown> = {
      schemaVersion: MIRO_CANVAS_SCHEMA_VERSION,
      future: {},
    };
    (cyclicMetadata.future as Record<string, unknown>).self = cyclicMetadata.future;

    const cyclicResult = validateMiroCanvasMetadata(cyclicMetadata);

    expect(cyclicResult.status).toBe("invalid");
    expect(cyclicResult.metadata).toBeUndefined();
    expect(cyclicResult.diagnostics.some((diagnostic) => diagnostic.code === "metadata-copy-failed")).toBe(true);
    expect((cyclicMetadata.future as Record<string, unknown>).self).toBe(cyclicMetadata.future);

    const nonJsonResult = validateMiroCanvasMetadata({
      schemaVersion: MIRO_CANVAS_SCHEMA_VERSION,
      future: { unsupported: BigInt(1) },
    });

    expect(nonJsonResult.status).toBe("invalid");
    expect(nonJsonResult.metadata).toBeUndefined();
    expect(nonJsonResult.diagnostics.some((diagnostic) => diagnostic.code === "metadata-copy-failed")).toBe(true);
  });

  it("detaches valid v1 metadata while preserving internal shared references", () => {
    const shared = { futureValue: true };
    const metadata: Record<string, unknown> = {
      schemaVersion: MIRO_CANVAS_SCHEMA_VERSION,
      first: shared,
      second: shared,
    };

    const result = validateMiroCanvasMetadata(metadata);
    const first = result.metadata?.first;
    const second = result.metadata?.second;

    expect(result.status).toBe("valid");
    expect(result.metadata).not.toBe(metadata);
    expect(first).not.toBe(shared);
    expect(first).toBe(second);
  });

  it("does not resolve migrations inherited from an object registry prototype", () => {
    let inheritedCalled = false;
    const inheritedMigration: MiroCanvasMigration = (metadata) => {
      inheritedCalled = true;
      metadata.schemaVersion = MIRO_CANVAS_SCHEMA_VERSION;
    };
    const registry = Object.create({ 0: inheritedMigration }) as Record<number, MiroCanvasMigration>;

    const result = migrateMiroCanvasMetadata({ schemaVersion: 0 }, registry);

    expect(result.status).toBe("unsupported");
    expect(inheritedCalled).toBe(false);
    expect(result.diagnostics.some((diagnostic) => diagnostic.code === "migration-unavailable")).toBe(true);
  });
});
