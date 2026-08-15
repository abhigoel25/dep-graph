import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildAdjudicationBatches,
  MODEL_SYSTEM_PROMPT,
  renderAdjudicationPrompt,
  validateModelResponse,
} from "../src/model-protocol.js";
import type {
  CandidateCase,
  CandidateInferenceResult,
  DependencyCandidate,
  FieldEvidence,
  NormalizedTool,
} from "../src/types.js";

const input: FieldEvidence = {
  name: "widget_id",
  path: "widget_id",
  pathSegments: ["widget_id"],
  types: ["string"],
  description: "The unique widget identifier.",
  title: "Widget Id",
  required: true,
  source: "input",
};

function candidate(producerSlug: string, score = 18): DependencyCandidate {
  return {
    producerSlug,
    consumerSlug: "ACME_UPDATE_WIDGET",
    label: "widget_id",
    outputPath: "data.widgets[].id",
    score,
    confidence: "high",
    evidence: [
      { code: "identity_match", detail: "shared identity token: id", weight: 4 },
      { code: "local_entity_match", detail: "nearest container matches widget", weight: 6 },
    ],
  };
}

function fixture(caseCount = 1): { inference: CandidateInferenceResult; tools: NormalizedTool[] } {
  const candidates = [candidate("ACME_LIST_WIDGETS"), candidate("ACME_SEARCH_WIDGETS", 17)];
  const cases: CandidateCase[] = Array.from({ length: caseCount }, (_, index) => ({
    consumerSlug: "ACME_UPDATE_WIDGET",
    label: index === 0 ? "widget_id" : `widget_id_${index}`,
    input: index === 0 ? input : { ...input, name: `widget_id_${index}`, path: `widget_id_${index}` },
    candidates,
  }));
  const tools: NormalizedTool[] = [
    {
      slug: "ACME_UPDATE_WIDGET",
      name: "Update widget",
      description: "Updates a widget using its identifier.",
      tags: ["widgets"],
      deprecated: false,
      inputSchema: {},
      outputSchema: {},
    },
    ...["ACME_LIST_WIDGETS", "ACME_SEARCH_WIDGETS"].map((slug) => ({
      slug,
      name: slug === "ACME_LIST_WIDGETS" ? "List widgets" : "Search widgets",
      description: `${"x".repeat(300)} returns widget identifiers`,
      tags: ["widgets"],
      deprecated: false,
      inputSchema: {},
      outputSchema: {},
    })),
  ];
  return {
    tools,
    inference: {
      cases,
      stats: {
        tools: tools.length,
        requiredInputs: caseCount,
        identifierInputs: caseCount,
        indexedOutputs: 2,
        candidateCases: caseCount,
        candidates: caseCount * 2,
      },
    },
  };
}

describe("model adjudication batching", () => {
  it("creates stable bounded batches and compact closed candidate payloads", () => {
    const { inference, tools } = fixture(5);
    const batches = buildAdjudicationBatches(inference, tools, {
      casesPerBatch: 2,
      candidatesPerCase: 1,
    });

    assert.deepEqual(
      batches.map((batch) => [batch.batchId, batch.cases.map((item) => item.caseId)]),
      [
        ["batch_000", ["case_0000", "case_0001"]],
        ["batch_001", ["case_0002", "case_0003"]],
        ["batch_002", ["case_0004"]],
      ],
    );
    assert.equal(batches[0]?.cases[0]?.candidates.length, 1);
    assert.ok(
      (batches[0]?.cases[0]?.payload.candidates[0]?.producer_description.length ?? 0) <= 240,
    );
  });

  it("renders instructions and candidate data without environment credentials", () => {
    const { inference, tools } = fixture();
    const batch = buildAdjudicationBatches(inference, tools)[0]!;
    const prompt = renderAdjudicationPrompt(batch);

    assert.match(MODEL_SYSTEM_PROMPT, /choose only supplied/i);
    assert.match(prompt, /ACME_LIST_WIDGETS/);
    assert.doesNotMatch(prompt, /OPENAI_API_KEY|api[_ -]?key/i);
  });
});

describe("model response validation", () => {
  it("accepts zero, one, or multiple supplied producers", () => {
    const { inference, tools } = fixture(2);
    const batch = buildAdjudicationBatches(inference, tools)[0]!;
    const result = validateModelResponse(
      JSON.stringify({
        decisions: [
          {
            case_id: "case_0000",
            accepted_producers: ["ACME_LIST_WIDGETS", "ACME_SEARCH_WIDGETS"],
            reason: "Both discover widget IDs.",
          },
          { case_id: "case_0001", accepted_producers: [], reason: "Insufficient evidence." },
        ],
      }),
      batch,
    );

    assert.deepEqual(
      result.decisions.map((decision) => [
        decision.caseId,
        decision.acceptedCandidates.map((candidate) => candidate.producerSlug),
      ]),
      [
        ["case_0000", ["ACME_LIST_WIDGETS", "ACME_SEARCH_WIDGETS"]],
        ["case_0001", []],
      ],
    );
    assert.deepEqual(result.fallbackCaseIds, []);
    assert.deepEqual(result.issues, []);
  });

  it("falls back an entire case when the model invents a producer", () => {
    const { inference, tools } = fixture();
    const batch = buildAdjudicationBatches(inference, tools)[0]!;
    const result = validateModelResponse(
      JSON.stringify({
        decisions: [
          {
            case_id: "case_0000",
            accepted_producers: ["ACME_LIST_WIDGETS", "FABRICATED_TOOL"],
          },
        ],
      }),
      batch,
    );

    assert.deepEqual(result.decisions, []);
    assert.deepEqual(result.fallbackCaseIds, ["case_0000"]);
    assert.equal(result.issues[0]?.code, "invalid_producers");
  });

  it("isolates duplicate and missing cases while preserving valid decisions", () => {
    const { inference, tools } = fixture(3);
    const batch = buildAdjudicationBatches(inference, tools)[0]!;
    const result = validateModelResponse(
      JSON.stringify({
        decisions: [
          { case_id: "case_0000", accepted_producers: ["ACME_LIST_WIDGETS"] },
          { case_id: "case_0000", accepted_producers: [] },
          { case_id: "case_0001", accepted_producers: ["ACME_SEARCH_WIDGETS"] },
          { case_id: "case_9999", accepted_producers: [] },
        ],
      }),
      batch,
    );

    assert.deepEqual(result.decisions.map((decision) => decision.caseId), ["case_0001"]);
    assert.deepEqual(result.fallbackCaseIds, ["case_0000", "case_0002"]);
    assert.deepEqual(
      result.issues.map((issue) => issue.code),
      ["duplicate_case", "unknown_case", "missing_case"],
    );
  });

  it("rejects malformed or prose-wrapped JSON for the whole batch", () => {
    const { inference, tools } = fixture(2);
    const batch = buildAdjudicationBatches(inference, tools)[0]!;

    for (const content of ["not json", "```json\n{\"decisions\":[]}\n```", "{}"] ) {
      const result = validateModelResponse(content, batch);
      assert.deepEqual(result.decisions, []);
      assert.deepEqual(result.fallbackCaseIds, ["case_0000", "case_0001"]);
    }
  });
});
