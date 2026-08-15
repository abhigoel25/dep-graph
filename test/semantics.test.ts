import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  entityTokens,
  identityTokens,
  isGenericIdentityName,
  isIdentifierLike,
  normalizeName,
  tokenOverlap,
  tokenize,
} from "../src/semantics.js";

describe("semantic token normalization", () => {
  it("normalizes common schema naming conventions consistently", () => {
    assert.deepEqual(tokenize("pullRequestID"), ["pull", "request", "id"]);
    assert.deepEqual(tokenize("PullRequestIds"), ["pull", "request", "id"]);
    assert.deepEqual(tokenize("pull-request identifiers"), ["pull", "request", "id"]);
    assert.equal(normalizeName("pullRequestID"), "pull_request_id");
  });

  it("singularizes conservative entity plurals", () => {
    assert.deepEqual(tokenize("repositories/issues/statuses"), [
      "repository",
      "issue",
      "status",
    ]);
    assert.deepEqual(tokenize("classes"), ["class"]);
  });

  it("separates generic identity tokens from entity context", () => {
    assert.deepEqual(identityTokens("issue_number"), ["number"]);
    assert.deepEqual(
      entityTokens("data.issues[].number", "Repository issue response"),
      ["issue", "repository"],
    );
  });

  it("recognizes identifier-like fields from names or schema explanations", () => {
    assert.equal(isIdentifierLike("workflow_id"), true);
    assert.equal(isIdentifierLike("target", "The unique identifier for the deployment."), true);
    assert.equal(isIdentifierLike("body", "Markdown content supplied by the user."), false);
  });

  it("distinguishes generic from entity-qualified identity names", () => {
    assert.equal(isGenericIdentityName("id"), true);
    assert.equal(isGenericIdentityName("resource_identifier"), false);
    assert.equal(isGenericIdentityName("pull_number"), false);
  });

  it("returns stable unique overlaps", () => {
    assert.deepEqual(tokenOverlap(["pull", "request", "pull"], ["request", "issue", "pull"]), [
      "pull",
      "request",
    ]);
  });
});
