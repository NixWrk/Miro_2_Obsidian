/**
 * What native Canvas does to nodes and edges as it stores them.
 *
 * A save rebuilds the document from Canvas's own model, so a file written by
 * another tool - the converter, a hand edit - comes back in Canvas's own
 * habits: an edge end left at its default is left out, an empty colour or
 * label is left out, and node geometry is rounded to whole pixels.  A check
 * that a save kept the board must accept exactly these, or every write to a
 * converted board is refused until Canvas has saved it once by itself.
 */

export type GraphKind = "nodes" | "edges";

/**
 * Values native Canvas stores as "not set" and so leaves out of getData():
 * an edge has no start cap and an arrow at its end unless told otherwise,
 * and a colour or a label only when one is set.
 */
export const NATIVE_OMITTED_DEFAULTS: Readonly<Record<GraphKind, Readonly<Record<string, unknown>>>> = Object.freeze({
	nodes: Object.freeze({ color: "" }),
	edges: Object.freeze({ fromEnd: "none", toEnd: "arrow", color: "", label: "" }),
});

/** Native Canvas rounds node geometry to whole pixels as it stores it. */
const NATIVE_ROUNDED_GEOMETRY: ReadonlySet<string> = new Set(["x", "y", "width", "height"]);

/** Whether native Canvas leaves this written field out because it holds the default. */
export function nativeOmits(kind: GraphKind, field: string, written: unknown): boolean {
	const omitted = NATIVE_OMITTED_DEFAULTS[kind];
	return Object.prototype.hasOwnProperty.call(omitted, field) && omitted[field] === written;
}

/** Whether the stored value is the written node geometry rounded, as native Canvas stores it. */
export function nativeRounds(kind: GraphKind, field: string, written: unknown, stored: unknown): boolean {
	return kind === "nodes"
		&& NATIVE_ROUNDED_GEOMETRY.has(field)
		&& typeof written === "number"
		&& Number.isFinite(written)
		&& stored === Math.round(written);
}
