/**
 * How a connector's line and ends look, shared by the renderer that draws
 * connectors and the toolbar that shows each choice as a small picture.
 *
 * Cap paths are drawn in a marker box whose tip sits at the origin and points
 * along +x, so one path serves both ends: SVG turns a start marker round.
 */

import { words } from "./i18n";
import { CONNECTOR_CAPS, CONNECTOR_ROUTES, CONNECTOR_STROKES } from "./source-model";

export type ConnectorCap = (typeof CONNECTOR_CAPS)[number];
export type ConnectorRoute = (typeof CONNECTOR_ROUTES)[number];
export type ConnectorStroke = (typeof CONNECTOR_STROKES)[number];

/** Nominal ten-unit cap size in board units, independent of the shaft width. */
export function validHeadSize(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 && value <= 1000;
}

/** Shared marker sizing for board and native edges. Scale is screen units per board unit.
 * Omitted sizes retain the caller's legacy marker attributes unchanged.
 */
export function headMarkerAttributes(headSize: number | undefined, scale = 1): Readonly<Record<string, string>> {
  if (!validHeadSize(headSize)) return {};
  return {
    markerUnits: "userSpaceOnUse",
    viewBox: "-16 -8 18 16",
    markerWidth: String(headSize * scale * 1.8),
    markerHeight: String(headSize * scale * 1.6),
  };
}

export const CAP_PATHS: Readonly<Record<string, string>> = Object.freeze({
  rounded_stealth: "M-10 -5Q-2 -2 0 0Q-2 2 -10 5L-7 0Z",
  filled_oval: "M-5 -5A5 5 0 1 1 -5 5A5 5 0 1 1 -5 -5Z",
  erd_one: "M-5 -6V6",
  erd_many: "M-10 -6L0 0L-10 6M-10 0H0",
  erd_one_or_many: "M-10 -6L0 0L-10 6M-10 0H0M-13 -6V6",
  erd_only_one: "M-5 -6V6M-10 -6V6",
  erd_zero_or_many: "M-8 -6L0 0L-8 6M-8 0H0M-12 -3A3 3 0 1 1 -12 3A3 3 0 1 1 -12 -3Z",
  erd_zero_or_one: "M-5 -6V6M-11 -3A3 3 0 1 1 -11 3A3 3 0 1 1 -11 -3Z",
  arrow: "M-10 -5L0 0L-10 5", triangle: "M-10 -5L0 0L-10 5Z",
  stealth: "M-10 -5L0 0L-10 5L-7 0Z", diamond: "M-12 0L-6 -5L0 0L-6 5Z",
  circle: "M-5 -5A5 5 0 1 1 -5 5A5 5 0 1 1 -5 -5Z",
  oval: "M-5 -5A5 5 0 1 1 -5 5A5 5 0 1 1 -5 -5Z",
  filled_triangle: "M-10 -5L0 0L-10 5Z", filled_diamond: "M-12 0L-6 -5L0 0L-6 5Z",
  filled_circle: "M-5 -5A5 5 0 1 1 -5 5A5 5 0 1 1 -5 -5Z",
  er_one: "M-5 -6V6", er_many: "M-10 -6L0 0L-10 6M-10 0H0",
  er_one_or_many: "M-10 -6L0 0L-10 6M-10 0H0M-13 -6V6",
});

/** Solid caps are painted in the line's colour; the rest are outlines. */
export function capFilled(cap: string): boolean {
  return cap.startsWith("filled_") || cap === "stealth" || cap === "rounded_stealth";
}

/** How far back from its tip an outlined cap reaches, so a line can stop at its back instead of crossing it. */
export function capReach(cap: string): number {
  if (cap === "triangle" || cap === "oval" || cap === "circle") return 10;
  return cap === "diamond" ? 12 : 0;
}

/** A connector end's hover text, in the language in use. */
export function capLabels(): Readonly<Record<ConnectorCap, string>> {
  return words().connector.caps;
}

/** A connector route's hover text, in the language in use. */
export function routeLabels(): Readonly<Record<ConnectorRoute, string>> {
  return words().connector.routes;
}

/** A connector stroke's hover text, in the language in use. */
export function strokeLabels(): Readonly<Record<ConnectorStroke, string>> {
  return words().connector.strokes;
}

/** Pictures of the three routes in a 24-unit box. */
export const ROUTE_ICON_PATHS: Readonly<Record<ConnectorRoute, string>> = Object.freeze({
  straight: "M4 20L20 4",
  elbowed: "M4 19H12V5H20",
  curved: "M4 19C14 19 10 5 20 5",
});

/** The SVG dash pattern of a line style, or none for a solid line. */
export function strokeDash(style: string | undefined): string {
  return style === "dashed" ? "8 6" : style === "dotted" ? "2 5" : "none";
}
