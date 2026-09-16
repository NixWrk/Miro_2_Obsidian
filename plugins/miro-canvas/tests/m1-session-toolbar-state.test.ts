import { describe, expect, it } from "vitest";

import { resolveSelectionToolbarPresentation } from "../src/m1-session";

describe("effective selection toolbar presentation", () => {
  it("shows imported Miro shape, typography, colors, and border before any local edit", () => {
    const presentation = resolveSelectionToolbarPresentation({
      miroSource: { items: [{
        id: "shape", type: "shape", subtype: "star",
        style: {
          fontFamily: "Open Sans", fontSize: 22, fontWeight: 700, fontStyle: "italic",
          textAlign: "center", verticalAlign: "middle", lineHeight: 1.4,
          color: "#112233", fillColor: "#ffeeaa", borderColor: "#445566",
          borderWidth: 4, borderStyle: "dashed",
        },
      }] },
    }, "shape");

    expect(presentation.typography).toMatchObject({
      fontFamily: "Open Sans", fontSize: 22, alignment: "center", verticalAlign: "center",
      lineHeight: 1.4, format: { bold: true, italic: true },
    });
    expect(presentation.colors).toMatchObject({ text: "#112233", fill: "#ffeeaa", border: "#445566" });
    expect(presentation.style).toMatchObject({ shape: "star", borderWidth: 4, borderStyle: "dashed" });
  });

  it("shows imported connector routing and both Miro caps before any local edit", () => {
    const presentation = resolveSelectionToolbarPresentation({
      miroSource: { connectors: [{
        id: "edge", type: "connector", shape: "elbowed",
        style: {
          strokeColor: "#123456", strokeWidth: 5, strokeStyle: "dotted",
          startStrokeCap: "filled_diamond", endStrokeCap: "erd_many",
        },
      }] },
    }, "edge");

    expect(presentation.colors).toMatchObject({ edge: "#123456" });
    expect(presentation.style.connector).toEqual({
      route: "elbowed", strokeStyle: "dotted", startCap: "filled_diamond",
      endCap: "erd_many", width: 5, color: "#123456",
    });
  });

  it("shows a plain Canvas edge with the ends Obsidian draws for it", () => {
    const document = {
      nodes: [{ id: "a", type: "text", text: "", x: 0, y: 0, width: 10, height: 10 },
        { id: "b", type: "text", text: "", x: 50, y: 0, width: 10, height: 10 }],
      edges: [
        { id: "plain", fromNode: "a", toNode: "b" },
        { id: "both", fromNode: "a", toNode: "b", fromEnd: "arrow", toEnd: "arrow" },
        { id: "bare", fromNode: "a", toNode: "b", toEnd: "none" },
      ],
    };
    expect(resolveSelectionToolbarPresentation(document, "plain").style.connector).toMatchObject({ startCap: "none", endCap: "arrow" });
    expect(resolveSelectionToolbarPresentation(document, "both").style.connector).toMatchObject({ startCap: "arrow", endCap: "arrow" });
    expect(resolveSelectionToolbarPresentation(document, "bare").style.connector).toMatchObject({ startCap: "none", endCap: "none" });
    expect(resolveSelectionToolbarPresentation(document, "a").style.connector).toBeUndefined();
  });
});
