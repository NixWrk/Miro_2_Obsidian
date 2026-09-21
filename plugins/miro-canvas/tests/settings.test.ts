import { describe, expect, it } from "vitest";

import { authorColor, setAuthorColors } from "../src/comment-thread";
import {
  DEFAULT_COMMENT_AUTHOR,
  DEFAULT_SETTINGS,
  commentAuthorName,
  obsidianAccountName,
  NAVIGATION_COMMANDS,
  SETTING_BOUNDS,
  normalizeSettings,
  panDelta,
  wheelZooms,
} from "../src/settings";

describe("plugin settings", () => {
  it("falls back to the defaults for anything that is not a settings object", () => {
    for (const value of [undefined, null, 0, "settings", [], () => undefined]) {
      expect(normalizeSettings(value)).toEqual(DEFAULT_SETTINGS);
    }
  });

  it("signs comments with the chosen name, else the Obsidian account's, else Local user", () => {
    const storage = (value: string | null) => ({ getItem: (key: string) => (key === "obsidian-account" ? value : null) });
    const account = obsidianAccountName(storage(JSON.stringify({ name: " Anna ", email: "a@b.c", token: "secret" })));
    expect(account).toBe("Anna");
    expect(obsidianAccountName(storage(null))).toBeUndefined();
    expect(obsidianAccountName(storage("not json"))).toBeUndefined();
    expect(commentAuthorName(normalizeSettings({ commentAuthor: "  Nikolai " }), account)).toBe("Nikolai");
    expect(commentAuthorName(DEFAULT_SETTINGS, account)).toBe("Anna");
    expect(commentAuthorName(DEFAULT_SETTINGS)).toBe(DEFAULT_COMMENT_AUTHOR);
  });

  it("keeps a colour for each author only when it is one", () => {
    const stored = normalizeSettings({ commentAuthorColors: { Anna: "#AA3300", Bob: "red", "": "#000000" } });
    expect(stored.commentAuthorColors).toEqual({ Anna: "#aa3300" });
    const madeUp = authorColor("Anna");
    setAuthorColors(stored.commentAuthorColors);
    expect(authorColor("Anna")).toBe("#aa3300");
    setAuthorColors({});
    expect(authorColor("Anna")).toBe(madeUp);
  });

  it("keeps the developer diagnostics hidden unless they were asked for by name", () => {
    expect(DEFAULT_SETTINGS.developerDiagnostics).toBe(false);
    // An older version saved its default of showing them; that is not a choice.
    expect(normalizeSettings({ showDiagnostics: true }).developerDiagnostics).toBe(false);
    expect(normalizeSettings({ developerDiagnostics: true }).developerDiagnostics).toBe(true);
  });

  it("keeps stored values and drops unknown keys", () => {
    const stored = normalizeSettings({
      zoomStep: 1.5, panStep: 128, wheelZoomModifier: "shift",
      zoomToCursor: false, minimapVisible: false, somethingElse: "ignored",
    });
    expect(stored.zoomStep).toBe(1.5);
    expect(stored.panStep).toBe(128);
    expect(stored.wheelZoomModifier).toBe("shift");
    expect(stored.zoomToCursor).toBe(false);
    expect(stored.minimapVisible).toBe(false);
    expect(stored).not.toHaveProperty("somethingElse");
    // Untouched keys keep their default.
    expect(stored.maxZoom).toBe(DEFAULT_SETTINGS.maxZoom);
  });

  it("keeps the connector magnet and snap distances within their range", () => {
    expect(DEFAULT_SETTINGS.connectorMagnet).toBe(24);
    expect(DEFAULT_SETTINGS.connectorSnap).toBe(16);
    const stored = normalizeSettings({ connectorMagnet: 40, connectorSnap: 0 });
    expect(stored.connectorMagnet).toBe(40);
    expect(stored.connectorSnap).toBe(0);
    const clamped = normalizeSettings({ connectorMagnet: 500, connectorSnap: -3 });
    expect(clamped.connectorMagnet).toBe(SETTING_BOUNDS.connectorMagnet.max);
    expect(clamped.connectorSnap).toBe(SETTING_BOUNDS.connectorSnap.min);
  });

  it("clamps out-of-range numbers instead of refusing to open a board", () => {
    const clamped = normalizeSettings({ zoomStep: 99, panStep: -50, fastPanMultiplier: 0 });
    expect(clamped.zoomStep).toBe(SETTING_BOUNDS.zoomStep.max);
    expect(clamped.panStep).toBe(SETTING_BOUNDS.panStep.min);
    expect(clamped.fastPanMultiplier).toBe(SETTING_BOUNDS.fastPanMultiplier.min);
    const broken = normalizeSettings({ zoomStep: Number.NaN, panStep: "many", minZoom: Infinity });
    expect(broken.zoomStep).toBe(DEFAULT_SETTINGS.zoomStep);
    expect(broken.panStep).toBe(DEFAULT_SETTINGS.panStep);
    expect(broken.minZoom).toBe(DEFAULT_SETTINGS.minZoom);
  });

  it("orders an inverted zoom range so some zoom always remains available", () => {
    const settings = normalizeSettings({ minZoom: 1, maxZoom: 1 });
    expect(settings.minZoom).toBeLessThanOrEqual(settings.maxZoom);
    const inverted = normalizeSettings({ minZoom: 0.9, maxZoom: 1 });
    expect(inverted.minZoom).toBe(0.9);
    expect(inverted.maxZoom).toBe(1);
  });

  it("rejects an unsupported wheel modifier", () => {
    expect(normalizeSettings({ wheelZoomModifier: "meta" }).wheelZoomModifier)
      .toBe(DEFAULT_SETTINGS.wheelZoomModifier);
  });

  it("derives pan deltas from the configured step", () => {
    const settings = normalizeSettings({ panStep: 32, fastPanMultiplier: 3 });
    expect(panDelta(settings, "left")).toEqual({ x: -32, y: 0 });
    expect(panDelta(settings, "right")).toEqual({ x: 32, y: 0 });
    expect(panDelta(settings, "up")).toEqual({ x: 0, y: -32 });
    expect(panDelta(settings, "down", true)).toEqual({ x: 0, y: 96 });
  });

  it("decides wheel zoom from the configured modifier", () => {
    const ctrl = normalizeSettings({ wheelZoomModifier: "ctrl" });
    expect(wheelZooms(ctrl, { ctrlKey: true })).toBe(true);
    expect(wheelZooms(ctrl, { metaKey: true })).toBe(true);
    expect(wheelZooms(ctrl, { shiftKey: true })).toBe(false);
    expect(wheelZooms(normalizeSettings({ wheelZoomModifier: "none" }), {})).toBe(true);
    expect(wheelZooms(normalizeSettings({ wheelZoomModifier: "alt" }), { altKey: true })).toBe(true);
  });

  it("declares navigation commands with unique ids and no default hotkeys", () => {
    const ids = NAVIGATION_COMMANDS.map((command) => command.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const command of NAVIGATION_COMMANDS) {
      expect(command.id.startsWith("m1-")).toBe(true);
      expect(command.name.length).toBeGreaterThan(0);
      expect(command).not.toHaveProperty("hotkeys");
    }
  });
});
