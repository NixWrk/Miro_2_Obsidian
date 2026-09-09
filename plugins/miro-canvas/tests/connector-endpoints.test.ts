import { describe, expect, it } from "vitest";

import {
  buildCanvasAnchorGeometry,
  updateConnectorEndpoint,
} from "../src/connector-endpoints";

function baseDocument(): Record<string, unknown> {
  return {
    nodes: [
      { id: "a", type: "text", x: 0, y: 0, width: 100, height: 80, text: "A" },
      { id: "b", type: "text", x: 200, y: 0, width: 100, height: 80, text: "B" },
      { id: "c", type: "text", x: 400, y: 0, width: 100, height: 80, text: "C" },
      { id: "image", type: "file", file: "assets/image.png", x: 0, y: 200, width: 200, height: 100 },
    ],
    edges: [
      { id: "e1", fromNode: "a", fromSide: "right", toNode: "b", toSide: "left", futureEdge: { keep: true } },
      { id: "e2", fromNode: "b", fromSide: "right", toNode: "c", toSide: "left" },
    ],
    miroSource: { board: "source", nested: { keep: true } },
    futureRoot: { keep: true },
    miroCanvas: {
      schemaVersion: 1,
      futureMetadata: { keep: true },
      localOverrides: {
        image: {
          imageCrop: { space: "relative", x: 0.25, y: 0, width: 0.5, height: 1 },
          futureImage: true,
        },
        e1: { futureOverride: { keep: true } },
      },
    },
  };
}

