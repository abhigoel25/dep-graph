import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { selectDeterministicEdges } from "../src/selection.js";
import type {
  CandidateFeature,
  CandidateCase,
  CandidateInferenceResult,
  DependencyCandidate,
  FieldEvidence,
} from "../src/types.js";

const input: FieldEvidence = {
  name: "widget_id",
  path: "widget_id",
  pathSegments: ["widget_id"],
  types: ["string"],
  description: "Widget identifier.",
  title: "Widget Id",
  required: true,
  source: "input",
};

function feature(code: string): CandidateFeature {
  return { code, detail: code, weight: 1 };
}

function candidate(
  producerSlug: string,
  score: number,
  evidenceCodes: string[] = [],
  label = "widget_id",
): DependencyCandidate {
  return {
    producerSlug,
    consumerSlug: "ACME_UPDATE_WIDGET",
    label,
    outputPath: "data.widgets[].id",
    score,
    confidence: score >= 14 ? "high" : score >= 10 ? "medium" : "low",
    evidence: evidenceCodes.map(feature),
  };
}

function inference(candidates: DependencyCandidate[]): CandidateInferenceResult {
  const candidateCase: CandidateCase = {
    consumerSlug: "ACME_UPDATE_WIDGET",
    label: "widget_id",
    input,
    candidates,
  };
  return {
    cases: [candidateCase],
    stats: {
      tools: 5,
      requiredInputs: 1,
      identifierInputs: 1,
      indexedOutputs: candidates.length,
      candidateCases: 1,
      candidates: candidates.length,
    },
  };
}

