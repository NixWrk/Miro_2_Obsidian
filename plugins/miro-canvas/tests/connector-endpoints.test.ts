import { describe, expect, it } from "vitest";

import {
  boundaryAnchorOnRect,
  buildCanvasAnchorGeometry,
  facingSide,
  facingSideOfRect,
  insideRect,
  nativeFreeEnd,
  sideAnchorOnOutline,
  nativeAnchorEnd,
  nativeEdgeEnd,
  nodeBoundaryAnchor,
  nodeBoundaryAnchorAtSide,
  sideDirection,
  snapToStandardPoint,
  updateConnectorEndpoint,
} from "../src/connector-endpoints";
import { shapeOutline } from "../src/shape-geometry";

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
  it("projects arbitrary pointer positions onto a node silhouette", () => {
    const document = baseDocument();
    expect(nodeBoundaryAnchor(document, "a", { x: 150, y: 20 })).toEqual({
      type: "node", nodeId: "a", u: 1, v: 0.25,
    });
    (document.miroCanvas as Record<string, unknown>).localOverrides = {
      a: { shape: { kind: "triangle", fallback: "text" } },
    };
    const triangle = nodeBoundaryAnchor(document, "a", { x: 150, y: 20 });
    expect(triangle?.type).toBe("node");
		const point = triangle as { u: number; v: number };
		expect(point.u).toBeCloseTo(0.5 + point.v / 2, 6);
		expect(point.v).toBeGreaterThan(0.25);
		expect(point.v).toBeLessThan(1);
  });

  it("projects an off-centre dragged handle onto the selected shape silhouette", () => {
    const document = baseDocument();
    expect(nodeBoundaryAnchorAtSide(document, "a", "left", 0.25)).toEqual({
      type: "node", nodeId: "a", u: 0, v: 0.25,
    });
    (document.miroCanvas as Record<string, unknown>).localOverrides = {
      a: { shape: { kind: "triangle", fallback: "text" } },
    };
    const triangle = nodeBoundaryAnchorAtSide(document, "a", "right", 0.25);
    expect(triangle?.type).toBe("node");
    expect((triangle as { u: number }).u).toBeLessThan(1);
    expect((triangle as { v: number }).v).toBeGreaterThan(0.25);
  });
  it("builds bounded node/image geometry and edge routes from explicit endpoints", () => {
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
    // A local edge curves the way Obsidian draws it; facing sides at one height stay level.
    const e1 = geometry.edges?.e1?.points ?? [];
    expect(e1[0]).toEqual({ x: 100, y: 40 });
    expect(e1[e1.length - 1]).toEqual({ x: 200, y: 40 });
    expect(e1.every((point) => Math.abs(point.y - 40) < 1e-9)).toBe(true);
    expect(geometry.edges?.e1?.path).toBe("M 100 40 C 170 40 130 40 200 40");
    const e2 = geometry.edges?.e2?.points ?? [];
    expect(e2[0]).toEqual({ x: 310, y: 25 });
    expect(e2[e2.length - 1]).toEqual({ x: 400, y: 20 });
    // It arrives at C's left side from the left.
    expect(geometry.edges?.e2?.path).toMatch(/^M 310 25 C .* 330 20 400 20$/u);
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
    const points = geometry.edges?.e1?.points ?? [];
    expect(points[0]).toEqual({ x: 50, y: 40 });
    expect(points[points.length - 1]).toEqual({ x: 250, y: 40 });
    // Centred ends face each other, so the curve runs along the line between them.
    expect(points.every((point) => Math.abs(point.y - 40) < 1e-9)).toBe(true);
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

describe("connectors on a rotated node", () => {
  const board = (rotation: number) => ({
    nodes: [
      { id: "a", type: "text", x: 0, y: 0, width: 100, height: 80 },
      { id: "b", type: "text", x: 400, y: 0, width: 100, height: 80 },
    ],
    edges: [{ id: "e", fromNode: "b", fromSide: "left", toNode: "a", toSide: "right" }],
    miroCanvas: { schemaVersion: 1, settings: {}, localOverrides: { a: { rotation } } },
  });

  it("ends on the border the node actually has after a local rotation", () => {
    expect(buildCanvasAnchorGeometry(board(0)).edges!.e!.end).toEqual({ x: 100, y: 40 });
    // The right-hand side turns a quarter turn about the node centre.
    const turned = buildCanvasAnchorGeometry(board(90)).edges!.e!.end!;
    expect(turned.x).toBeCloseTo(50);
    expect(turned.y).toBeCloseTo(90);
  });

  it("turns the node rect with it so anchors follow too", () => {
    expect(buildCanvasAnchorGeometry(board(-18)).nodes!.a).toMatchObject({
      rotation: -18, rotationCenterX: 50, rotationCenterY: 40,
    });
  });
});

describe("connectors meet the drawn shape", () => {
  const board = (shape: string, rotation = 0) => ({
    nodes: [
      { id: "a", type: "text", x: 0, y: 0, width: 100, height: 100 },
      { id: "b", type: "text", x: 400, y: 0, width: 100, height: 100 },
    ],
    edges: [{ id: "e", fromNode: "b", fromSide: "left", toNode: "a", toSide: "right" }],
    miroCanvas: {
      schemaVersion: 1, settings: {},
      localOverrides: { a: { shape: { kind: shape, fallback: "text" }, rotation } },
    },
  });

  it("ends on a triangle's slanted edge instead of in the empty corner", () => {
    const end = buildCanvasAnchorGeometry(board("triangle")).edges!.e!.end!;
    // The middle of the bounding box's right side is outside the triangle.
    expect(end.x).toBeLessThan(100);
    expect(end.x).toBeCloseTo(75, 0);
    expect(end.y).toBeCloseTo(50, 0);
  });

  it("ends on a circle's arc", () => {
    const end = buildCanvasAnchorGeometry(board("circle")).edges!.e!.end!;
    expect(Math.hypot(end.x - 50, end.y - 50)).toBeCloseTo(50, 0);
  });

  it("keeps a rectangle's own edge", () => {
    expect(buildCanvasAnchorGeometry(board("rectangle")).edges!.e!.end).toEqual({ x: 100, y: 50 });
  });

  it("turns the contour point with the node", () => {
    const end = buildCanvasAnchorGeometry(board("triangle", 90)).edges!.e!.end!;
    // The point found on the slanted edge, then rotated a quarter turn.
    expect(end.x).toBeCloseTo(50, 0);
    expect(end.y).toBeCloseTo(75, 0);
  });
});

describe("native-looking connector ends", () => {
  const rect = { x: 0, y: 0, width: 200, height: 100 };

  it("leaves a side along its outward normal and turns the host's arrowhead to match", () => {
    const right = nativeEdgeEnd(rect, "right")!;
    expect(right.point).toEqual({ x: 200, y: 50 });
    expect(right.normal).toEqual({ x: 1, y: 0 });
    // Native Canvas uses 270 for a right side, 0 for a bottom one.
    expect(right.arrowAngle).toBe(270);
    expect(nativeEdgeEnd(rect, "bottom")!.arrowAngle).toBe(0);
    const turned = nativeEdgeEnd({ ...rect, rotation: 90 }, "right")!;
    expect(turned.point.x).toBeCloseTo(100);
    expect(turned.point.y).toBeCloseTo(150);
    expect(turned.arrowAngle).toBe(0);
  });

  it("leaves an arbitrary perimeter point along the contour there", () => {
    const top = nativeAnchorEnd(rect, 0.25, 0)!;
    expect(top.point).toEqual({ x: 50, y: 0 });
    expect(top.normal.x).toBeCloseTo(0);
    expect(top.normal.y).toBeCloseTo(-1);
    expect(top.arrowAngle).toBe(180);
    // A corner leaves diagonally rather than along whichever side came first.
    const corner = nativeAnchorEnd(rect, 1, 1)!;
    expect(corner.normal.x).toBeCloseTo(Math.SQRT1_2);
    expect(corner.normal.y).toBeCloseTo(Math.SQRT1_2);
    // A triangle's flank faces up and out, not straight sideways.
    const flank = nativeAnchorEnd({ x: 0, y: 0, width: 100, height: 100 }, 0.75, 0.5, shapeOutline("triangle"))!;
    expect(flank.normal.x).toBeGreaterThan(0.8);
    expect(flank.normal.y).toBeLessThan(-0.3);
  });

  it("snaps a dropped end onto a nearby standard point only", () => {
    const near = snapToStandardPoint({ type: "node", nodeId: "a", u: 0.54, v: 0 }, rect, undefined, 10);
    expect(near).toEqual({ type: "node", nodeId: "a", u: 0.5, v: 0 });
    const far = snapToStandardPoint({ type: "node", nodeId: "a", u: 0.8, v: 0 }, rect, undefined, 10);
    expect(far).toEqual({ type: "node", nodeId: "a", u: 0.8, v: 0 });
  });

  it("finds the side facing a point in the node's own turned frame", () => {
    const document = baseDocument();
    expect(facingSide(document, "b", { x: 0, y: 40 })).toBe("left");
    expect(facingSide(document, "b", { x: 250, y: -500 })).toBe("top");
    const turned = { ...document, miroCanvas: { schemaVersion: 1, localOverrides: { b: { rotation: 180 } } } };
    // Upside down, the side that looks left is the node's own right side.
    expect(facingSide(turned, "b", { x: 0, y: 40 })).toBe("right");
  });

  it("points a side the way it faces once the node is turned", () => {
    expect(sideDirection("left", 0)).toEqual({ x: -1, y: 0 });
    const upsideDown = sideDirection("left", 180);
    expect(upsideDown.x).toBeCloseTo(1);
    expect(upsideDown.y).toBeCloseTo(0);
  });
});

describe("placing a connector end on a known box", () => {
  const rect = { x: 100, y: 100, width: 200, height: 100 };

  it("finds the closest outline point and whether a point is inside", () => {
    expect(boundaryAnchorOnRect("n", rect, undefined, { x: 250, y: 90 })).toEqual({ type: "node", nodeId: "n", u: 0.75, v: 0 });
    expect(insideRect(rect, { x: 150, y: 150 })).toBe(true);
    expect(insideRect(rect, { x: 90, y: 150 })).toBe(false);
    // A box turned a quarter reaches 100 above and below its centre.
    expect(insideRect({ ...rect, rotation: 90 }, { x: 200, y: 60 })).toBe(true);
    expect(insideRect({ ...rect, rotation: 90 }, { x: 110, y: 150 })).toBe(false);
  });

  it("puts a side's point on the outline and finds the side facing a point", () => {
    expect(sideAnchorOnOutline("n", shapeOutline("triangle"), "right", 0.5)).toEqual({ type: "node", nodeId: "n", u: 0.75, v: 0.5 });
    expect(sideAnchorOnOutline("n", undefined, "top", 2)).toBeUndefined();
    expect(facingSideOfRect(rect, { x: 200, y: 400 })).toBe("bottom");
  });

  it("points a free end's arrowhead along the line arriving at it", () => {
    const free = nativeFreeEnd({ x: 0, y: 0 }, { x: 0, y: -50 })!;
    // The line arrives from above, so the head points down with its base up.
    expect(free.normal).toEqual({ x: 0, y: -1 });
    expect(free.arrowAngle).toBe(180);
    expect(nativeFreeEnd({ x: Number.NaN, y: 0 }, undefined)).toBeUndefined();
  });
});
