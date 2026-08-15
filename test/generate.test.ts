import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { normalizeCatalog } from "../src/catalog.js";
import { generateOffline } from "../src/generate.js";

describe("offline generation pipeline", () => {
  it("turns catalog schema evidence into a validated dependency graph", () => {
    const catalog = normalizeCatalog([
      {
        slug: "ACME_LIST_WIDGETS",
        toolkit: { slug: "acme" },
        tags: ["widgets", "readOnlyHint"],
        inputParameters: { type: "object", properties: {} },
        outputParameters: {
          type: "object",
          properties: {
            widgets: {
              type: "array",
              items: {
                type: "object",
                properties: { id: { type: "string", title: "Widget id" } },
              },
            },
          },
        },
      },
      {
        slug: "ACME_UPDATE_WIDGET",
        toolkit: { slug: "acme" },
        tags: ["widgets", "updateHint"],
        inputParameters: {
          type: "object",
          properties: { widget_id: { type: "string", title: "Widget id" } },
          required: ["widget_id"],
        },
        outputParameters: {
          type: "object",
          properties: { updated: { type: "boolean" } },
        },
      },
    ]);

    const result = generateOffline(catalog.tools);
    assert.deepEqual(result.graph, {
      nodes: [
        { id: "ACME_LIST_WIDGETS", service: "acme" },
        { id: "ACME_UPDATE_WIDGET", service: "acme" },
      ],
      edges: [
        { from: "ACME_LIST_WIDGETS", to: "ACME_UPDATE_WIDGET", label: "widget_id" },
      ],
    });
    assert.equal(result.selection.stats.selectedEdges, 1);
  });
});
