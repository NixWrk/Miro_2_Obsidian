/**
 * Phase 1a contract check: this plugin agrees with `miro2obsidian/schemas/v1/miro-canvas.schema.json`
 * and its fixture manifest, both owned by miro2obsidian at the repository root.
 *
 * The plugin never reads the schema file to validate a board at runtime (it has its
 * own dependency-free reader in metadata.ts); this test only keeps the two
 * descriptions of `miroCanvas` from silently drifting apart.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { KNOWN_METADATA_FIELDS, validateMiroCanvasMetadata } from "../src/metadata";

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const SCHEMAS_V1_DIR = join(TESTS_DIR, "..", "..", "..", "miro2obsidian", "schemas", "v1");
const FIXTURES_DIR = join(SCHEMAS_V1_DIR, "fixtures");

interface ManifestEntry {
  readonly id: string;
  readonly path: string;
  readonly miro_canvas_validator: { readonly valid: boolean; readonly status: string } | null;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadManifest(): readonly ManifestEntry[] {
  const manifest = readJson(join(FIXTURES_DIR, "manifest.json")) as { fixtures: ManifestEntry[] };
  return manifest.fixtures;
}

describe("schema fixtures agree with validateMiroCanvasMetadata", () => {
  const manifest = loadManifest();

  it("lists at least one fixture with an expected validator result", () => {
    expect(manifest.some((entry) => entry.miro_canvas_validator !== null)).toBe(true);
  });

  for (const entry of manifest) {
    if (entry.miro_canvas_validator === null) {
      continue;
    }

    it(`gives the manifest's expected result for ${entry.id}`, () => {
      const document = readJson(join(FIXTURES_DIR, entry.path)) as Record<string, unknown>;
      expect(document).toHaveProperty("miroCanvas");

      const result = validateMiroCanvasMetadata(document.miroCanvas);
      const expected = entry.miro_canvas_validator!;
      expect({ valid: result.valid, status: result.status }).toEqual(expected);
    });
  }

  it("only exercises fixture files the manifest actually lists", () => {
    const onDisk = new Set<string>();
    for (const bucket of ["valid", "invalid"]) {
      for (const name of readdirSync(join(FIXTURES_DIR, bucket))) {
        if (name.endsWith(".canvas")) {
          onDisk.add(`${bucket}/${name}`);
        }
      }
    }
    const listed = new Set(manifest.map((entry) => entry.path));
    expect(onDisk).toEqual(listed);
  });
});

describe("miro-canvas.schema.json declares exactly the plugin's known metadata fields", () => {
  it("matches METADATA_FIELDS field-for-field", () => {
    const schema = readJson(join(SCHEMAS_V1_DIR, "miro-canvas.schema.json")) as {
      properties: Record<string, unknown>;
    };
    const schemaFields = new Set(Object.keys(schema.properties));
    const pluginFields = new Set(KNOWN_METADATA_FIELDS);
    expect(schemaFields).toEqual(pluginFields);
  });
});