describe("connector endpoints", () => {
  it("builds bounded node/image geometry and straight edge polylines from explicit endpoints", () => {
    const document = baseDocument();
    const metadata = document.miroCanvas as Record<string, unknown>;
    const overrides = metadata.localOverrides as Record<string, Record<string, unknown>>;
    overrides.e2 = {
      connectorAnchors: {
        from: { type: "free", x: 310, y: 25 },
        to: { type: "node", nodeId: "c", u: 0, v: 0.25 },
      },
    };

    const geometry = buildCanvasAnchorGeometry(document);

    expect(geometry.nodes?.a).toEqual({ x: 0, y: 0, width: 100, height: 80 });
    expect(geometry.images?.image).toEqual({ x: 50, y: 200, width: 100, height: 100 });
    expect(geometry.edges?.e1?.points).toEqual([{ x: 100, y: 40 }, { x: 200, y: 40 }]);
    expect(geometry.edges?.e2?.points).toEqual([{ x: 310, y: 25 }, { x: 400, y: 20 }]);
  });

  it("uses null-prototype geometry maps and centers native endpoints with omitted sides", () => {
    const document = baseDocument();
    const nodes = document.nodes as Record<string, unknown>[];
    const edges = document.edges as Record<string, unknown>[];
    nodes[0] = { ...nodes[0], id: "toString" };
    edges[0] = { ...edges[0], fromNode: "toString" };
    delete edges[0].fromSide;
    delete edges[0].toSide;

    const geometry = buildCanvasAnchorGeometry(document);

    expect(Object.getPrototypeOf(geometry.nodes)).toBeNull();
    expect(Object.getPrototypeOf(geometry.images)).toBeNull();
    expect(Object.getPrototypeOf(geometry.edges)).toBeNull();
    expect(geometry.nodes?.toString).toEqual({ x: 0, y: 0, width: 100, height: 80 });
    expect(geometry.edges?.e1?.points).toEqual([{ x: 50, y: 40 }, { x: 250, y: 40 }]);
  });

  it("rotates node and connector anchor geometry around the native node center", () => {
    const document = baseDocument();
    document.miroSource = { items: [{ id: "a", type: "shape", geometry: { rotation: 90 }, data: { shape: "rectangle" } }] };
    const geometry = buildCanvasAnchorGeometry(document);
    expect(geometry.nodes?.a).toMatchObject({ rotation: 90, rotationCenterX: 50, rotationCenterY: 40 });
    expect(geometry.edges?.e1?.points?.[0]?.x).toBeCloseTo(50);
    expect(geometry.edges?.e1?.points?.[0]?.y).toBeCloseTo(90);
  });

  it("stores a node anchor, updates the native node/nearest side, and deep-copies source plus unknown metadata", () => {
    const original = baseDocument();
    const before = JSON.parse(JSON.stringify(original));
    const result = updateConnectorEndpoint(original, {
      edgeId: "e1",
      end: "from",
      anchor: { type: "node", nodeId: "c", u: 0.95, v: 0.5, futureAnchor: { keep: true } },
    });

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
    expect(original).toEqual(before);
    const next = result.document!;
    const edge = (next.edges as Record<string, unknown>[]).find((item) => item.id === "e1")!;
    expect(edge).toMatchObject({ fromNode: "c", fromSide: "right", toNode: "b", futureEdge: { keep: true } });
    expect(next.futureRoot).toEqual({ keep: true });
    expect((next.miroCanvas as Record<string, unknown>).futureMetadata).toEqual({ keep: true });
    expect((((next.miroCanvas as Record<string, unknown>).localOverrides as Record<string, Record<string, unknown>>).e1.connectorAnchors as Record<string, unknown>).from)
      .toEqual({ type: "node", nodeId: "c", u: 0.95, v: 0.5, futureAnchor: { keep: true } });
    expect(next.miroSource).toEqual(before.miroSource);
    expect(next.miroSource).not.toBe(original.miroSource);
    expect((next.miroSource as Record<string, unknown>).nested).not.toBe((original.miroSource as Record<string, unknown>).nested);
  });

  it("preserves unknown stored anchor payload while replacing node fields for free, edge, and image anchors", () => {
    const withStoredNode = (): Record<string, unknown> => {
      const document = baseDocument();
      const metadata = document.miroCanvas as Record<string, unknown>;
      const overrides = metadata.localOverrides as Record<string, Record<string, unknown>>;
      overrides.e1 = {
        ...overrides.e1,
        connectorAnchors: {
          from: {
            type: "node",
            nodeId: "a",
            u: 0.1,
            v: 0.2,
            futurePayload: { version: "old", nested: { keep: true } },
          },
        },
      };
      return document;
    };
    const storedFrom = (document: Record<string, unknown>): unknown =>
      ((((document.miroCanvas as Record<string, unknown>).localOverrides as Record<string, Record<string, unknown>>).e1.connectorAnchors as Record<string, unknown>).from);

    const freeDocument = withStoredNode();
    const freeInput = {
      edgeId: "e1",
      end: "from" as const,
      anchor: { type: "free" as const, x: 25, y: 35, futurePayload: { version: "new" } },
    };
    const freeInputBefore = JSON.parse(JSON.stringify(freeInput));
    const free = updateConnectorEndpoint(freeDocument, freeInput);
    expect(free.ok).toBe(true);
    expect(storedFrom(free.document!)).toEqual({ type: "free", x: 25, y: 35, futurePayload: { version: "new" } });
    expect(freeInput).toEqual(freeInputBefore);

    const edge = updateConnectorEndpoint(withStoredNode(), {
      edgeId: "e1",
      end: "from",
      anchor: { type: "edge", edgeId: "e2", t: 0.5 },
    });
    expect(edge.ok).toBe(true);
    expect(storedFrom(edge.document!)).toEqual({
      type: "edge",
      edgeId: "e2",
      t: 0.5,
      futurePayload: { version: "old", nested: { keep: true } },
    });

    const image = updateConnectorEndpoint(withStoredNode(), {
      edgeId: "e1",
      end: "from",
      anchor: { type: "image", nodeId: "image", u: 0.75, v: 0.4 },
    });
    expect(image.ok).toBe(true);
    expect(storedFrom(image.document!)).toEqual({
      type: "image",
      nodeId: "image",
      u: 0.75,
      v: 0.4,
      futurePayload: { version: "old", nested: { keep: true } },
    });
  });

  it("keeps a valid native fallback for free/edge anchors and diagnoses its approximation", () => {
    const free = updateConnectorEndpoint(baseDocument(), {
      edgeId: "e1",
      end: "from",
      anchor: { type: "free", x: 25, y: 35 },
    });
    expect(free.ok).toBe(true);
    expect(free.diagnostics.map((item) => item.code)).toEqual(["approximate-native-fallback"]);
    expect((free.document!.edges as Record<string, unknown>[])[0]).toMatchObject({ fromNode: "a", fromSide: "right" });

    const edge = updateConnectorEndpoint(baseDocument(), {
      edgeId: "e1",
      end: "from",
      anchor: { type: "edge", edgeId: "e2", t: 0.5 },
    });
    expect(edge.ok).toBe(true);
    expect(edge.diagnostics[0]?.code).toBe("approximate-native-fallback");
    expect((edge.document!.edges as Record<string, unknown>[])[0]).toMatchObject({ fromNode: "a", fromSide: "right" });
  });

  it("rejects missing targets, native self-links, and edge-anchor cycles", () => {
    expect(updateConnectorEndpoint(baseDocument(), {
      edgeId: "e1",
      end: "from",
      anchor: { type: "node", nodeId: "missing", u: 0, v: 0 },
    }).diagnostics[0]?.code).toBe("missing-reference");

    expect(updateConnectorEndpoint(baseDocument(), {
      edgeId: "e1",
      end: "from",
      anchor: { type: "node", nodeId: "b", u: 0, v: 0.5 },
    }).diagnostics[0]?.code).toBe("self-link");

    const cyclic = baseDocument();
    const overrides = ((cyclic.miroCanvas as Record<string, unknown>).localOverrides as Record<string, Record<string, unknown>>);
    overrides.e1 = { connectorAnchors: { to: { type: "edge", edgeId: "e2", t: 0.25 } } };
    expect(updateConnectorEndpoint(cyclic, {
      edgeId: "e2",
      end: "from",
      anchor: { type: "edge", edgeId: "e1", t: 0.75 },
    }).diagnostics[0]?.code).toBe("edge-anchor-cycle");
  });

  it("fails closed for malformed metadata, review mode, and locks", () => {
    const malformed = baseDocument();
    malformed.miroCanvas = { schemaVersion: 1, localOverrides: [] };
    expect(updateConnectorEndpoint(malformed, {
      edgeId: "e1", end: "from", anchor: { type: "free", x: 1, y: 2 },
    }).diagnostics[0]?.code).toBe("metadata-invalid");

    const review = baseDocument();
    (review.miroCanvas as Record<string, unknown>).settings = { reviewMode: true };
    expect(updateConnectorEndpoint(review, {
      edgeId: "e1", end: "from", anchor: { type: "free", x: 1, y: 2 },
    }).diagnostics[0]?.code).toBe("reconnect-blocked-review");

    const locked = baseDocument();
    const overrides = ((locked.miroCanvas as Record<string, unknown>).localOverrides as Record<string, Record<string, unknown>>);
    overrides.e1 = { ...overrides.e1, locked: true };
    expect(updateConnectorEndpoint(locked, {
      edgeId: "e1", end: "from", anchor: { type: "free", x: 1, y: 2 },
    }).diagnostics[0]?.code).toBe("reconnect-blocked-lock");

    const malformedAnchors = baseDocument();
    const malformedOverrides = ((malformedAnchors.miroCanvas as Record<string, unknown>).localOverrides as Record<string, Record<string, unknown>>);
    malformedOverrides.e1 = { ...malformedOverrides.e1, connectorAnchors: [] };
    expect(updateConnectorEndpoint(malformedAnchors, {
      edgeId: "e1", end: "from", anchor: { type: "free", x: 1, y: 2 },
    }).diagnostics[0]?.code).toBe("metadata-invalid");

    const lockedOldTarget = baseDocument();
    const lockedOldOverrides = ((lockedOldTarget.miroCanvas as Record<string, unknown>).localOverrides as Record<string, Record<string, unknown>>);
    lockedOldOverrides.a = { locked: true };
    expect(updateConnectorEndpoint(lockedOldTarget, {
      edgeId: "e1", end: "from", anchor: { type: "free", x: 1, y: 2 },
    }).diagnostics[0]?.code).toBe("reconnect-blocked-lock");
  });

  it("rejects unstable or colliding graph IDs without trimming", () => {
    const whitespace = baseDocument();
    (whitespace.nodes as Record<string, unknown>[])[0].id = " a";
    expect(updateConnectorEndpoint(whitespace, {
      edgeId: "e1", end: "from", anchor: { type: "free", x: 1, y: 2 },
    }).diagnostics[0]?.code).toBe("canvas-document-invalid");

    const collision = baseDocument();
    (collision.nodes as Record<string, unknown>[])[0].id = "e1";
    expect(updateConnectorEndpoint(collision, {
      edgeId: "e1", end: "from", anchor: { type: "free", x: 1, y: 2 },
    }).diagnostics[0]?.code).toBe("canvas-document-invalid");
  });

  it("rejects non-JSON document values, sparse/extended arrays, symbols, and excessive depth", () => {
    const rejectsCopy = (mutate: (document: Record<string, unknown>) => void): void => {
      const document = baseDocument();
      mutate(document);
      expect(updateConnectorEndpoint(document, {
        edgeId: "e1", end: "from", anchor: { type: "node", nodeId: "c", u: 1, v: 0.5 },
      }).diagnostics[0]?.code).toBe("document-copy-failed");
    };

    rejectsCopy((document) => { document.futureRoot = undefined; });
    rejectsCopy((document) => { document.futureRoot = Number.POSITIVE_INFINITY; });
    rejectsCopy((document) => { document.futureRoot = new Array(2); });
    rejectsCopy((document) => {
      const values = [1, 2] as unknown[] & Record<string, unknown>;
      values.extra = true;
      document.futureRoot = values;
    });
    rejectsCopy((document) => {
      const value: Record<string | symbol, unknown> = {};
      Object.defineProperty(value, Symbol("future"), { enumerable: true, value: true });
      document.futureRoot = value;
    });
    rejectsCopy((document) => {
      let nested: Record<string, unknown> = {};
      document.futureRoot = nested;
      for (let depth = 0; depth < 65; depth += 1) {
        const child: Record<string, unknown> = {};
        nested.child = child;
        nested = child;
      }
    });
  });
});

