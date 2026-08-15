import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { inferDependencyCandidates } from "../src/candidates.js";
import { normalizeCatalog } from "../src/catalog.js";
import type { JsonSchema, NormalizedTool } from "../src/types.js";

function schema(
  properties: Record<string, JsonSchema>,
  required: string[] = [],
): JsonSchema {
  return { type: "object", properties, required };
}

function rawTool(
  slug: string,
  inputSchema: JsonSchema,
  outputSchema: JsonSchema,
  tags: string[] = [],
): Record<string, unknown> {
  return {
    slug,
    name: slug.toLocaleLowerCase("en-US").replace(/_/g, " "),
    inputParameters: inputSchema,
    outputParameters: outputSchema,
    tags,
    toolkit: { slug: "acme" },
  };
}

function tools(...raw: Record<string, unknown>[]): NormalizedTool[] {
  return normalizeCatalog(raw).tools;
}

function issueFixture(): NormalizedTool[] {
  const context = {
    owner: { type: "string" },
    repository: { type: "string" },
  };
  return tools(
    rawTool(
      "ACME_LIST_REPOSITORY_ISSUES",
      schema(context, ["owner", "repository"]),
      schema({
        data: {
          type: "object",
          properties: {
            issues: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  number: { type: "integer", title: "Issue number" },
                  comments: { type: "integer", description: "Number of comments on the issue." },
                  milestone: {
                    type: "object",
                    properties: { number: { type: "integer", title: "Milestone number" } },
                  },
                },
              },
            },
          },
        },
      }),
      ["issues", "readOnlyHint"],
    ),
    rawTool(
      "ACME_GET_REPOSITORY_ISSUE",
      schema({ ...context, issue_number: { type: "integer" } }, [
        "owner",
        "repository",
        "issue_number",
      ]),
      schema({
        data: {
          type: "object",
          properties: {
            issue: {
              type: "object",
              properties: { number: { type: "integer", title: "Issue number" } },
            },
          },
        },
      }),
      ["issues", "readOnlyHint"],
    ),
    rawTool(
      "ACME_LIST_MILESTONES",
      schema(context, ["owner", "repository"]),
      schema({
        milestones: {
          type: "array",
          items: {
            type: "object",
            properties: { number: { type: "integer", title: "Milestone number" } },
          },
        },
      }),
      ["milestones", "readOnlyHint"],
    ),
    rawTool(
      "ACME_CREATE_ISSUE_COMMENT",
      schema(
        {
          ...context,
          issue_number: { type: "integer", title: "Issue number" },
          body: { type: "string" },
        },
        ["owner", "repository", "issue_number", "body"],
      ),
      schema({ id: { type: "integer", title: "Comment id" } }),
      ["issues", "comments"],
    ),
  );
}

describe("inferDependencyCandidates", () => {
  it("ranks a direct entity number above a nested related-entity number", () => {
    const result = inferDependencyCandidates(issueFixture());
    const candidateCase = result.cases.find(
      (item) => item.consumerSlug === "ACME_CREATE_ISSUE_COMMENT" && item.label === "issue_number",
    );

    assert.ok(candidateCase);
    assert.equal(candidateCase.candidates[0]?.producerSlug, "ACME_LIST_REPOSITORY_ISSUES");
    assert.equal(candidateCase.candidates[0]?.outputPath, "data.issues[].number");
    assert.ok(
      candidateCase.candidates[0]?.score >
        (candidateCase.candidates.find((candidate) =>
          candidate.outputPath.includes("milestone.number"),
        )?.score ?? Number.NEGATIVE_INFINITY),
    );
    assert.equal(
      candidateCase.candidates.some((candidate) => candidate.outputPath.endsWith(".comments")),
      false,
    );
  });

  it("rejects circular producers that already require the target value", () => {
    const result = inferDependencyCandidates(issueFixture());
    const candidateCase = result.cases.find((item) => item.label === "issue_number");

    assert.ok(candidateCase);
    assert.equal(
      candidateCase.candidates.some(
        (candidate) => candidate.producerSlug === "ACME_GET_REPOSITORY_ISSUE",
      ),
      false,
    );
  });

  it("does not infer dependencies for user-authored content fields", () => {
    const result = inferDependencyCandidates(issueFixture());
    assert.equal(result.cases.some((item) => item.label === "body"), false);
  });

  it("rejects incompatible output types", () => {
    const fixture = tools(
      rawTool("ACME_LIST_JOBS", schema({}), schema({ job_id: { type: "string" } }), ["jobs"]),
      rawTool(
        "ACME_CANCEL_JOB",
        schema({ job_id: { type: "integer" } }, ["job_id"]),
        schema({ ok: { type: "boolean" } }),
        ["jobs"],
      ),
    );

    assert.deepEqual(inferDependencyCandidates(fixture).cases, []);
  });

  it("uses field context to disambiguate generic IDs", () => {
    const fixture = tools(
      rawTool(
        "ACME_SEARCH_WIDGETS",
        schema({ query: { type: "string" } }, ["query"]),
        schema({
          widgets: {
            type: "array",
            items: { type: "object", properties: { id: { type: "string" } } },
          },
        }),
        ["widgets"],
      ),
      rawTool(
        "ACME_SEARCH_PROJECTS",
        schema({ query: { type: "string" } }, ["query"]),
        schema({
          projects: {
            type: "array",
            items: { type: "object", properties: { id: { type: "string" } } },
          },
        }),
        ["projects"],
      ),
      rawTool(
        "ACME_UPDATE_WIDGET",
        schema({ target: { type: "string", title: "Widget ID" } }, ["target"]),
        schema({ ok: { type: "boolean" } }),
        ["widgets"],
      ),
    );

    const candidateCase = inferDependencyCandidates(fixture).cases.find(
      (item) => item.consumerSlug === "ACME_UPDATE_WIDGET",
    );
    assert.ok(candidateCase);
    assert.equal(candidateCase.candidates[0]?.producerSlug, "ACME_SEARCH_WIDGETS");
    assert.equal(
      candidateCase.candidates.some((candidate) => candidate.producerSlug === "ACME_SEARCH_PROJECTS"),
      false,
    );
  });

  it("is stable under catalog reordering and unrelated additions", () => {
    const fixture = issueFixture();
    const baseline = inferDependencyCandidates(fixture);
    const reordered = inferDependencyCandidates([...fixture].reverse());
    const extended = inferDependencyCandidates([
      ...fixture,
      ...tools(rawTool("ACME_PING", schema({}), schema({ ok: { type: "boolean" } }))),
    ]);

    assert.deepEqual(reordered.cases, baseline.cases);
    assert.deepEqual(extended.cases, baseline.cases);
  });

  it("bounds candidates per input and reports retrieval statistics", () => {
    const result = inferDependencyCandidates(issueFixture(), { topK: 1 });
    assert.ok(result.cases.every((candidateCase) => candidateCase.candidates.length <= 1));
    assert.equal(result.stats.tools, 4);
    assert.ok(result.stats.requiredInputs > result.stats.identifierInputs);
    assert.equal(
      result.stats.candidates,
      result.cases.reduce((total, candidateCase) => total + candidateCase.candidates.length, 0),
    );
  });
});
