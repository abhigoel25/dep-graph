import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { indexOutputs, indexRequiredInputs } from "../src/schema.js";

describe("indexRequiredInputs", () => {
  it("indexes only inputs that are required through their entire object path", () => {
    const result = indexRequiredInputs({
      type: "object",
      properties: {
        direct_id: { type: "string", description: "A required direct identifier." },
        optional_id: { type: "string" },
        request: {
          type: "object",
          required: ["nested_id"],
          properties: { nested_id: { type: "integer", title: "Nested Id" } },
        },
        optional_request: {
          type: "object",
          required: ["hidden_id"],
          properties: { hidden_id: { type: "string" } },
        },
      },
      required: ["direct_id", "request"],
    });

    assert.deepEqual(
      result.fields.map((field) => [field.path, field.types, field.required]),
      [
        ["direct_id", ["string"], true],
        ["request.nested_id", ["integer"], true],
      ],
    );
    assert.equal(result.fields[0]?.description, "A required direct identifier.");
    assert.equal(result.fields[1]?.title, "Nested Id");
  });

  it("resolves required inputs through local definitions", () => {
    const result = indexRequiredInputs({
      $ref: "#/$defs/Request",
      $defs: {
        Request: {
          type: "object",
          properties: { widget_id: { type: "string" } },
          required: ["widget_id"],
        },
      },
    });

    assert.deepEqual(result.fields.map((field) => field.path), ["widget_id"]);
    assert.deepEqual(result.warnings, []);
  });

  it("combines properties and required fields declared beside a reference", () => {
    const result = indexRequiredInputs({
      type: "object",
      properties: {
        request: {
          $ref: "#/$defs/BaseRequest",
          properties: { operation_id: { type: "integer" } },
          required: ["operation_id"],
        },
      },
      required: ["request"],
      $defs: {
        BaseRequest: {
          type: "object",
          properties: { resource_id: { type: "string" } },
          required: ["resource_id"],
        },
      },
    });

    assert.deepEqual(
      result.fields.map((field) => field.path),
      ["request.operation_id", "request.resource_id"],
    );
  });

  it("deduplicates equivalent fields contributed by schema unions", () => {
    const result = indexRequiredInputs({
      anyOf: [
        {
          type: "object",
          properties: { resource_id: { type: "string" } },
          required: ["resource_id"],
        },
        {
          type: "object",
          properties: { resource_id: { type: "integer" } },
          required: ["resource_id"],
        },
      ],
    });

    assert.equal(result.fields.length, 1);
    assert.deepEqual(result.fields[0]?.types, ["integer", "string"]);
  });

  it("retains base properties declared beside a union", () => {
    const result = indexRequiredInputs({
      type: "object",
      properties: { scope_id: { type: "string" } },
      required: ["scope_id"],
      anyOf: [
        {
          type: "object",
          properties: { issue_number: { type: "integer" } },
          required: ["issue_number"],
        },
        {
          type: "object",
          properties: { pull_number: { type: "integer" } },
          required: ["pull_number"],
        },
      ],
    });

    assert.deepEqual(
      result.fields.map((field) => field.path),
      ["issue_number", "pull_number", "scope_id"],
    );
  });
});

describe("indexOutputs", () => {
  it("walks response wrappers, references, objects, and arrays to meaningful leaves", () => {
    const result = indexOutputs({
      type: "object",
      properties: {
        data: { $ref: "#/$defs/ListIssuesResponse" },
        error: { type: "string" },
        successful: { type: "boolean" },
      },
      $defs: {
        ListIssuesResponse: {
          type: "object",
          properties: {
            issues: {
              type: "array",
              description: "Repository issues.",
              items: { $ref: "#/$defs/Issue" },
            },
          },
        },
        Issue: {
          type: "object",
          properties: {
            number: {
              type: "integer",
              title: "Issue number",
              description: "The repository-scoped issue number.",
            },
            title: { type: "string" },
          },
        },
      },
    });

    assert.deepEqual(
      result.fields.map((field) => field.path),
      ["data.issues[].number", "data.issues[].title"],
    );
    assert.equal(result.fields[0]?.name, "number");
    assert.deepEqual(result.fields[0]?.types, ["integer"]);
    assert.equal(result.fields[0]?.title, "Issue number");
    assert.deepEqual(result.warnings, []);
  });

  it("keeps primitive arrays as leaf fields with item type and array path evidence", () => {
    const result = indexOutputs({
      type: "object",
      properties: {
        ids: {
          type: "array",
          description: "Resource identifiers.",
          items: { type: "string" },
        },
      },
    });

    assert.deepEqual(result.fields, [
      {
        name: "ids",
        path: "ids[]",
        pathSegments: ["ids[]"],
        types: ["string"],
        description: "Resource identifiers.",
        title: "",
        required: false,
        source: "output",
      },
    ]);
  });

  it("supports tuple-style arrays and merges their possible item types", () => {
    const result = indexOutputs({
      type: "object",
      properties: {
        values: { type: "array", items: [{ type: "string" }, { type: "integer" }] },
      },
    });

    assert.equal(result.fields.length, 1);
    assert.deepEqual(result.fields[0]?.types, ["integer", "string"]);
  });

  it("reports unresolved references instead of silently inventing fields", () => {
    const result = indexOutputs({
      type: "object",
      properties: { widget: { $ref: "#/$defs/Missing" } },
    });

    assert.deepEqual(result.fields, []);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0]?.code, "unresolved_ref");
    assert.equal(result.warnings[0]?.path, "widget");
  });

  it("terminates recursive references and retains fields found before the cycle", () => {
    const result = indexOutputs({
      type: "object",
      properties: { root: { $ref: "#/$defs/Node" } },
      $defs: {
        Node: {
          type: "object",
          properties: {
            id: { type: "string" },
            children: { type: "array", items: { $ref: "#/$defs/Node" } },
          },
        },
      },
    });

    assert.deepEqual(result.fields.map((field) => field.path), ["root.id"]);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0]?.code, "cyclic_ref");
    assert.equal(result.warnings[0]?.path, "root.children[]");
  });

  it("decodes escaped JSON Pointer segments", () => {
    const result = indexOutputs({
      type: "object",
      properties: { value: { $ref: "#/$defs/a~1b~0c" } },
      $defs: { "a/b~c": { type: "string" } },
    });

    assert.deepEqual(result.fields.map((field) => field.path), ["value"]);
    assert.deepEqual(result.warnings, []);
  });
});
