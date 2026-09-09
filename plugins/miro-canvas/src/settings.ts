/**
 * Persisted plugin settings.
 *
 * Everything here is pure data with explicit bounds so the settings tab, the
 * session and the tests all agree on what a value may be.  A stored file is
 * user-editable and may come from an older release, so nothing is trusted:
 * unknown keys are dropped and out-of-range numbers are clamped rather than
 * rejected, because a bad preference must never stop a board from opening.
 */

export type WheelZoomModifier = "none" | "ctrl" | "shift" | "alt";

export interface MiroCanvasSettings {
  /** Multiplier applied per zoom step. */
  readonly zoomStep: number;
  readonly minZoom: number;
  readonly maxZoom: number;
  /** Zoom towards the pointer instead of the viewport center. */
  readonly zoomToCursor: boolean;
  readonly invertWheelZoom: boolean;
  /** Modifier the wheel needs before it zooms instead of pans. */
  readonly wheelZoomModifier: WheelZoomModifier;
  /** Board units moved by one keyboard pan step. */
  readonly panStep: number;
  /** Multiplier applied while Shift is held during a keyboard pan. */
  readonly fastPanMultiplier: number;
  readonly minimapVisible: boolean;
  readonly selectionToolbarEnabled: boolean;
  readonly showDiagnostics: boolean;
}

interface NumberBound {
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

export const SETTING_BOUNDS: Readonly<Record<
  "zoomStep" | "minZoom" | "maxZoom" | "panStep" | "fastPanMultiplier",
  NumberBound
>> = Object.freeze({
  zoomStep: { min: 1.02, max: 2, step: 0.01 },
  minZoom: { min: 0.01, max: 1, step: 0.01 },
  maxZoom: { min: 1, max: 64, step: 0.5 },
  panStep: { min: 8, max: 512, step: 8 },
  fastPanMultiplier: { min: 1, max: 10, step: 0.5 },
});

export const WHEEL_ZOOM_MODIFIERS: readonly WheelZoomModifier[] = ["none", "ctrl", "shift", "alt"];

export const DEFAULT_SETTINGS: MiroCanvasSettings = Object.freeze({
  zoomStep: 1.2,
  minZoom: 0.0625,
  maxZoom: 16,
  zoomToCursor: true,
  invertWheelZoom: false,
  wheelZoomModifier: "ctrl",
  panStep: 64,
  fastPanMultiplier: 4,
  minimapVisible: true,
  selectionToolbarEnabled: true,
  showDiagnostics: true,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readNumber(source: Record<string, unknown>, key: keyof typeof SETTING_BOUNDS, fallback: number): number {
  const raw = source[key];
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) {
    return fallback;
  }
  const bound = SETTING_BOUNDS[key];
  return Math.min(bound.max, Math.max(bound.min, value));
}

function readBoolean(source: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = source[key];
  return typeof value === "boolean" ? value : fallback;
}

/** Accepts any stored value and always returns usable settings. */
export function normalizeSettings(value: unknown): MiroCanvasSettings {
  if (!isRecord(value)) {
    return DEFAULT_SETTINGS;
  }
  const modifier = value.wheelZoomModifier;
  const minZoom = readNumber(value, "minZoom", DEFAULT_SETTINGS.minZoom);
  const maxZoom = readNumber(value, "maxZoom", DEFAULT_SETTINGS.maxZoom);
  return Object.freeze({
    zoomStep: readNumber(value, "zoomStep", DEFAULT_SETTINGS.zoomStep),
    // An inverted range would leave no zoom at all, so the pair is ordered.
    minZoom: Math.min(minZoom, maxZoom),
    maxZoom: Math.max(minZoom, maxZoom),
    zoomToCursor: readBoolean(value, "zoomToCursor", DEFAULT_SETTINGS.zoomToCursor),
    invertWheelZoom: readBoolean(value, "invertWheelZoom", DEFAULT_SETTINGS.invertWheelZoom),
    wheelZoomModifier: WHEEL_ZOOM_MODIFIERS.includes(modifier as WheelZoomModifier)
      ? modifier as WheelZoomModifier
      : DEFAULT_SETTINGS.wheelZoomModifier,
    panStep: readNumber(value, "panStep", DEFAULT_SETTINGS.panStep),
    fastPanMultiplier: readNumber(value, "fastPanMultiplier", DEFAULT_SETTINGS.fastPanMultiplier),
    minimapVisible: readBoolean(value, "minimapVisible", DEFAULT_SETTINGS.minimapVisible),
    selectionToolbarEnabled: readBoolean(value, "selectionToolbarEnabled", DEFAULT_SETTINGS.selectionToolbarEnabled),
    showDiagnostics: readBoolean(value, "showDiagnostics", DEFAULT_SETTINGS.showDiagnostics),
  });
}

export type PanDirection = "left" | "right" | "up" | "down";

/** Board-space delta for one keyboard pan, before the viewport applies zoom. */
export function panDelta(
  settings: MiroCanvasSettings, direction: PanDirection, fast = false,
): { readonly x: number; readonly y: number } {
  const distance = settings.panStep * (fast ? settings.fastPanMultiplier : 1);
  switch (direction) {
    case "left": return { x: -distance, y: 0 };
    case "right": return { x: distance, y: 0 };
    case "up": return { x: 0, y: -distance };
    case "down": return { x: 0, y: distance };
  }
}

/** True when a wheel event should zoom rather than pan under these settings. */
export function wheelZooms(settings: MiroCanvasSettings, event: {
  readonly ctrlKey?: boolean; readonly metaKey?: boolean;
  readonly shiftKey?: boolean; readonly altKey?: boolean;
}): boolean {
  switch (settings.wheelZoomModifier) {
    case "none": return true;
    case "ctrl": return event.ctrlKey === true || event.metaKey === true;
    case "shift": return event.shiftKey === true;
    case "alt": return event.altKey === true;
  }
}

export interface NavigationCommandDefinition {
  readonly id: string;
  readonly name: string;
}

/**
 * Commands are registered so Obsidian's own hotkey editor can bind them; the
 * plugin deliberately ships no default bindings to avoid taking keys from the
 * user or another plugin.
 */
export const NAVIGATION_COMMANDS: readonly NavigationCommandDefinition[] = Object.freeze([
  { id: "m1-zoom-in", name: "Zoom in" },
  { id: "m1-zoom-out", name: "Zoom out" },
  { id: "m1-zoom-reset", name: "Reset zoom to 100%" },
  { id: "m1-zoom-fit", name: "Fit board to viewport" },
  { id: "m1-toggle-minimap", name: "Show or hide the minimap" },
  { id: "m1-pan-left", name: "Pan left" },
  { id: "m1-pan-right", name: "Pan right" },
  { id: "m1-pan-up", name: "Pan up" },
  { id: "m1-pan-down", name: "Pan down" },
]);
