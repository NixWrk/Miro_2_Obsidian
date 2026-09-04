import { describe, expect, it } from "vitest";

import {
  addAnchor,
  normalizeAnchor,
  removeAnchor,
  resolveAnchor,
  updateAnchor,
} from "../src/anchors";

describe("local Canvas anchors", () => {
  it("normalizes free, node/image, and edge-relative anchors", () => {
    expect(normalizeAnchor({ type: "free", x: -4, y: 12, future: { keep: true } })).toMatchObject({
      valid: true,
      anchor: { type: "free", x: -4, y: 12, future: { keep: true } },
    });
    expect(normalizeAnchor({ type: "node", nodeId: "node-1", u: 0.25, v: 0.75 })).toMatchObject({
      valid: true,
      anchor: { type: "node", nodeId: "node-1", u: 0.25, v: 0.75 },
    });
    expect(normalizeAnchor({ type: "image", targetId: "image-1", u: 0, v: 1 })).toMatchObject({
      valid: true,
      anchor: { type: "image", nodeId: "image-1", u: 0, v: 1 },
    });
    expect(normalizeAnchor({ type: "edge", edgeId: "edge-1", t: 0.5 })).toMatchObject({
      valid: true,
      anchor: { type: "edge", edgeId: "edge-1", t: 0.5 },
    });
    expect(normalizeAnchor({ type: "node", nodeId: "node-1", u: 1.1, v: 0.5 }).valid).toBe(false);
    expect(normalizeAnchor({ type: "edge", edgeId: "edge-1", t: Number.NaN }).valid).toBe(false);
  });

  it("resolves relative points and reports missing or invalid targets", () => {
    const geometry = {
      nodes: { node: { x: 10, y: 20, width: 100, height: 40 } },
      images: { image: { x: 0, y: 0, width: 200, height: 100 } },
      edges: { edge: { points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] } },
    };
    expect(resolveAnchor({ type: "free", x: -2, y: 5 }, geometry).point).toMatchObject({ x: -2, y: 5 });
    expect(resolveAnchor({ type: "node", nodeId: "node", u: 0.25, v: 0.5 }, geometry).point).toMatchObject({
      x: 35,
      y: 40,
    });
    expect(resolveAnchor({ type: "image", nodeId: "image", u: 0.5, v: 1 }, geometry).point).toMatchObject({
      x: 100,
      y: 100,
    });
    expect(resolveAnchor({ type: "edge", edgeId: "edge", t: 0.75 }, geometry).point).toMatchObject({
      x: 10,
      y: 5,
    });
    expect(resolveAnchor({ type: "node", nodeId: "missing", u: 0.5, v: 0.5 }, geometry).diagnostics[0]?.code)
      .toBe("missing-target");
    expect(resolveAnchor({ type: "edge", edgeId: "edge", t: 0.5 }, { edges: { edge: { start: { x: 0, y: Infinity }, end: { x: 1, y: 1 } } } }).diagnostics[0]?.code)
      .toBe("geometry-invalid");
  });

  it("mutates detached freeAnchors while preserving source and unknown metadata", () => {
    const source = { comments: [{ id: "miro-comment" }], keep: true };
    const original = {
      schemaVersion: 1,
      miroSource: source,
      future: { keep: true },
      freeAnchors: {
        old: { type: "free", x: 1, y: 2, futureAnchor: { keep: true } },
      },
    };
    const before = JSON.parse(JSON.stringify(original));
    const added = addAnchor(original, { type: "node", nodeId: "node", u: 0.1, v: 0.2, future: { keep: true } }, {
      idFactory: () => "new-anchor",
      now: () => "2026-01-01T00:00:00Z",
    });
    expect(added.ok).toBe(true);
    expect(original).toEqual(before);
    expect(added.metadata?.miroSource).toEqual(source);
    expect((added.metadata?.freeAnchors as Record<string, Record<string, unknown>>)["new-anchor"]).toMatchObject({
      createdAt: "2026-01-01T00:00:00Z",
      future: { keep: true },
    });

    const updated = updateAnchor(added.metadata, "new-anchor", { u: 0.9 }, { now: () => "2026-01-02T00:00:00Z" });
    expect(updated.ok).toBe(true);
    expect((updated.metadata?.freeAnchors as Record<string, Record<string, unknown>>)["new-anchor"])
      .toMatchObject({ u: 0.9, future: { keep: true } });
    const removed = removeAnchor(updated.metadata, "new-anchor");
    expect(removed.ok).toBe(true);
    expect(removed.metadata?.freeAnchors).toEqual({ old: { type: "free", x: 1, y: 2, futureAnchor: { keep: true } } });
  });
});
