import { describe, expect, it } from "vitest";

import {
	DEFAULT_SHOW_ATTACHMENT_NAMES,
	decideAttachmentLabel,
	getAttachmentLabel,
	resolveAttachmentBasename,
	resolveAttachmentLabel,
	sanitizeAttachmentLabel,
	shouldShowAttachmentName,
} from "../src/attachment-labels";

describe("M1 attachment labels", () => {
	it("uses the global default and per-node override without changing node data", () => {
		const node = Object.freeze({ id: "file-node", type: "file", file: "Assets/Документы/отчёт 📄.pdf" });
		const metadata = {
			settings: { showAttachmentNames: false },
			localOverrides: { "file-node": { showAttachmentName: true } },
		};
		const before = JSON.stringify(node);
		expect(DEFAULT_SHOW_ATTACHMENT_NAMES).toBe(true);
		expect(shouldShowAttachmentName(node, metadata)).toBe(true);
		expect(resolveAttachmentLabel(node, metadata)).toBe("отчёт 📄.pdf");
		expect(JSON.stringify(node)).toBe(before);
		expect(resolveAttachmentLabel(node, { settings: { showAttachmentNames: false } })).toBeUndefined();
		expect(shouldShowAttachmentName(node, { settings: { showAttachmentNames: false } })).toBe(false);
	});

	it("supports document nodes, aliases, wikilinks, and basename paths", () => {
		expect(getAttachmentLabel({ id: "doc", type: "document", file: "C:\\vault\\Brief.docx", alias: "Brief" })).toBe("Brief");
		expect(getAttachmentLabel({ id: "doc", type: "document", file: "[[folder/Brief.docx|Краткое описание]]" })).toBe("Краткое описание");
		expect(resolveAttachmentBasename("/vault/資料/計画.pdf")).toBe("計画.pdf");
		expect(resolveAttachmentBasename("folder\\subfolder\\name.txt")).toBe("name.txt");
		expect(resolveAttachmentLabel({ id: "doc", type: "document", file: "folder/name.txt", alias: "" })).toBe("name.txt");
		expect(resolveAttachmentLabel({ id: "text", type: "text", file: "folder/name.txt" })).toBeUndefined();
	});

	it("rejects unsafe controls, bidi/path labels, and invalid Unicode", () => {
		expect(sanitizeAttachmentLabel("safe 名称 😀")).toBe("safe 名称 😀");
		expect(sanitizeAttachmentLabel("line\nname")).toBeUndefined();
		expect(sanitizeAttachmentLabel("evil\u202Ecod.exe")).toBeUndefined();
		expect(sanitizeAttachmentLabel("../secret.txt")).toBeUndefined();
		expect(resolveAttachmentBasename("../../secret.txt")).toBe("secret.txt");
		expect(resolveAttachmentBasename("..")).toBeUndefined();
		expect(resolveAttachmentBasename("folder/")).toBeUndefined();
		expect(sanitizeAttachmentLabel("\ud800")).toBeUndefined();
	});

	it("fails closed for hostile metadata and getters without mutating content", () => {
		const node = { id: "file", type: "file", file: "name.png" };
		const hostile = Object.create({ settings: { showAttachmentNames: false } }) as Record<string, unknown>;
		expect(shouldShowAttachmentName(node, hostile)).toBe(false);
		const throwing = { settings: { showAttachmentNames: false } } as Record<string, unknown>;
		Object.defineProperty(throwing, "localOverrides", {
			configurable: true,
			get: () => {
				throw new Error("hostile getter");
			},
		});
		expect(() => resolveAttachmentLabel(node, throwing)).not.toThrow();
		expect(resolveAttachmentLabel(node, throwing)).toBeUndefined();
		const revoked = Proxy.revocable({ id: "file", type: "file", file: "name.png" }, {});
		revoked.revoke();
		expect(() => decideAttachmentLabel(revoked.proxy)).not.toThrow();
		expect(decideAttachmentLabel(revoked.proxy)).toMatchObject({ visible: false, source: "invalid", valid: false });
	});
});

