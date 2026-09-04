import { describe, expect, it } from "vitest";

import {
  collectCanvasElementIds,
  readCanvasElementFile,
  readCanvasElementId,
  readCanvasElementType,
} from "../src/canvas-elements";

describe("Canvas element views", () => {
  it("reads direct and nested runtime records", () => {
    expect(readCanvasElementId({ id: "node-a" })).toBe("node-a");
    expect(readCanvasElementId({ getData: () => ({ id: "node-b" }) })).toBe("node-b");
    expect(readCanvasElementType({ data: { type: "file", file: "Docs/a.pdf" } })).toBe("file");
    expect(readCanvasElementFile({ data: { type: "file", file: "Docs/a.pdf" } })).toBe("Docs/a.pdf");
  });

  it("collects unique IDs from arrays, sets, and maps", () => {
    expect(collectCanvasElementIds([{ id: "a" }, { data: { id: "b" } }, { id: "a" }])).toEqual(["a", "b"]);
    expect(collectCanvasElementIds(new Set([{ id: "a" }, { id: "b" }]))).toEqual(["a", "b"]);
    expect(collectCanvasElementIds(new Map([["a", { id: "a" }], ["b", { id: "b" }]]))).toEqual(["a", "b"]);
  });

  it("rejects unsafe IDs and fails closed for hostile objects", () => {
    expect(readCanvasElementId({ id: " bad " })).toBeUndefined();
    expect(readCanvasElementId({ id: "bad\u0000id" })).toBeUndefined();

    const revoked = Proxy.revocable({ id: "hidden" }, {});
    revoked.revoke();
    expect(readCanvasElementId(revoked.proxy)).toBeUndefined();
    expect(collectCanvasElementIds(revoked.proxy)).toEqual([]);

    const throwing = Object.defineProperty({}, "data", {
      get: () => {
        throw new Error("blocked");
      },
    });
    expect(readCanvasElementId(throwing)).toBeUndefined();
  });
});
