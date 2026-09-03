import { describe, expect, it } from "vitest";

import {
	canEdit,
	createInteractionPolicy,
	decideEdit,
	decideEditOperation,
	decideInteraction,
	reduceInteractionMetadata,
	reduceInteractionMetadataResult,
} from "../src/interaction-policy";

describe("M1 interaction policy", () => {
	it("blocks every board edit in review mode while keeping read operations available", () => {
		const policy = {
			settings: { reviewMode: true },
			localOverrides: { node: { locked: false } },
		};

		expect(decideEdit(policy, { operation: "move", elementId: "node" })).toMatchObject({
			allowed: false,
			blocked: true,
			reason: "review-mode",
		});
		expect(decideInteraction(policy, { operation: "pan" })).toMatchObject({
			allowed: true,
			blocked: false,
			reason: "allowed",
		});
		expect(decideInteraction(policy, { operation: "comment", targetId: "node" }).allowed).toBe(true);
	});

	it("honors per-element locks and group descendants deterministically", () => {
		const policy = createInteractionPolicy({
			settings: { reviewMode: false },
			localOverrides: {
				lockedNode: { locked: true },
				lockedGroup: { locked: true },
			},
			groupDescendants: { lockedGroup: ["child", "nestedGroup"], nestedGroup: ["nestedChild"] },
		});

		expect(policy.valid).toBe(true);
		expect(decideEdit(policy, { operation: "resize", elementId: "lockedNode" }).lockedElementIds).toEqual(["lockedNode"]);
		expect(decideEdit(policy, { operation: "resize", elementId: "child" })).toMatchObject({
			allowed: false,
			reason: "element-locked",
			lockedElementIds: ["child"],
		});
		expect(decideEdit(policy, { operation: "resize", elementIds: ["nestedChild", "free"] })).toMatchObject({
			allowed: false,
			lockedElementIds: ["nestedChild"],
		});
		expect(decideEditOperation(policy, "delete", ["free"])).toMatchObject({ allowed: true, reason: "allowed" });
	});

	it("fails closed for malformed, inherited, and prototype-hostile input", () => {
		expect(decideEdit({ settings: { reviewMode: "yes" } }, { operation: "move", elementId: "node" })).toMatchObject({
			allowed: false,
			reason: "invalid-input",
		});
		const inherited = Object.create({ settings: { reviewMode: false } }) as Record<string, unknown>;
		expect(decideEdit(inherited, { operation: "move", elementId: "node" }).reason).toBe("invalid-input");
		const polluted = { settings: { reviewMode: false } } as Record<string, unknown>;
		Object.defineProperty(polluted, "localOverrides", {
			configurable: true,
			get: () => {
				throw new Error("hostile getter");
			},
		});
		expect(() => decideEdit(polluted, { operation: "move", elementId: "node" })).not.toThrow();
		expect(decideEdit(polluted, { operation: "move", elementId: "node" }).reason).toBe("invalid-input");
		const revoked = Proxy.revocable({ settings: { reviewMode: false } }, {});
		revoked.revoke();
		expect(() => createInteractionPolicy(revoked.proxy)).not.toThrow();
		expect(createInteractionPolicy(revoked.proxy).valid).toBe(false);
	});

	it("returns immutable detached metadata from pure reducers", () => {
		const source = {
			schemaVersion: 1,
			settings: { reviewMode: false, showAttachmentNames: true },
			localOverrides: { node: { showAttachmentName: false, custom: { keep: true } } },
		};
		const next = reduceInteractionMetadata(source, { type: "set-lock", elementId: "node", locked: true });
		expect(next).toBeDefined();
		expect(next).not.toBe(source);
		expect(next?.localOverrides).not.toBe(source.localOverrides);
		expect(next?.localOverrides?.node).not.toBe(source.localOverrides.node);
		expect(next).toMatchObject({
			schemaVersion: 1,
			settings: { reviewMode: false, showAttachmentNames: true },
			localOverrides: { node: { locked: true, showAttachmentName: false, custom: { keep: true } } },
		});
		expect(source.localOverrides.node).not.toHaveProperty("locked");
		expect(Object.isFrozen(next)).toBe(true);
		expect(Object.isFrozen(next?.localOverrides)).toBe(true);
		expect(Object.isFrozen(next?.localOverrides?.node)).toBe(true);
		expect(reduceInteractionMetadata(source, { type: "set-review-mode", enabled: true })).toMatchObject({
			settings: { reviewMode: true, showAttachmentNames: true },
		});
		expect(reduceInteractionMetadataResult(source, { type: "unknown" })).toMatchObject({
			ok: false,
			changed: false,
		});
	});

	it("supports direct lock actions and does not allow invalid element IDs", () => {
		const source = { settings: { reviewMode: false }, localOverrides: {} };
		expect(reduceInteractionMetadata(source, { type: "lock", elementId: "node" })).toMatchObject({
			localOverrides: { node: { locked: true } },
		});
		expect(reduceInteractionMetadata(source, { type: "unlock", elementId: "node" })).toMatchObject({
			localOverrides: { node: { locked: false } },
		});
		expect(reduceInteractionMetadata(source, { type: "set-locks", elementIds: ["a", "b"], locked: true })).toMatchObject({
			localOverrides: { a: { locked: true }, b: { locked: true } },
		});
		expect(reduceInteractionMetadata(source, { type: "lock", elementId: "bad\nvalue" })).toBeUndefined();
		expect(canEdit({ settings: { reviewMode: false } }, { operation: "delete", elementId: "node" })).toBe(true);
	});
});

