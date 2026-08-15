import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  adjudicateCandidates,
  createModelTransportFromEnv,
  DEFAULT_MODEL,
} from "../src/adjudicator.js";
import type {
  ModelCompletion,
  ModelTransport,
} from "../src/adjudicator.js";
import type { AdjudicationBatch } from "../src/model-protocol.js";
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
  description: "Widget identifier.",
  title: "Widget Id",
  required: true,
  source: "input",
};

function candidate(producerSlug: string, consumerSlug: string, label: string): DependencyCandidate {
  return {
    producerSlug,
    consumerSlug,
    label,
    outputPath: "data.widgets[].id",
    score: 18,
    confidence: "high",
    evidence: [],
  };
}

function fixture(caseCount = 2): { inference: CandidateInferenceResult; tools: NormalizedTool[] } {
  const cases: CandidateCase[] = Array.from({ length: caseCount }, (_, index) => {
    const consumerSlug = `ACME_UPDATE_WIDGET_${index}`;
    const label = `widget_id_${index}`;
    return {
      consumerSlug,
      label,
      input: { ...input, name: label, path: label },
      candidates: [
        candidate("ACME_LIST_WIDGETS", consumerSlug, label),
        candidate("ACME_SEARCH_WIDGETS", consumerSlug, label),
      ],
    };
  });
  const slugs = [
    "ACME_LIST_WIDGETS",
    "ACME_SEARCH_WIDGETS",
    ...cases.map((item) => item.consumerSlug),
  ];
  const tools = slugs.map((slug) => ({
    slug,
    name: slug,
    description: "Widget operation.",
    tags: ["widgets"],
    deprecated: false,
    inputSchema: {},
    outputSchema: {},
  }));
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

function completionFor(batch: AdjudicationBatch): ModelCompletion {
  return {
    content: JSON.stringify({
      decisions: batch.cases.map((item) => ({
        case_id: item.caseId,
        accepted_producers: ["ACME_LIST_WIDGETS"],
        reason: "The list returns widget IDs.",
      })),
    }),
    promptTokens: 100,
    completionTokens: 20,
  };
}

class FakeTransport implements ModelTransport {
  calls = 0;
  active = 0;
  maxActive = 0;

  constructor(
    private readonly responder: (batch: AdjudicationBatch, call: number) => Promise<ModelCompletion>,
  ) {}

  async complete(batch: AdjudicationBatch): Promise<ModelCompletion> {
    this.calls += 1;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      return await this.responder(batch, this.calls);
    } finally {
      this.active -= 1;
    }
  }
}

const noSleep = async (): Promise<void> => undefined;

describe("model transport configuration", () => {
  it("uses the evaluated frontier model as the explicit default", () => {
    assert.equal(DEFAULT_MODEL, "openai/gpt-5.4");
  });

  it("requires both the assessment key and base URL", () => {
    assert.equal(createModelTransportFromEnv({}), undefined);
    assert.equal(createModelTransportFromEnv({ OPENAI_API_KEY: "key" }), undefined);
    assert.equal(createModelTransportFromEnv({ OPENAI_BASE_URL: "https://example.test" }), undefined);
    assert.ok(
      createModelTransportFromEnv({
        OPENAI_API_KEY: "key",
        OPENAI_BASE_URL: "https://example.test",
      }),
    );
  });
});

describe("adjudicateCandidates", () => {
  it("uses valid model decisions and tracks usage", async () => {
    const { inference, tools } = fixture(2);
    const transport = new FakeTransport(async (batch) => completionFor(batch));
    const result = await adjudicateCandidates(inference, tools, transport, {
      casesPerBatch: 1,
      concurrency: 2,
      sleep: noSleep,
    });

    assert.equal(result.mode, "online");
    assert.deepEqual(
      result.edges.map((edge) => edge.from),
      ["ACME_LIST_WIDGETS", "ACME_LIST_WIDGETS"],
    );
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.stats, {
      batches: 2,
      completedBatches: 2,
      failedBatches: 0,
      retries: 0,
      modelCases: 2,
      fallbackCases: 0,
      selectedEdges: 2,
      promptTokens: 200,
      completionTokens: 40,
    });
    assert.equal(transport.maxActive, 2);
  });

  it("retries transient failures and then preserves the model result", async () => {
    const { inference, tools } = fixture(1);
    const transport = new FakeTransport(async (batch, call) => {
      if (call < 3) throw new Error("temporary failure");
      return completionFor(batch);
    });
    const delays: number[] = [];
    const result = await adjudicateCandidates(inference, tools, transport, {
      maxRetries: 2,
      retryDelayMs: 10,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
      },
    });

    assert.equal(result.mode, "online");
    assert.equal(result.stats.retries, 2);
    assert.deepEqual(delays, [10, 20]);
  });

  it("falls back only failed batches and reports mixed mode", async () => {
    const { inference, tools } = fixture(2);
    const transport = new FakeTransport(async (batch) => {
      if (batch.batchId === "batch_001") throw new Error("unavailable");
      return completionFor(batch);
    });
    const result = await adjudicateCandidates(inference, tools, transport, {
      casesPerBatch: 1,
      maxRetries: 0,
      sleep: noSleep,
    });

    assert.equal(result.mode, "mixed");
    assert.equal(result.stats.modelCases, 1);
    assert.equal(result.stats.fallbackCases, 1);
    assert.equal(result.stats.failedBatches, 1);
    assert.equal(result.issues[0]?.code, "request_failed");
    assert.deepEqual(
      result.edges.filter((edge) => edge.to === "ACME_UPDATE_WIDGET_1").map((edge) => edge.from),
      ["ACME_LIST_WIDGETS", "ACME_SEARCH_WIDGETS"],
    );
  });

  it("uses deterministic fallback when a response violates the protocol", async () => {
    const { inference, tools } = fixture(1);
    const transport = new FakeTransport(async () => ({
      content: "not-json",
      promptTokens: 50,
      completionTokens: 3,
    }));
    const result = await adjudicateCandidates(inference, tools, transport, { sleep: noSleep });

    assert.equal(result.mode, "offline");
    assert.equal(result.stats.fallbackCases, 1);
    assert.equal(result.issues[0]?.code, "invalid_json");
    assert.equal(result.edges.length, 2);
  });

  it("never exceeds configured concurrency", async () => {
    const { inference, tools } = fixture(5);
    const transport = new FakeTransport(
      (batch) => new Promise((resolve) => setTimeout(() => resolve(completionFor(batch)), 5)),
    );
    await adjudicateCandidates(inference, tools, transport, {
      casesPerBatch: 1,
      concurrency: 2,
      sleep: noSleep,
    });
    assert.equal(transport.maxActive, 2);
  });
});
