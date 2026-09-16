/**
 * The shapes a person can pick, one entry per picture.
 *
 * Miro names several outlines twice: once as a basic shape and once as the
 * flowchart symbol drawn with the same outline - a rhombus is the flowchart
 * decision, a brace is the flowchart annotation.  A picker listing both kinds
 * offers the same picture twice.  Each entry here is one picture: the basic
 * name, the meaning the picture carries in a flowchart, and the other kinds
 * drawn with it, so a node of any of those kinds shows the entry as current.
 * A flowchart symbol with no basic twin keeps its own entry and name.
 */

import type { LOCAL_SHAPE_KINDS } from "./source-model";

export type ShapeKind = (typeof LOCAL_SHAPE_KINDS)[number];

export type ShapeSection = "basic" | "flowchart";

/** The box an icon is drawn in: most outlines read best in a landscape box. */
export type ShapeAspect = "square" | "wide" | "tall";

export interface ShapeCatalogEntry {
  /** The kind written when the entry is picked. */
  readonly kind: ShapeKind;
  readonly section: ShapeSection;
  readonly name: string;
  /** What the picture stands for in a flowchart, when it stands for anything. */
  readonly meaning?: string;
  /** Other kinds drawn with the same picture. */
  readonly aliases: readonly ShapeKind[];
  readonly aspect: ShapeAspect;
}

const entry = (
  kind: ShapeKind, section: ShapeSection, name: string, aspect: ShapeAspect,
  meaning?: string, aliases: readonly ShapeKind[] = [],
): ShapeCatalogEntry => Object.freeze({
  kind, section, name, aspect, aliases: Object.freeze([...aliases]),
  ...(meaning === undefined ? {} : { meaning }),
});

const ANNOTATION = "Annotation: a comment on the steps beside it";

export const SHAPE_CATALOG: readonly ShapeCatalogEntry[] = Object.freeze([
  entry("rectangle", "basic", "Rectangle", "wide", "Process: a step or action", ["flow_chart_process"]),
  entry("round_rectangle", "basic", "Rounded rectangle", "wide"),
  entry("circle", "basic", "Circle", "square", "Connector: joins flow lines on the same page", ["ellipse", "flow_chart_connector"]),
  entry("triangle", "basic", "Triangle", "square"),
  entry("rhombus", "basic", "Rhombus", "square", "Decision: a question that branches the flow", ["diamond", "flow_chart_decision"]),
  entry("parallelogram", "basic", "Parallelogram", "wide", "Data: input to or output from the flow", ["flow_chart_input_output"]),
  entry("trapezoid", "basic", "Trapezoid", "wide"),
  entry("pentagon", "basic", "Pentagon", "square"),
  entry("hexagon", "basic", "Hexagon", "wide", "Preparation: setting up before a step", ["flow_chart_preparation"]),
  entry("octagon", "basic", "Octagon", "square"),
  entry("star", "basic", "Star", "square"),
  entry("cross", "basic", "Cross", "square"),
  entry("cloud", "basic", "Cloud", "wide"),
  entry("wedge_round_rectangle_callout", "basic", "Callout", "wide"),
  entry("can", "basic", "Cylinder", "tall", "Database: stored data", ["flow_chart_magnetic_disk"]),
  entry("right_arrow", "basic", "Right arrow", "wide"),
  entry("left_arrow", "basic", "Left arrow", "wide"),
  entry("left_right_arrow", "basic", "Left-right arrow", "wide"),
  entry("left_brace", "basic", "Left brace", "tall", ANNOTATION, ["flow_chart_note_curly_left"]),
  entry("right_brace", "basic", "Right brace", "tall", ANNOTATION, ["flow_chart_note_curly_right"]),
  entry("flow_chart_terminator", "flowchart", "Terminator", "wide", "Start or end of the flow"),
  entry("flow_chart_predefined_process", "flowchart", "Predefined process", "wide", "A subprocess described elsewhere"),
  entry("flow_chart_predefined_process_2", "flowchart", "Framed process", "wide", "A subprocess described elsewhere, framed on every side"),
  entry("flow_chart_internal_storage", "flowchart", "Internal storage", "wide", "Data kept in memory"),
  entry("flow_chart_document", "flowchart", "Document", "wide", "A document or report"),
  entry("flow_chart_multidocuments", "flowchart", "Documents", "wide", "Several documents or reports"),
  entry("flow_chart_manual_input", "flowchart", "Manual input", "wide", "Data entered by hand"),
  entry("flow_chart_manual_operation", "flowchart", "Manual operation", "wide", "A step done by hand"),
  entry("flow_chart_delay", "flowchart", "Delay", "wide", "A wait before the flow goes on"),
  entry("flow_chart_display", "flowchart", "Display", "wide", "Information shown on a screen"),
  entry("flow_chart_online_storage", "flowchart", "Stored data", "wide", "Data kept in any storage"),
  entry("flow_chart_magnetic_drum", "flowchart", "Direct access storage", "wide", "Data on a drive read in any order"),
  entry("flow_chart_merge", "flowchart", "Merge", "square", "Several flows joined into one"),
  entry("flow_chart_offpage_connector", "flowchart", "Off-page connector", "square", "The flow goes on on another page"),
  entry("flow_chart_or", "flowchart", "Or", "square", "The flow goes on along any one branch"),
  entry("flow_chart_summing_junction", "flowchart", "Summing junction", "square", "The flow goes on along every branch"),
  entry("flow_chart_note_square", "flowchart", "Bracket note", "tall", ANNOTATION),
]);

const BY_KIND: ReadonlyMap<string, ShapeCatalogEntry> = new Map(
  SHAPE_CATALOG.flatMap((item) => [item.kind, ...item.aliases].map((kind) => [kind, item] as const)),
);

/** The entry drawing a kind, whether the kind is the entry's own or an alias. */
export function shapeCatalogEntry(kind: string | undefined): ShapeCatalogEntry | undefined {
  return kind === undefined ? undefined : BY_KIND.get(kind);
}

/** The hover text of an entry: its name, then its flowchart meaning. */
export function shapeCatalogLabel(item: ShapeCatalogEntry): string {
  return item.meaning === undefined ? item.name : `${item.name}\n${item.meaning}`;
}
