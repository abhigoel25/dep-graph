import OpenAI from "openai";

import {
  buildAdjudicationBatches,
  MODEL_SYSTEM_PROMPT,
  renderAdjudicationPrompt,
  validateModelResponse,
} from "./model-protocol.js";
import { selectDeterministicEdges } from "./selection.js";
import type {
  AdjudicationBatch,
  ModelProtocolIssue,
  ValidatedModelDecision,
} from "./model-protocol.js";
import type {
  CandidateInferenceResult,
  GraphEdge,
  NormalizedTool,
} from "./types.js";

export const DEFAULT_MODEL = "openai/gpt-5.4";
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 300;
const DEFAULT_TIMEOUT_MS = 45_000;

export interface ModelCompletion {
  content: string;
  completionTokens: number;
  promptTokens: number;
}

export interface ModelTransport {
  complete(batch: AdjudicationBatch): Promise<ModelCompletion>;
}

export type AdjudicationMode = "mixed" | "offline" | "online";

export interface AdjudicationStats {
  batches: number;
  completedBatches: number;
  failedBatches: number;
  retries: number;
  modelCases: number;
  fallbackCases: number;
  selectedEdges: number;
  promptTokens: number;
  completionTokens: number;
}

export interface AdjudicationResult {
  mode: AdjudicationMode;
  edges: GraphEdge[];
  modelDecisions: ValidatedModelDecision[];
  issues: ModelProtocolIssue[];
  stats: AdjudicationStats;
}

export interface AdjudicationOptions {
  candidatesPerCase?: number;
  casesPerBatch?: number;
  concurrency?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface OpenAITransportOptions {
  apiKey: string;
  baseURL: string;
  model?: string;
  timeoutMs?: number;
}

class OpenAIModelTransport implements ModelTransport {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(options: OpenAITransportOptions) {
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      maxRetries: 0,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    this.model = options.model ?? DEFAULT_MODEL;
  }

  async complete(batch: AdjudicationBatch): Promise<ModelCompletion> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: MODEL_SYSTEM_PROMPT },
        { role: "user", content: renderAdjudicationPrompt(batch) },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    });
    const content = completion.choices[0]?.message.content;
    if (typeof content !== "string") {
      throw new Error("model returned no text content");
    }
    return {
      content,
      promptTokens: completion.usage?.prompt_tokens ?? 0,
      completionTokens: completion.usage?.completion_tokens ?? 0,
    };
  }
}

function configured(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function createModelTransportFromEnv(
  environment: NodeJS.ProcessEnv = process.env,
): ModelTransport | undefined {
  const apiKey = configured(environment.OPENAI_API_KEY);
  const baseURL = configured(environment.OPENAI_BASE_URL);
  if (!apiKey || !baseURL) return undefined;
  return new OpenAIModelTransport({
    apiKey,
    baseURL,
    model: configured(environment.DEPENDENCY_GRAPH_MODEL) ?? DEFAULT_MODEL,
  });
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

interface CompletedBatch {
  batch: AdjudicationBatch;
  completion?: ModelCompletion;
  attempts: number;
}

async function completeWithRetry(
  transport: ModelTransport,
  batch: AdjudicationBatch,
  maxRetries: number,
  retryDelayMs: number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<CompletedBatch> {
  let attempts = 0;
  while (attempts <= maxRetries) {
    attempts += 1;
    try {
      return { batch, completion: await transport.complete(batch), attempts };
    } catch {
      if (attempts > maxRetries) return { batch, attempts };
      await sleep(retryDelayMs * 2 ** (attempts - 1));
    }
  }
  return { batch, attempts };
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await operation(value);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  return results;
}

function compareEdges(left: GraphEdge, right: GraphEdge): number {
  const byProducer = left.from.localeCompare(right.from, "en-US");
  if (byProducer !== 0) return byProducer;
  const byConsumer = left.to.localeCompare(right.to, "en-US");
  return byConsumer !== 0 ? byConsumer : left.label.localeCompare(right.label, "en-US");
}

function edgeKey(edge: GraphEdge): string {
  return `${edge.from}\u0000${edge.to}\u0000${edge.label}`;
}

function modelEdges(decisions: ValidatedModelDecision[]): GraphEdge[] {
  return decisions.flatMap((decision) =>
    decision.acceptedCandidates.map((candidate) => ({
      from: candidate.producerSlug,
      to: candidate.consumerSlug,
      label: candidate.label,
    })),
  );
}

function fallbackEdges(
  batches: AdjudicationBatch[],
  fallbackCaseIds: Set<string>,
  inference: CandidateInferenceResult,
): GraphEdge[] {
  const cases = batches
    .flatMap((batch) => batch.cases)
    .filter((item) => fallbackCaseIds.has(item.caseId))
    .map((item) => item.source);
  if (cases.length === 0) return [];
  return selectDeterministicEdges({ ...inference, cases }).edges;
}

export async function adjudicateCandidates(
  inference: CandidateInferenceResult,
  tools: NormalizedTool[],
  transport: ModelTransport,
  options: AdjudicationOptions = {},
): Promise<AdjudicationResult> {
  const batchOptions: { casesPerBatch?: number; candidatesPerCase?: number } = {};
  if (options.casesPerBatch !== undefined) {
    batchOptions.casesPerBatch = options.casesPerBatch;
  }
  if (options.candidatesPerCase !== undefined) {
    batchOptions.candidatesPerCase = options.candidatesPerCase;
  }
  const batches = buildAdjudicationBatches(inference, tools, batchOptions);
  const maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS);
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
  const sleep = options.sleep ?? defaultSleep;
  const completed = await mapConcurrent(batches, concurrency, (batch) =>
    completeWithRetry(transport, batch, maxRetries, retryDelayMs, sleep),
  );

  const modelDecisions: ValidatedModelDecision[] = [];
  const issues: ModelProtocolIssue[] = [];
  const fallbackCaseIds = new Set<string>();
  let failedBatches = 0;
  let promptTokens = 0;
  let completionTokens = 0;

  for (const result of completed) {
    if (!result.completion) {
      failedBatches += 1;
      for (const item of result.batch.cases) fallbackCaseIds.add(item.caseId);
      issues.push({
        code: "request_failed",
        message: `${result.batch.batchId} failed after ${result.attempts} attempt(s)`,
      });
      continue;
    }

    promptTokens += result.completion.promptTokens;
    completionTokens += result.completion.completionTokens;
    const validation = validateModelResponse(result.completion.content, result.batch);
    modelDecisions.push(...validation.decisions);
    issues.push(...validation.issues);
    for (const caseId of validation.fallbackCaseIds) fallbackCaseIds.add(caseId);
  }

  const uniqueEdges = new Map<string, GraphEdge>();
  for (const edge of [
    ...modelEdges(modelDecisions),
    ...fallbackEdges(batches, fallbackCaseIds, inference),
  ]) {
    uniqueEdges.set(edgeKey(edge), edge);
  }
  const edges = [...uniqueEdges.values()].sort(compareEdges);
  const fallbackCases = fallbackCaseIds.size;
  const modelCases = inference.cases.length - fallbackCases;
  const mode: AdjudicationMode =
    fallbackCases === 0 ? "online" : modelCases === 0 ? "offline" : "mixed";

  return {
    mode,
    edges,
    modelDecisions,
    issues,
    stats: {
      batches: batches.length,
      completedBatches: batches.length - failedBatches,
      failedBatches,
      retries: completed.reduce((total, result) => total + result.attempts - 1, 0),
      modelCases,
      fallbackCases,
      selectedEdges: edges.length,
      promptTokens,
      completionTokens,
    },
  };
}