describe("selectDeterministicEdges", () => {
  it("accepts near-best high-confidence producers and explains every rejection", () => {
    const result = selectDeterministicEdges(
      inference([
        candidate("ACME_SEARCH_WIDGETS", 18),
        candidate("ACME_LIST_WIDGETS", 17),
        candidate("ACME_GET_PROJECT", 15.5),
        candidate("ACME_CREATE_WIDGET", 12),
      ]),
    );

    assert.deepEqual(
      result.edges.map((edge) => edge.from),
      ["ACME_LIST_WIDGETS", "ACME_SEARCH_WIDGETS"],
    );
    assert.deepEqual(
      result.decisions.map((decision) => [decision.candidate.producerSlug, decision.reason]),
      [
        ["ACME_SEARCH_WIDGETS", undefined],
        ["ACME_LIST_WIDGETS", undefined],
        ["ACME_GET_PROJECT", "outside_score_window"],
        ["ACME_CREATE_WIDGET", "below_minimum_score"],
      ],
    );
  });

  it("caps accepted producers per required input", () => {
    const result = selectDeterministicEdges(
      inference([
        candidate("ACME_A", 20),
        candidate("ACME_B", 20),
        candidate("ACME_C", 20),
      ]),
      { maxEdgesPerInput: 2 },
    );

    assert.equal(result.edges.length, 2);
    assert.equal(result.decisions[2]?.reason, "per_input_limit");
  });

  it("abstains when all evidence is below the minimum", () => {
    const result = selectDeterministicEdges(inference([candidate("ACME_WEAK", 13.9)]));

    assert.deepEqual(result.edges, []);
    assert.deepEqual(result.stats, {
      cases: 1,
      abstainedCases: 1,
      selectedEdges: 0,
      rejectedCandidates: 1,
    });
  });

  it("deduplicates graph-equivalent selections and sorts output stably", () => {
    const duplicate = candidate("ACME_LIST_WIDGETS", 18);
    const result = selectDeterministicEdges(
      inference([
        { ...duplicate, outputPath: "data.items[].widget_id" },
        duplicate,
      ]),
    );

    assert.deepEqual(result.edges, [
      { from: "ACME_LIST_WIDGETS", to: "ACME_UPDATE_WIDGET", label: "widget_id" },
    ]);
    assert.equal(result.decisions.filter((decision) => decision.accepted).length, 2);
  });

  it("supports stricter caller-provided thresholds", () => {
    const result = selectDeterministicEdges(inference([candidate("ACME_LIST_WIDGETS", 18)]), {
      minimumScore: 19,
      scoreWindow: 0,
    });
    assert.deepEqual(result.edges, []);
  });

  it("recovers a low-scoring generic creation ID when independent context agrees", () => {
    const created = candidate("ACME_CREATE_WIDGET", 10, [
      "creation_operation",
      "producer_context_match",
      "shared_scope",
      "generic_output_penalty",
    ]);
    created.outputPath = "data.id";
    const result = selectDeterministicEdges(
      inference([
        candidate("ACME_LIST_WIDGETS", 21),
        created,
      ]),
    );

    assert.deepEqual(
      result.edges.map((edge) => edge.from),
      ["ACME_CREATE_WIDGET", "ACME_LIST_WIDGETS"],
    );
  });

  it("does not let the lexical cap suppress a semantically guarded creation", () => {
    const created = candidate("ACME_CREATE_WIDGET", 10, [
      "creation_operation",
      "producer_context_match",
      "shared_scope",
      "generic_output_penalty",
    ]);
    created.outputPath = "data.id";
    const result = selectDeterministicEdges(
      inference([
        candidate("ACME_LIST_WIDGETS", 21),
        candidate("ACME_SEARCH_WIDGETS", 21),
        created,
      ]),
      { maxEdgesPerInput: 1 },
    );

    assert.deepEqual(
      result.edges.map((edge) => edge.from),
      ["ACME_CREATE_WIDGET", "ACME_LIST_WIDGETS"],
    );
    assert.equal(result.decisions[1]?.reason, "per_input_limit");
  });

  it("does not recover an incidental generic ID from a different created subject", () => {
    const result = selectDeterministicEdges(
      inference([
        candidate("ACME_CREATE_MILESTONE", 10, [
          "creation_operation",
          "producer_context_match",
          "shared_scope",
          "generic_output_penalty",
        ]),
      ]),
    );

    assert.equal(result.decisions[0]?.reason, "below_minimum_score");
    assert.deepEqual(result.edges, []);
  });

  it("does not recover a generic ID nested beneath another resource", () => {
    const nested = candidate("ACME_CREATE_WIDGET", 10, [
      "creation_operation",
      "producer_context_match",
      "shared_scope",
      "generic_output_penalty",
    ]);
    nested.outputPath = "data.owner.id";

    const result = selectDeterministicEdges(inference([nested]));

    assert.equal(result.decisions[0]?.reason, "below_minimum_score");
    assert.deepEqual(result.edges, []);
  });

  it("does not recover a same-label ID from a conflicting resource qualifier", () => {
    const reaction = candidate("ACME_CREATE_COMMIT_REACTION", 10, [
      "creation_operation",
      "producer_context_match",
      "shared_scope",
      "generic_output_penalty",
    ], "reaction_id");
    reaction.consumerSlug = "ACME_DELETE_ISSUE_REACTION";
    reaction.outputPath = "data.id";

    const result = selectDeterministicEdges(inference([reaction]));

    assert.equal(result.decisions[0]?.reason, "below_minimum_score");
    assert.deepEqual(result.edges, []);
  });

  it("rejects incidental mutation output without producer-to-input context", () => {
    const result = selectDeterministicEdges(
      inference([
        candidate("ACME_UPDATE_ACCOUNT", 24, [
          "mutation_operation",
          "local_entity_match",
        ]),
      ]),
    );

    assert.equal(result.decisions[0]?.reason, "producer_context_mismatch");
    assert.deepEqual(result.edges, []);
  });

  it("abstains from treating mutation response names as deterministic identity", () => {
    const result = selectDeterministicEdges(
      inference([
        candidate(
          "ACME_ADD_COLLABORATOR",
          29,
          ["creation_operation", "producer_context_match", "shared_scope"],
          "names",
        ),
      ]),
    );

    assert.equal(result.decisions[0]?.reason, "generic_content_field");
    assert.deepEqual(result.edges, []);
  });
});
