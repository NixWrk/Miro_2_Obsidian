import { describe, expect, it } from "vitest";

import {
  APPEARANCE_ACTIONS,
  DEFAULT_FONT_SIZE,
  DEFAULT_PALETTE,
  DEFAULT_TYPOGRAPHY,
  MAX_RECENT_COLORS,
  appearanceReducer,
  createDefaultAppearanceState,
  normalizeColor,
  normalizeDisplayTheme,
  normalizeFontFamily,
  normalizeFontSize,
  normalizePalette,
  normalizeRecentColors,
  normalizeAppearanceState,
  normalizeTypography,
  mergeAppearanceMetadata,
  resolveDisplayTheme,
  toAppearanceMetadata,
  validateAppearanceState,
  validateColor,
} from "../src/appearance";

describe("appearance core", () => {
  it("normalizes display themes and resolves system without touching the model", () => {
    expect(normalizeDisplayTheme("dark")).toBe("dark");
    expect(normalizeDisplayTheme("unknown")).toBe("system");
    expect(resolveDisplayTheme("system", "dark")).toBe("dark");
    expect(resolveDisplayTheme("system", "light")).toBe("light");
    expect(resolveDisplayTheme("dark", "light")).toBe("dark");

    const state = createDefaultAppearanceState();
    expect(state.settings.displayTheme).toBe("system");
    expect(state.settings.palette.length).toBe(DEFAULT_PALETTE.length);
    // Miro's own colours, Obsidian's theme colours and the six presets native
    // Canvas offers are all reachable without opening the picker.
    for (const id of ["miro-red", "obsidian-blue", "canvas-purple"]) {
      expect(DEFAULT_PALETTE.some((entry) => entry.id === id)).toBe(true);
    }
    expect(new Set(DEFAULT_PALETTE.map((entry) => entry.color)).size).toBe(DEFAULT_PALETTE.length);
    expect(state.settings.recentColors).toEqual([]);
    expect(Object.isFrozen(state)).toBe(true);
  });

  it("normalizes typography while rejecting CSS injection and invalid sizes", () => {
    expect(normalizeFontFamily("  Inter, system-ui  ")).toBe("Inter, system-ui");
    expect(normalizeFontFamily("Inter; color: red")).toBe("Inter");
    expect(normalizeFontFamily("url(https://attacker.invalid/font.woff2)")).toBe("Inter");
    expect(normalizeFontSize(NaN)).toBe(DEFAULT_FONT_SIZE);
    expect(normalizeFontSize(Infinity)).toBe(DEFAULT_FONT_SIZE);
    expect(normalizeFontSize(-1)).toBe(DEFAULT_FONT_SIZE);
    expect(normalizeFontSize(18.125)).toBe(18.13);

    const typography = normalizeTypography({
      fontFamily: "Noto Sans",
      fontSize: 21,
      format: { bold: true, italic: true, underline: false, strike: true },
      alignment: "centre",
    });
    expect(typography).toEqual({
      fontFamily: "Noto Sans",
      fontSize: 21,
      format: { bold: true, italic: true, underline: false, strike: true },
      alignment: "center",
      lineHeight: 1.2,
      verticalAlign: "top",
    });
    expect(DEFAULT_TYPOGRAPHY.format.bold).toBe(false);
  });

  it("accepts only safe hex colors and represents clear as transparent", () => {
    expect(normalizeColor("#ABC")).toBe("#aabbcc");
    expect(normalizeColor("#ABCD")).toBe("#aabbccdd");
    expect(normalizeColor("#AABBCCDD")).toBe("#aabbccdd");
    expect(normalizeColor("transparent")).toBeNull();
    expect(normalizeColor("#fff; background:url(https://attacker.invalid)", "#123456")).toBe("#123456");
    expect(validateColor("#123456").valid).toBe(true);
    expect(validateColor("rgb(1, 2, 3)").valid).toBe(false);
    expect(validateColor("#123456; color: red").diagnostics[0]?.code).toBe("color-invalid");
  });

  it("deduplicates an expanded palette and recent colors deterministically", () => {
    const palette = normalizePalette([
      { id: "primary", label: "Primary", color: "#ABC", source: "custom" },
      { id: "duplicate", label: "Duplicate", color: "#aabbcc", source: "custom" },
      { id: "unsafe", label: "<script>alert(1)</script>", color: "#123456", source: "custom" },
      { id: "bad", label: "Bad", color: "var(--evil)", source: "custom" },
    ]);
    expect(palette).toEqual([
      { id: "primary", label: "Primary", color: "#aabbcc", source: "custom" },
      { id: "unsafe", label: "Color 3", color: "#123456", source: "custom" },
    ]);

    const colors = normalizeRecentColors([
      "#ABC",
      "#aabbcc",
      "transparent",
      "#123456",
      "rgb(1, 2, 3)",
    ]);
    expect(colors).toEqual(["#aabbcc", "#123456"]);
    expect(normalizeRecentColors(Array.from({ length: 30 }, (_, index) => `#${index.toString(16).padStart(6, "0")}`))).toHaveLength(MAX_RECENT_COLORS);
  });

  it("applies node typography and colors immutably and records recent colors", () => {
    const initial = createDefaultAppearanceState();
    const withTypography = appearanceReducer(initial, {
      type: APPEARANCE_ACTIONS.setTypography,
      nodeId: "node-1",
      typography: { fontFamily: "Noto Sans", fontSize: 20, alignment: "right" },
    });
    const withColor = appearanceReducer(withTypography, {
      type: APPEARANCE_ACTIONS.setColor,
      nodeId: "node-1",
      slot: "fill",
      color: "#ABC",
    });

    expect(initial.localOverrides).toEqual({});
    expect(withTypography.localOverrides["node-1"]?.typography).toMatchObject({
      fontFamily: "Noto Sans",
      fontSize: 20,
      alignment: "right",
    });
    expect(withColor.localOverrides["node-1"]?.colors?.fill).toBe("#aabbcc");
    expect(withColor.settings.recentColors[0]).toBe("#aabbcc");
    expect(withColor).not.toBe(withTypography);
    expect(withTypography).not.toBe(initial);
  });

  it("fails closed for invalid actions and prototype-polluting node IDs", () => {
    const initial = createDefaultAppearanceState();
    const invalidSize = appearanceReducer(initial, {
      type: APPEARANCE_ACTIONS.setFontSize,
      nodeId: "node-1",
      fontSize: Number.POSITIVE_INFINITY,
    });
    expect(invalidSize.localOverrides).toEqual({});

    const hostile = appearanceReducer(initial, {
      type: APPEARANCE_ACTIONS.setColor,
      nodeId: "__proto__",
      slot: "fill",
      color: "#ffffff",
    });
    expect(hostile.localOverrides).toEqual({});
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();

    const ownProto = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(ownProto, "__proto__", {
      enumerable: true,
      value: { polluted: true },
    });
    expect(() => normalizePalette(ownProto)).not.toThrow();
  });

  it("validates the payload boundary and emits an owned metadata subset", () => {
    const invalid = validateAppearanceState({
      settings: {
        displayTheme: "neon",
        palette: [{ color: "url(javascript:alert(1))" }],
        recentColors: ["rgb(1, 2, 3)"],
      },
      localOverrides: {
        node: {
          typography: { fontSize: 0 },
          colors: { text: "#fff", edge: "red" },
        },
      },
    });
    expect(invalid.valid).toBe(false);
    expect(invalid.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(expect.arrayContaining([
      "theme-invalid",
      "palette-color-invalid",
      "color-invalid",
      "font-size-invalid",
    ]));

    const state = appearanceReducer(createDefaultAppearanceState(), {
      type: APPEARANCE_ACTIONS.setFontSize,
      nodeId: "node-2",
      fontSize: 18,
    });
    const payload = toAppearanceMetadata(state);
    expect(payload).toMatchObject({
      settings: { displayTheme: "system" },
      localOverrides: { "node-2": { typography: { fontSize: 18 } } },
    });
    expect(payload).not.toBe(state);
    expect(Object.isFrozen(payload)).toBe(true);
  });

  it("does not throw when an array proxy has been revoked", () => {
    const revoked = Proxy.revocable([{ color: "#123456" }], {});
    revoked.revoke();
    expect(() => normalizePalette(revoked.proxy)).not.toThrow();
    expect(() => appearanceReducer(createDefaultAppearanceState(), {
      type: APPEARANCE_ACTIONS.addRecentColor,
      color: "#123456",
    })).not.toThrow();
  });

  it("merges only owned fields and preserves unknown M2 data and miroSource", () => {
    const source = { board: "immutable", items: [{ id: "miro-1" }] };
    const original = {
      schemaVersion: 1,
      miroSource: source,
      settings: {
        displayTheme: "dark",
        palette: [{ id: "old", label: "Old", color: "#112233", source: "custom" }],
        recentColors: ["#112233"],
        futureSetting: { keep: true },
      },
      localOverrides: {
        node: {
          typography: {
            fontFamily: "Inter",
            fontSize: 18,
            format: { bold: false, italic: false, underline: false, strike: false },
            alignment: "left",
            futureTypography: { keep: true },
          },
          colors: { text: "#112233", futureColor: { keep: true } },
          locked: true,
          futureOverride: { keep: true },
        },
      },
      m2: { keep: true },
    };
    const before = JSON.parse(JSON.stringify(original));
    const state = appearanceReducer(normalizeAppearanceState(original), {
      type: APPEARANCE_ACTIONS.setFontSize,
      nodeId: "node",
      fontSize: 24,
    });
    const merged = mergeAppearanceMetadata(original, state);

    expect(original).toEqual(before);
    expect(merged.miroSource).toEqual(source);
    expect(merged.m2).toEqual({ keep: true });
    expect((merged.settings as Record<string, unknown>).futureSetting).toEqual({ keep: true });
    const node = (merged.localOverrides as Record<string, Record<string, unknown>>).node;
    expect(node.futureOverride).toEqual({ keep: true });
    expect((node.typography as Record<string, unknown>).futureTypography).toEqual({ keep: true });
    expect((node.typography as Record<string, unknown>).fontSize).toBe(24);
    expect((node.colors as Record<string, unknown>).futureColor).toEqual({ keep: true });
    expect(node.locked).toBe(true);
  });

  it("rejects malformed reducer payloads and handles complete typography controls", () => {
    const initial = createDefaultAppearanceState();
    const invalid = appearanceReducer(initial, {
      type: APPEARANCE_ACTIONS.setTypography,
      nodeId: "node",
      typography: { lineHeight: 0, verticalAlign: "sideways" },
    });
    expect(invalid.localOverrides).toEqual({});

    const next = appearanceReducer(initial, {
      type: APPEARANCE_ACTIONS.setTypography,
      nodeId: "node",
      typography: {
        fontFamily: "Noto Sans",
        fontSize: 20,
        format: { bold: true, italic: true, underline: false, strike: true },
        alignment: "right",
        lineHeight: 1.5,
        verticalAlign: "bottom",
      },
    });
    expect(next.localOverrides.node?.typography).toMatchObject({
      fontFamily: "Noto Sans",
      fontSize: 20,
      alignment: "right",
      lineHeight: 1.5,
      verticalAlign: "bottom",
    });
  });

  it("resets owned overrides without erasing lock, attachment, or future fields", () => {
    const initial = normalizeAppearanceState({
      settings: { palette: [], recentColors: [] },
      localOverrides: {
        node: {
          typography: { fontFamily: "Inter", fontSize: 18 },
          colors: { text: "#112233" },
          locked: true,
          showAttachmentName: false,
          m2: { keep: true },
        },
      },
    });
    const withoutTypography = appearanceReducer(initial, {
      type: APPEARANCE_ACTIONS.resetTypography,
      nodeId: "node",
    });
    expect(withoutTypography.localOverrides.node).toMatchObject({
      colors: { text: "#112233" },
      locked: true,
      showAttachmentName: false,
      m2: { keep: true },
    });
    expect(withoutTypography.localOverrides.node?.typography).toBeUndefined();

    const withoutColors = appearanceReducer(withoutTypography, {
      type: APPEARANCE_ACTIONS.resetColors,
      nodeId: "node",
    });
    expect(withoutColors.localOverrides.node).toMatchObject({
      locked: true,
      showAttachmentName: false,
      m2: { keep: true },
    });
    expect(withoutColors.localOverrides.node?.colors).toBeUndefined();
  });

  it("keeps unknown nested fields when merge applies a typography or color reset", () => {
    const original = {
      schemaVersion: 1,
      settings: { palette: [], recentColors: [] },
      localOverrides: {
        node: {
          typography: {
            fontFamily: "Inter",
            fontSize: 18,
            format: { bold: true, italic: false, underline: false, strike: false, futureFormat: { keep: true } },
            alignment: "left",
            lineHeight: 1.4,
            verticalAlign: "top",
            futureTypography: { keep: true },
          },
          colors: { text: "#112233", fill: null, futureColor: { keep: true } },
          locked: true,
          m2: { keep: true },
        },
      },
    };
    const initial = normalizeAppearanceState(original);

    const resetTypography = appearanceReducer(initial, {
      type: APPEARANCE_ACTIONS.resetTypography,
      nodeId: "node",
    });
    const mergedTypography = mergeAppearanceMetadata(original, resetTypography);
    const typographyNode = (mergedTypography.localOverrides as Record<string, Record<string, unknown>>).node;
    expect(typographyNode.typography).toEqual({
      format: { futureFormat: { keep: true } },
      futureTypography: { keep: true },
    });
    expect(typographyNode.colors).toMatchObject({ text: "#112233", futureColor: { keep: true } });
    expect(typographyNode.locked).toBe(true);

    const resetColors = appearanceReducer(initial, {
      type: APPEARANCE_ACTIONS.resetColors,
      nodeId: "node",
    });
    const mergedColors = mergeAppearanceMetadata(original, resetColors);
    const colorsNode = (mergedColors.localOverrides as Record<string, Record<string, unknown>>).node;
    expect(colorsNode.colors).toEqual({ futureColor: { keep: true } });
    expect(colorsNode.typography).toMatchObject({
      futureTypography: { keep: true },
      format: { futureFormat: { keep: true } },
    });
  });
});
