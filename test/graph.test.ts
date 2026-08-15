import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { normalizeCatalog } from "../src/catalog.js";
import {
  assembleGraph,
  GraphIntegrityError,
  validateGraph,
  writeGraphAtomic,
} from "../src/graph.js";
import type { DependencyGraph, GraphEdge } from "../src/types.js";

const tools = normalizeCatalog([
  {
    slug: "ACME_UPDATE_WIDGET",
    toolkit: { slug: "acme" },
    inputParameters: {
      type: "object",
      properties: { widget_id: { type: "string" }, body: { type: "string" } },
      required: ["widget_id", "body"],
    },
  },
  {
    slug: "ACME_LIST_WIDGETS",
    toolkit: { slug: "acme" },
    inputParameters: { type: "object", properties: {} },
  },
]).tools;

function expectIntegrityIssues(
  graph: DependencyGraph,
  expectedCodes: GraphIntegrityError["issues"][number]["code"][],
): void {
  assert.throws(
    () => validateGraph(graph, tools),
    (error: unknown) => {
      assert.ok(error instanceof GraphIntegrityError);
      assert.deepEqual(
        error.issues.map((issue) => issue.code),
        expectedCodes,
      );
      return true;
    },
  );
}

describe("graph assembly and integrity", () => {
  it("builds stable catalog-derived nodes and sorted producer-to-consumer edges", () => {
    const graph = assembleGraph(tools, [
      { from: "ACME_LIST_WIDGETS", to: "ACME_UPDATE_WIDGET", label: "widget_id" },
    ]);

    assert.deepEqual(graph, {
      nodes: [
        { id: "ACME_LIST_WIDGETS", service: "acme" },
        { id: "ACME_UPDATE_WIDGET", service: "acme" },
      ],
      edges: [
        { from: "ACME_LIST_WIDGETS", to: "ACME_UPDATE_WIDGET", label: "widget_id" },
      ],
    });
  });

  it("deduplicates exact edges deterministically", () => {
    const edge: GraphEdge = {
      from: "ACME_LIST_WIDGETS",
      to: "ACME_UPDATE_WIDGET",
      label: "widget_id",
    };
    assert.deepEqual(assembleGraph(tools, [edge, { ...edge }]).edges, [edge]);
  });

  it("rejects dangling endpoints, self-edges, and non-required labels", () => {
    expectIntegrityIssues(
      {
        nodes: [
          { id: "ACME_LIST_WIDGETS" },
          { id: "ACME_UPDATE_WIDGET" },
        ],
        edges: [
          { from: "ACME_UNKNOWN", to: "ACME_UPDATE_WIDGET", label: "optional" },
          { from: "ACME_LIST_WIDGETS", to: "ACME_MISSING", label: "widget_id" },
          { from: "ACME_UPDATE_WIDGET", to: "ACME_UPDATE_WIDGET", label: "widget_id" },
        ],
      },
      [
        "producer_not_found",
        "label_not_required",
        "consumer_not_found",
        "label_not_required",
        "self_edge",
      ],
    );
  });

  it("rejects duplicate and non-catalog nodes", () => {
    expectIntegrityIssues(
      {
        nodes: [
          { id: "ACME_LIST_WIDGETS" },
          { id: "ACME_LIST_WIDGETS" },
          { id: "FABRICATED_TOOL" },
        ],
        edges: [],
      },
      ["duplicate_node", "node_not_found"],
    );
  });
});

describe("atomic graph writing", () => {
  it("replaces an existing graph and leaves no temporary file", () => {
    const directory = mkdtempSync(join(tmpdir(), "dep-graph-output-"));
    const path = join(directory, "dependency_graph.json");
    const graph = assembleGraph(tools, []);

    try {
      writeFileSync(path, "stale", "utf8");
      writeGraphAtomic(graph, path);
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), graph);
      assert.deepEqual(readdirSync(directory), ["dependency_graph.json"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