describe("measured node geometry", () => {
  const board = () => ({
    nodes: [
      { id: "group", type: "group", x: 0, y: 0, width: 280, height: 210 },
      { id: "b", type: "text", x: 600, y: 0, width: 100, height: 80 },
    ],
    edges: [{ id: "e", fromNode: "b", fromSide: "left", toNode: "group", toSide: "bottom" }],
  });

  it("aims at the box the host drew when a group is collapsed", () => {
    const open = buildCanvasAnchorGeometry(board());
    // The file cannot say a group is collapsed, so the document box wins alone.
    expect(open.edges!.e!.end).toEqual({ x: 140, y: 210 });
    const collapsed = buildCanvasAnchorGeometry(board(), { group: { width: 280, height: 32 } });
    expect(collapsed.edges!.e!.end).toEqual({ x: 140, y: 32 });
    expect(collapsed.nodes!.group).toMatchObject({ x: 0, y: 0, width: 280, height: 32 });
  });

  it("keeps the document box for anything unmeasured or malformed", () => {
    for (const measurement of [undefined, {}, { group: {} }, { group: { height: -5 } }, { group: { height: Number.NaN } }]) {
      const geometry = buildCanvasAnchorGeometry(board(), measurement as never);
      expect(geometry.nodes!.group).toMatchObject({ width: 280, height: 210 });
    }
  });

  it("lets a measured rotation override the projected one", () => {
    const geometry = buildCanvasAnchorGeometry(board(), { group: { rotation: 90 } });
    expect(geometry.nodes!.group).toMatchObject({ rotation: 90, rotationCenterX: 140, rotationCenterY: 105 });
  });
});

