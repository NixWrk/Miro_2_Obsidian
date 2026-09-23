/**
 * Manual layer order for cards (FUT-015).
 *
 * Only cards - native Canvas nodes of type text, file, or link - carry a
 * stacking order a person can change.  Frames are stacked by native Canvas
 * itself, by area, under everything, and are never moved by this module.
 * Lines - native edges and the plugin's own connectors - have no layer at
 * all.  This module is pure: it knows nothing of the Canvas document, the
 * native runtime, or metadata; `canvas-authoring.ts` maps a document's card
 * nodes to `LayerCard` records, calls `reorderCards`, and writes the result
 * back into the card slots of the document's node array.
 */

/** One selected card can be sent to the front or back, or past its nearest overlap. */
export type LayerDirection = "front" | "forward" | "backward" | "back";

/** The four layer commands, in the order they are offered in the interface. */
export const LAYER_ACTIONS: readonly {
	readonly direction: LayerDirection;
	readonly label: string;
	readonly icon: string;
}[] = Object.freeze([
	Object.freeze({ direction: "front", label: "Bring to front", icon: "bring-to-front" }),
	Object.freeze({ direction: "forward", label: "Bring forward", icon: "arrow-up" }),
	Object.freeze({ direction: "backward", label: "Send backward", icon: "arrow-down" }),
	Object.freeze({ direction: "back", label: "Send to back", icon: "send-to-back" }),
]);

export const LAYER_MENU_LABEL = "Layer";
export const LAYER_MENU_ICON = "layers-2";

/** A card's box, read from the document; only cards have one of these. */
export interface LayerCard {
	readonly id: string;
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/** Positive-area intersection of two boxes; touching edges do not count. */
export function cardsOverlap(a: LayerCard, b: LayerCard): boolean {
	return a.x < b.x + b.width && a.x + a.width > b.x
		&& a.y < b.y + b.height && a.y + a.height > b.y;
}

/** All selected cards to one end, in their existing relative order. */
function moveToEnd(ids: readonly string[], selected: ReadonlySet<string>, selectedFirst: boolean): string[] {
	const chosen: string[] = [];
	const rest: string[] = [];
	for (const id of ids) {
		(selected.has(id) ? chosen : rest).push(id);
	}
	return selectedFirst ? [...chosen, ...rest] : [...rest, ...chosen];
}

/**
 * A selected card moves just past the nearest overlapping unselected card in
 * `towardFront`'s direction, never crossing another selected card.  Cards
 * without an overlap ahead of them stay where they are.
 */
function moveTowardNearestOverlap(
	cards: readonly LayerCard[],
	selected: ReadonlySet<string>,
	towardFront: boolean,
): string[] {
	const order = cards.map((card) => card.id);
	const byId = new Map(cards.map((card) => [card.id, card]));
	// Selected ids in back-to-front order; processed from the one nearest the
	// direction of travel down to the one furthest from it.
	const selectedOrder = order.filter((id) => selected.has(id));
	const sequence = towardFront ? [...selectedOrder].reverse() : selectedOrder;
	// The position a selected card may not scan past: the position - after any
	// move - of the selected card processed just before this one.
	let boundary = towardFront ? order.length : -1;
	for (const id of sequence) {
		const card = byId.get(id)!;
		const pos = order.indexOf(id);
		let targetId: string | undefined;
		if (towardFront) {
			for (let index = pos + 1; index < boundary; index += 1) {
				const candidateId = order[index]!;
				if (!selected.has(candidateId) && cardsOverlap(card, byId.get(candidateId)!)) {
					targetId = candidateId;
					break;
				}
			}
		} else {
			for (let index = pos - 1; index > boundary; index -= 1) {
				const candidateId = order[index]!;
				if (!selected.has(candidateId) && cardsOverlap(card, byId.get(candidateId)!)) {
					targetId = candidateId;
					break;
				}
			}
		}
		if (targetId === undefined) {
			boundary = pos;
			continue;
		}
		order.splice(pos, 1);
		const landedAt = order.indexOf(targetId);
		order.splice(towardFront ? landedAt + 1 : landedAt, 0, id);
		boundary = order.indexOf(id);
	}
	return order;
}

/**
 * The new back-to-front card order for one layer command.
 *
 * `cards` is every card, back to front; `selected` names the ones the person
 * chose.  O(n) for front and back; at worst O(n * selected.size) for forward
 * and backward, never O(n^2) over the whole board.
 */
export function reorderCards(
	cards: readonly LayerCard[],
	selected: ReadonlySet<string>,
	direction: LayerDirection,
): string[] {
	const ids = cards.map((card) => card.id);
	if (direction === "front") return moveToEnd(ids, selected, false);
	if (direction === "back") return moveToEnd(ids, selected, true);
	return moveTowardNearestOverlap(cards, selected, direction === "forward");
}
