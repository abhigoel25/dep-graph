import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  CatalogError,
  loadCatalogFile,
  normalizeCatalog,
} from "../src/catalog.js";

const widget = {
  slug: "ACME_GET_WIDGET",
  name: "Get widget",
  description: "Gets a widget by ID.",
  tags: ["widgets", "readOnlyHint"],
  toolkit: { slug: "acme" },
  version: "20260815_01",
  isDeprecated: false,
  inputParameters: {
    type: "object",
    properties: { widget_id: { type: "string" } },
    required: ["widget_id"],
  },
  outputParameters: {
    type: "object",
    properties: { widget: { type: "object" } },
  },
};

function expectCatalogError(code: CatalogError["code"], callback: () => unknown): void {
  assert.throws(callback, (error: unknown) => {
    assert.ok(error instanceof CatalogError);
    assert.equal(error.code, code);
    return true;
  });
}

describe("normalizeCatalog", () => {
  it("normalizes a top-level array into a stable intermediate representation", () => {
    const result = normalizeCatalog([widget], "fixture.json");

    assert.equal(result.source, "fixture.json");
    assert.deepEqual(result.warnings, []);
    assert.deepEqual(result.tools, [
      {
        slug: "ACME_GET_WIDGET",
        name: "Get widget",
        description: "Gets a widget by ID.",
        tags: ["widgets", "readOnlyHint"],
        toolkit: "acme",
        version: "20260815_01",
        deprecated: false,
        inputSchema: widget.inputParameters,
        outputSchema: widget.outputParameters,
      },
    ]);
  });

  it("accepts tools and items wrappers", () => {
    assert.equal(normalizeCatalog({ tools: [widget] }).tools.length, 1);
    assert.equal(normalizeCatalog({ items: [widget] }).tools.length, 1);
  });

  it("supports common fallback schema and slug locations", () => {
    const result = normalizeCatalog([
      {
        function: {
          name: "ACME_RUN_WIDGET",
          parameters: { type: "object", properties: { id: { type: "string" } } },
          outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
        },
      },
    ]);

    assert.equal(result.tools[0]?.slug, "ACME_RUN_WIDGET");
    assert.equal(result.tools[0]?.name, "ACME_RUN_WIDGET");
    assert.deepEqual(result.tools[0]?.inputSchema, {
      type: "object",
      properties: { id: { type: "string" } },
    });
    assert.deepEqual(result.tools[0]?.outputSchema, {
      type: "object",
      properties: { ok: { type: "boolean" } },
    });
  });

  it("ignores malformed entries but reports actionable warnings", () => {
    const result = normalizeCatalog([null, 42, {}, widget]);

    assert.equal(result.tools.length, 1);
    assert.deepEqual(
      result.warnings.map((warning) => warning.code),
      ["malformed_tool", "malformed_tool", "malformed_tool"],
    );
    assert.deepEqual(
      result.warnings.map((warning) => warning.index),
      [0, 1, 2],
    );
  });

  it("deduplicates slugs case-insensitively and prefers an active entry", () => {
    const result = normalizeCatalog([
      { ...widget, isDeprecated: true, description: "old" },
      { ...widget, slug: "acme_get_widget", description: "current" },
      { ...widget, description: "later duplicate" },
    ]);

    assert.equal(result.tools.length, 1);
    assert.equal(result.tools[0]?.slug, "acme_get_widget");
    assert.equal(result.tools[0]?.description, "current");
    assert.equal(result.warnings.length, 2);
    assert.ok(result.warnings.every((warning) => warning.code === "duplicate_slug"));
  });

  it("sorts tools by slug for reproducible downstream output", () => {
    const result = normalizeCatalog([
      { slug: "Z_TOOL" },
      { slug: "A_TOOL" },
      { slug: "M_TOOL" },
    ]);

    assert.deepEqual(
      result.tools.map((tool) => tool.slug),
      ["A_TOOL", "M_TOOL", "Z_TOOL"],
    );
  });

  it("rejects unsupported and empty catalogs with typed errors", () => {
    expectCatalogError("unsupported_shape", () => normalizeCatalog({ data: [] }));
    expectCatalogError("empty_catalog", () => normalizeCatalog([]));
    expectCatalogError("empty_catalog", () => normalizeCatalog([null, {}]));
  });
});

describe("loadCatalogFile", () => {
  it("reads and normalizes a catalog from disk", () => {
    const directory = mkdtempSync(join(tmpdir(), "dep-graph-catalog-"));
    const path = join(directory, "catalog.json");

    try {
      writeFileSync(path, JSON.stringify({ tools: [widget] }), "utf8");
      const result = loadCatalogFile(path);
      assert.equal(result.source, path);
      assert.equal(result.tools[0]?.slug, widget.slug);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("distinguishes path, read, and JSON failures", () => {
    expectCatalogError("invalid_path", () => loadCatalogFile("   "));
    expectCatalogError("read_failed", () => loadCatalogFile("missing-catalog.json"));

    const directory = mkdtempSync(join(tmpdir(), "dep-graph-invalid-"));
    const path = join(directory, "catalog.json");
    try {
      writeFileSync(path, "{not-json", "utf8");
      expectCatalogError("invalid_json", () => loadCatalogFile(path));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
