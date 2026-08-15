import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ModelTransport } from "../src/adjudicator.js";
import { normalizeCatalog } from "../src/catalog.js";
import { generateGraph, generateOffline } from "../src/generate.js";
import { buildInferenceReport } from "../src/report.js";

function catalogFixture() {
  return normalizeCatalog([
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
}

describe("offline generation pipeline", () => {
  it("turns catalog schema evidence into a validated dependency graph", () => {
    const catalog = catalogFixture();

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

  it("preserves the deterministic path when no transport is configured", async () => {
    const catalog = catalogFixture();
    const result = await generateGraph(catalog.tools);

    assert.equal(result.decisionPath, "deterministic");
    assert.equal(result.mode, "offline");
    assert.equal(result.graph.edges.length, 1);
  });

  it("uses closed model decisions before the graph integrity firewall", async () => {
    const catalog = catalogFixture();
    const transport: ModelTransport = {
      async complete(batch) {
        return {
          content: JSON.stringify({
            decisions: batch.cases.map((item) => ({
              case_id: item.caseId,
              accepted_producers: [],
              reason: "The model conservatively abstained.",
            })),
          }),
          promptTokens: 20,
          completionTokens: 10,
        };
      },
    };

    const result = await generateGraph(catalog.tools, transport);

    assert.equal(result.decisionPath, "adjudicator");
    assert.equal(result.mode, "online");
    assert.deepEqual(result.graph.edges, []);
    assert.equal(result.adjudication.stats.modelCases, 1);
    const report = buildInferenceReport(result);
    assert.equal(report.run.mode, "online");
    assert.equal(report.cases[0]?.decision_source, "model");
    assert.equal(report.cases[0]?.candidates[0]?.selected, false);
    assert.match(report.cases[0]?.rationale ?? "", /conservatively abstained/i);
  });
});
