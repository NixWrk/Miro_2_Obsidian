import { describe, expect, it } from "vitest";

import {
  MIRO_CANVAS_SCHEMA_VERSION,
  type MiroCanvasMigration,
  migrateMiroCanvasMetadata,
  parseMiroCanvasMetadata,
  validateMiroCanvasMetadata,
} from "../src/metadata";

describe("miroCanvas metadata boundary", () => {
  it("distinguishes a native Canvas without metadata", () => {
    const result = parseMiroCanvasMetadata({ nodes: [], edges: [] });

    expect(result.status).toBe("absent");
    expect(result.metadata).toBeUndefined();
    expect(result.diagnostics).toEqual([]);
    expect(result.migrated).toBe(false);
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
