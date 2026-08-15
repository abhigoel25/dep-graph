import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { inferDependencyCandidates } from "../src/candidates.js";
import { loadCatalogFile } from "../src/catalog.js";
import { assembleGraph } from "../src/graph.js";
import { selectDeterministicEdges } from "../src/selection.js";

const github = loadCatalogFile("github_catalog.json");
const inferred = inferDependencyCandidates(github.tools);
const selected = selectDeterministicEdges(inferred);
const graph = assembleGraph(github.tools, selected.edges);

function candidateCase(consumerSlug: string, label: string) {
  const match = inferred.cases.find(
    (item) => item.consumerSlug === consumerSlug && item.label === label,
  );
  assert.ok(match, `expected candidate case ${consumerSlug}:${label}`);
  return match;
}

describe("supplied GitHub catalog candidate inference", () => {
  it("bounds retrieval while retaining substantial identifier coverage", () => {
    assert.equal(inferred.stats.tools, 893);
    assert.ok(inferred.stats.requiredInputs > inferred.stats.identifierInputs);
    assert.ok(inferred.stats.identifierInputs > 500);
    assert.ok(inferred.stats.candidateCases > 500);
    assert.ok(inferred.stats.indexedOutputs > 20_000);
    assert.ok(inferred.cases.every((item) => item.candidates.length <= 8));
  });

  it("ranks list-repository-issues first for the comment issue number", () => {
    const issue = candidateCase("GITHUB_CREATE_AN_ISSUE_COMMENT", "issue_number");
    const best = issue.candidates[0];

    assert.equal(best?.producerSlug, "GITHUB_LIST_REPOSITORY_ISSUES");
    assert.equal(best.outputPath, "data.issues[].number");
    assert.equal(best.confidence, "high");
    assert.ok(issue.candidates.every((candidate) => candidate.outputPath.endsWith("number")));
  });

  it("rejects get-an-issue because it already requires the issue number", () => {
    const issue = candidateCase("GITHUB_CREATE_AN_ISSUE_COMMENT", "issue_number");
    assert.equal(
      issue.candidates.some((candidate) => candidate.producerSlug === "GITHUB_GET_AN_ISSUE"),
      false,
    );
  });

  it("retains list-pull-requests as a strongest merge precursor", () => {
    const pull = candidateCase("GITHUB_MERGE_A_PULL_REQUEST", "pull_number");
    const listPulls = pull.candidates.find(
      (candidate) => candidate.producerSlug === "GITHUB_LIST_PULL_REQUESTS",
    );

    assert.ok(listPulls);
    assert.equal(listPulls.outputPath, "data.pull_requests[].number");
    assert.equal(listPulls.score, pull.candidates[0]?.score);
    assert.equal(listPulls.confidence, "high");
  });

  it("assembles a non-empty integrity-checked graph with both canonical edges", () => {
    assert.equal(graph.nodes.length, 893);
    assert.ok(graph.edges.length > 1_000);
    assert.ok(
      graph.edges.some(
        (edge) =>
          edge.from === "GITHUB_LIST_REPOSITORY_ISSUES" &&
          edge.to === "GITHUB_CREATE_AN_ISSUE_COMMENT" &&
          edge.label === "issue_number",
      ),
    );
    assert.ok(
      graph.edges.some(
        (edge) =>
          edge.from === "GITHUB_LIST_PULL_REQUESTS" &&
          edge.to === "GITHUB_MERGE_A_PULL_REQUEST" &&
          edge.label === "pull_number",
      ),
    );
  });
});
