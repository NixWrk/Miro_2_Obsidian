import { describe, expect, it } from "vitest";

import { cardsOverlap, reorderCards, type LayerCard } from "../src/layer-order";

/** a-b-c-d, back to front: a overlaps b, b overlaps c, a and c do not touch, d overlaps nothing. */
function chainCards(): LayerCard[] {
	return [
		{ id: "a", x: 0, y: 0, width: 150, height: 80 },
		{ id: "b", x: 100, y: 0, width: 150, height: 80 },
		{ id: "c", x: 200, y: 0, width: 150, height: 80 },
		{ id: "d", x: 500, y: 0, width: 80, height: 80 },
	];
}

function ids(order: readonly string[]): string {
	return order.join(",");
}

describe("cardsOverlap", () => {
	it("finds a positive-area intersection", () => {
		const a: LayerCard = { id: "a", x: 0, y: 0, width: 100, height: 100 };
		const b: LayerCard = { id: "b", x: 50, y: 50, width: 100, height: 100 };
		expect(cardsOverlap(a, b)).toBe(true);
	});

	it("treats touching edges as not overlapping", () => {
		const a: LayerCard = { id: "a", x: 0, y: 0, width: 100, height: 100 };
		const rightEdge: LayerCard = { id: "b", x: 100, y: 0, width: 100, height: 100 };
		const belowEdge: LayerCard = { id: "c", x: 0, y: 100, width: 100, height: 100 };
		const corner: LayerCard = { id: "d", x: 100, y: 100, width: 100, height: 100 };
		expect(cardsOverlap(a, rightEdge)).toBe(false);
		expect(cardsOverlap(a, belowEdge)).toBe(false);
		expect(cardsOverlap(a, corner)).toBe(false);
	});

	it("finds no intersection for boxes apart on either axis", () => {
		const a: LayerCard = { id: "a", x: 0, y: 0, width: 100, height: 100 };
		const farRight: LayerCard = { id: "b", x: 200, y: 0, width: 100, height: 100 };
		const farBelow: LayerCard = { id: "c", x: 0, y: 200, width: 100, height: 100 };
		expect(cardsOverlap(a, farRight)).toBe(false);
		expect(cardsOverlap(a, farBelow)).toBe(false);
	});
});

describe("reorderCards", () => {
	it("brings one selected card in front of every card, keeping the rest's order", () => {
		const result = reorderCards(chainCards(), new Set(["b"]), "front");
		expect(ids(result)).toBe("a,c,d,b");
	});

	it("sends one selected card behind every card, keeping the rest's order", () => {
		const result = reorderCards(chainCards(), new Set(["c"]), "back");
		expect(ids(result)).toBe("c,a,b,d");
	});

	it("brings several selected cards to the front in their existing relative order", () => {
		const result = reorderCards(chainCards(), new Set(["a", "c"]), "front");
		expect(ids(result)).toBe("b,d,a,c");
	});

	it("sends several selected cards to the back in their existing relative order", () => {
		const result = reorderCards(chainCards(), new Set(["b", "d"]), "back");
		expect(ids(result)).toBe("b,d,a,c");
	});

	it("brings a card forward only past its nearest overlapping card", () => {
		// b overlaps only c ahead of it; forward jumps straight past c, not to d.
		const result = reorderCards(chainCards(), new Set(["b"]), "forward");
		expect(ids(result)).toBe("a,c,b,d");
	});

	it("sends a card backward only past its nearest overlapping card", () => {
		const result = reorderCards(chainCards(), new Set(["c"]), "backward");
		expect(ids(result)).toBe("a,c,b,d");
	});

	it("leaves a card in place when nothing ahead of it overlaps", () => {
		// d overlaps nothing; forward and backward are both no-ops for it.
		expect(ids(reorderCards(chainCards(), new Set(["d"]), "forward"))).toBe("a,b,c,d");
		expect(ids(reorderCards(chainCards(), new Set(["d"]), "backward"))).toBe("a,b,c,d");
		// a has nothing behind it, so backward is a no-op too.
		expect(ids(reorderCards(chainCards(), new Set(["a"]), "backward"))).toBe("a,b,c,d");
	});

	it("treats touching cards as not overlapping for forward and backward", () => {
		const touching: LayerCard[] = [
			{ id: "a", x: 0, y: 0, width: 100, height: 100 },
			{ id: "b", x: 100, y: 0, width: 100, height: 100 },
		];
		expect(ids(reorderCards(touching, new Set(["a"]), "forward"))).toBe("a,b");
		expect(ids(reorderCards(touching, new Set(["b"]), "backward"))).toBe("a,b");
	});

	it("never lets a selected card pass another selected card it is moving toward", () => {
		// a and c are both selected; c (the topmost) has no overlap ahead and
		// stays, which bounds how far forward a may travel: only up to b, not
		// past c's original position.
		const result = reorderCards(chainCards(), new Set(["a", "c"]), "forward");
		expect(ids(result)).toBe("b,a,c,d");
		expect(result.indexOf("a")).toBeLessThan(result.indexOf("c"));
	});

	it("never lets a selected card pass another selected card moving backward", () => {
		// Back to front: x, a, b, c, d.  b overlaps only a; d overlaps only x,
		// far behind b.  Selected b moves behind a first, which then bounds
		// d's search - d cannot reach past b to test x, and c does not
		// overlap it either, so d stays in front although x overlaps it.
		const cards: LayerCard[] = [
			{ id: "x", x: 0, y: 0, width: 100, height: 80 },
			{ id: "a", x: 90, y: 0, width: 100, height: 80 },
			{ id: "b", x: 150, y: 0, width: 100, height: 80 },
			{ id: "c", x: 400, y: 0, width: 50, height: 80 },
			{ id: "d", x: 10, y: 0, width: 60, height: 80 },
		];
		expect(cardsOverlap(cards[4]!, cards[0]!)).toBe(true);
		const result = reorderCards(cards, new Set(["b", "d"]), "backward");
		expect(ids(result)).toBe("x,b,a,c,d");
	});
});
