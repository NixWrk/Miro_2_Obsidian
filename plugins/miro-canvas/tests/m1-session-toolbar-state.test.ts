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
});
