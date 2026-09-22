import { describe, expect, it } from "vitest";
import { matchesPointer } from "../src/pointer-bindings";
import { normalizeSettings } from "../src/settings";

describe("selection gesture preferences", () => {
  const mouse = { button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };
  it("keeps normal selection and middle panning, including extra modifiers", () => {
    expect(matchesPointer("alt+left", mouse)).toBe(false);
    expect(matchesPointer("alt+left", { ...mouse, altKey: true })).toBe(true);
    expect(matchesPointer("alt+left", { ...mouse, altKey: true, shiftKey: true })).toBe(false);
    expect(matchesPointer("alt+left", { ...mouse, altKey: true, button: 1 })).toBe(false);
    expect(matchesPointer("right", { ...mouse, button: 2 })).toBe(true);
    expect(matchesPointer("ctrl+shift+left", { ...mouse, metaKey: true, shiftKey: true })).toBe(true);
  });
  it("normalizes old and malformed preferences", () => {
    expect(normalizeSettings({ lassoBinding: "invalid", showLassoTool: false, showConnectorTool: false }))
      .toMatchObject({ lassoBinding: "alt+left", showLassoTool: false, showConnectorTool: false });
  });
});
