import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadCatalogFile } from "../src/catalog.js";
import { indexOutputs, indexRequiredInputs } from "../src/schema.js";
import type { NormalizedTool } from "../src/types.js";

const github = loadCatalogFile("github_catalog.json");

function tool(slug: string): NormalizedTool {
  const match = github.tools.find((candidate) => candidate.slug === slug);
  assert.ok(match, `expected ${slug} in the supplied GitHub catalog`);
  return match;
}

describe("supplied GitHub catalog schema evidence", () => {
  it("loads every supplied tool without normalization warnings", () => {
    assert.equal(github.tools.length, 893);
    assert.deepEqual(github.warnings, []);
  });

  it("finds the required issue number consumed by issue comments", () => {
    const consumer = tool("GITHUB_CREATE_AN_ISSUE_COMMENT");
    const index = indexRequiredInputs(consumer.inputSchema);
    const issueNumber = index.fields.find((field) => field.name === "issue_number");

    assert.ok(issueNumber);
    assert.equal(issueNumber.path, "issue_number");
    assert.deepEqual(issueNumber.types, ["integer"]);
    assert.equal(issueNumber.required, true);
    assert.deepEqual(index.warnings, []);
  });

  it("finds nested issue numbers produced by listing repository issues", () => {
    const producer = tool("GITHUB_LIST_REPOSITORY_ISSUES");
    const index = indexOutputs(producer.outputSchema);
    const issueNumber = index.fields.find(
      (field) => field.path === "data.issues[].number",
    );

    assert.ok(issueNumber);
    assert.equal(issueNumber.name, "number");
    assert.deepEqual(issueNumber.types, ["integer"]);
    assert.deepEqual(index.warnings, []);
  });

  it("finds the required pull number consumed by pull-request merging", () => {
    const consumer = tool("GITHUB_MERGE_A_PULL_REQUEST");
    const index = indexRequiredInputs(consumer.inputSchema);
    const pullNumber = index.fields.find((field) => field.name === "pull_number");

    assert.ok(pullNumber);
    assert.equal(pullNumber.path, "pull_number");
    assert.deepEqual(pullNumber.types, ["integer"]);
    assert.equal(pullNumber.required, true);
    assert.deepEqual(index.warnings, []);
  });

  it("finds nested pull-request numbers produced by listing pull requests", () => {
    const producer = tool("GITHUB_LIST_PULL_REQUESTS");
    const index = indexOutputs(producer.outputSchema);
    const pullNumber = index.fields.find(
      (field) => field.path === "data.pull_requests[].number",
    );

    assert.ok(pullNumber);
    assert.equal(pullNumber.name, "number");
    assert.deepEqual(pullNumber.types, ["integer"]);
    assert.deepEqual(index.warnings, []);
  });
});
