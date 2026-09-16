/**
 * How a connector's line and ends look, shared by the renderer that draws
 * connectors and the toolbar that shows each choice as a small picture.
 *
 * Cap paths are drawn in a marker box whose tip sits at the origin and points
 * along +x, so one path serves both ends: SVG turns a start marker round.
 */

import { CONNECTOR_CAPS, CONNECTOR_ROUTES, CONNECTOR_STROKES } from "./source-model";

export type ConnectorCap = (typeof CONNECTOR_CAPS)[number];
export type ConnectorRoute = (typeof CONNECTOR_ROUTES)[number];
export type ConnectorStroke = (typeof CONNECTOR_STROKES)[number];

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

export const CAP_LABELS: Readonly<Record<ConnectorCap, string>> = Object.freeze({
  none: "No end",
  stealth: "Sharp arrow",
  rounded_stealth: "Rounded arrow",
  arrow: "Open arrow",
  filled_triangle: "Filled triangle",
  triangle: "Triangle",
  filled_diamond: "Filled diamond",
  diamond: "Diamond",
  filled_oval: "Filled circle",
  oval: "Circle",
  erd_one: "One\nEntity relationship: one",
  erd_many: "Many\nEntity relationship: many",
  erd_one_or_many: "One or many\nEntity relationship: at least one",
  erd_only_one: "Only one\nEntity relationship: exactly one",
  erd_zero_or_many: "Zero or many\nEntity relationship: any number, possibly none",
  erd_zero_or_one: "Zero or one\nEntity relationship: at most one",
});

export const ROUTE_LABELS: Readonly<Record<ConnectorRoute, string>> = Object.freeze({
  straight: "Straight line",
  elbowed: "Elbowed line",
  curved: "Curved line",
});

export const STROKE_LABELS: Readonly<Record<ConnectorStroke, string>> = Object.freeze({
  solid: "Solid line",
  dashed: "Dashed line",
  dotted: "Dotted line",
});

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
