import { describe, expect, it } from "vitest";

import { linkedFilePaths, planPaste, readCanvasClipboard, readClipboardRecord } from "../src/board-clipboard";

const CANVAS = {
  nodes: [
    { id: "a", type: "text", text: "", x: 0, y: 0, width: 200, height: 200 },
    { id: "b", type: "file", file: "Assets/photo.png", x: 300, y: 0, width: 400, height: 300 },
  ],
  edges: [
    { id: "e", fromNode: "a", toNode: "b", fromSide: "right", toSide: "left" },
    { id: "dangling", fromNode: "a", toNode: "elsewhere" },
  ],
  center: { x: 350, y: 150 },
};

describe("pasting a copy", () => {
  it("copies independent connectors together with their nodes using new anchor IDs",()=>{
    const connector={id:"c",from:{type:"node" as const,nodeId:"a",u:1,v:0.5},to:{type:"node" as const,nodeId:"b",u:0,v:0.5},route:"straight" as const,color:"#123456",width:2,startCap:"none",endCap:"arrow"};
    let n=0;const plan=planPaste({...CANVAS,connectors:[connector]},undefined,{offset:{x:40,y:40},newId:()=>`new${n++}`,sourceExists:()=>false});
    expect(plan.connectors?.[0]).toMatchObject({id:plan.ids.get("c"),from:{nodeId:plan.ids.get("a")},to:{nodeId:plan.ids.get("b")}});
    expect(connector.from.nodeId).toBe("a");
  });
  it("gives every piece a new id, moves it and keeps connectors joined", () => {
    let next = 0;
    const plan = planPaste(CANVAS, undefined, { offset: { x: 100, y: -50 }, newId: () => `n${next++}`, sourceExists: () => false });
    expect(plan.nodes.map((node) => [node.id, node.x, node.y])).toEqual([["n0", 100, -50], ["n1", 400, -50]]);
    // A file node still points at the same file: nothing is copied.
    expect(plan.nodes[1]).toMatchObject({ type: "file", file: "Assets/photo.png" });
    expect(plan.edges).toEqual([{ id: "n2", fromNode: "n0", toNode: "n1", fromSide: "right", toSide: "left" }]);
  });

  it("carries the plugin's record, following ids and places, and leaves a lock behind", () => {
    const record = {
      version: 1 as const,
      board: "Board.canvas",
      items: {
        a: { override: { item: { type: "sticky_note", color: "yellow" }, rotation: 12, locked: true } },
        b: { sourceId: "miro-image" },
        e: { override: { connector: { route: "straight", waypoints: [{ x: 10, y: 20 }] }, connectorAnchors: { from: { type: "node", nodeId: "a", u: 1, v: 0.5 }, to: { type: "free", x: 5, y: 6 } } } },
      },
    };
    let next = 0;
    const plan = planPaste(CANVAS, record, { offset: { x: 100, y: 100 }, newId: () => `n${next++}`, sourceExists: (id) => id === "miro-image" });
    expect(plan.overrides.n0).toEqual({ item: { type: "sticky_note", color: "yellow" }, rotation: 12 });
    expect(plan.overrides.n2).toEqual({
      connector: { route: "straight", waypoints: [{ x: 110, y: 120 }] },
      connectorAnchors: { from: { type: "node", nodeId: "n0", u: 1, v: 0.5 }, to: { type: "free", x: 105, y: 106 } },
    });
    // The Miro item is shown again, not copied.
    expect(plan.bindings).toEqual({ n1: { sourceId: "miro-image", role: "copy" } });
    const elsewhere = planPaste(CANVAS, record, { offset: { x: 0, y: 0 }, newId: () => `m${next++}`, sourceExists: () => false });
    expect(elsewhere.bindings).toEqual({});
  });

  it("reads only clipboards of its own shape", () => {
    expect(readCanvasClipboard(JSON.stringify(CANVAS))?.nodes).toHaveLength(2);
    expect(readCanvasClipboard("{\"nodes\":1}")).toBeUndefined();
    expect(readCanvasClipboard("not json")).toBeUndefined();
    expect(readClipboardRecord(JSON.stringify({ version: 1, board: "B", items: {} }))?.board).toBe("B");
    expect(readClipboardRecord(JSON.stringify({ version: 2, board: "B", items: {} }))).toBeUndefined();
  });
});

describe("files a clipboard names", () => {
  it("finds files copied in the explorer, a wikilink and an obsidian link", () => {
    expect(linkedFilePaths({ files: JSON.stringify({ operation: "copy", paths: ["Notes/a.md", "Assets/b.pdf"] }) })).toEqual(["Notes/a.md", "Assets/b.pdf"]);
    expect(linkedFilePaths({ text: "[[Notes/Plan#Goals|the plan]]" })).toEqual(["Notes/Plan"]);
    expect(linkedFilePaths({ text: "![[Assets/photo.png]]" })).toEqual(["Assets/photo.png"]);
    expect(linkedFilePaths({ text: "obsidian://open?vault=V&file=Notes%2FPlan.md" })).toEqual(["Notes/Plan.md"]);
    expect(linkedFilePaths({ text: "just words" })).toEqual([]);
    expect(linkedFilePaths({ text: "[[a]]\n[[b]]" })).toEqual([]);
  });
});
