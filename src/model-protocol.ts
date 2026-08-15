import type {
  CandidateInferenceResult,
  CandidateCase,
  DependencyCandidate,
  NormalizedTool,
} from "./types.js";

const DEFAULT_CASES_PER_BATCH = 20;
const DEFAULT_CANDIDATES_PER_CASE = 6;
const DESCRIPTION_LIMIT = 240;

export const MODEL_SYSTEM_PROMPT = `You validate prerequisite relationships between tools.
Each case contains one required consumer input and a closed list of producer candidates.
Select a producer only when running it can expose the exact real-world value needed by the consumer.
Reject counts, metrics, nested related-resource identifiers, wrong scopes, and merely similar names.
Several producers may be valid. Selecting none is correct when evidence is insufficient.
You must choose only supplied case IDs and producer slugs. Return JSON only in this shape:
{"decisions":[{"case_id":"case_0000","accepted_producers":["TOOL_SLUG"],"reason":"brief explanation"}]}
Return one decision for every case, preserving its case_id.`;

export interface ModelCandidatePayload {
  producer_slug: string;
  producer_name: string;
  producer_description: string;
  output_path: string;
  evidence_score: number;
  evidence: string[];
}

export interface ModelCasePayload {
  case_id: string;
  consumer_slug: string;
  consumer_name: string;
  consumer_description: string;
  required_input: {
    name: string;
    path: string;
    types: string[];
    title: string;
    description: string;
  };
  candidates: ModelCandidatePayload[];
}

export interface AdjudicationCase {
  caseId: string;
  source: CandidateCase;
  candidates: DependencyCandidate[];
  payload: ModelCasePayload;
}

export interface AdjudicationBatch {
  batchId: string;
  cases: AdjudicationCase[];
}

export interface ModelProtocolIssue {
  code:
    | "duplicate_case"
    | "invalid_decisions"
    | "invalid_json"
    | "invalid_producers"
    | "malformed_decision"
    | "missing_case"
    | "request_failed"
    | "unknown_case";
  message: string;
  caseId?: string;
}

export interface ValidatedModelDecision {
  caseId: string;
  acceptedCandidates: DependencyCandidate[];
  reason: string;
}

export interface ModelValidationResult {
  decisions: ValidatedModelDecision[];
  fallbackCaseIds: string[];
  issues: ModelProtocolIssue[];
}

export interface AdjudicationBatchOptions {
  candidatesPerCase?: number;
  casesPerBatch?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactText(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= DESCRIPTION_LIMIT) return compact;
  return `${compact.slice(0, DESCRIPTION_LIMIT - 1)}…`;
}

function toolMap(tools: NormalizedTool[]): Map<string, NormalizedTool> {
  return new Map(tools.map((tool) => [tool.slug, tool]));
}

function evidenceSummary(candidate: DependencyCandidate): string[] {
  return [...candidate.evidence]
    .sort((left, right) => Math.abs(right.weight) - Math.abs(left.weight))
    .slice(0, 5)
    .map((feature) => `${feature.code} (${feature.weight > 0 ? "+" : ""}${feature.weight}): ${feature.detail}`);
}

function buildCase(
  source: CandidateCase,
  caseId: string,
  toolsBySlug: Map<string, NormalizedTool>,
  candidatesPerCase: number,
): AdjudicationCase {
  const consumer = toolsBySlug.get(source.consumerSlug);
  const candidates = source.candidates.slice(0, candidatesPerCase);
  const payload: ModelCasePayload = {
    case_id: caseId,
    consumer_slug: source.consumerSlug,
    consumer_name: consumer?.name ?? source.consumerSlug,
    consumer_description: compactText(consumer?.description ?? ""),
    required_input: {
      name: source.input.name,
      path: source.input.path,
      types: source.input.types,
      title: source.input.title,
      description: compactText(source.input.description),
    },
    candidates: candidates.map((candidate) => {
      const producer = toolsBySlug.get(candidate.producerSlug);
      return {
        producer_slug: candidate.producerSlug,
        producer_name: producer?.name ?? candidate.producerSlug,
        producer_description: compactText(producer?.description ?? ""),
        output_path: candidate.outputPath,
        evidence_score: candidate.score,
        evidence: evidenceSummary(candidate),
      };
    }),
  };
  return { caseId, source, candidates, payload };
}

export function buildAdjudicationBatches(
  inference: CandidateInferenceResult,
  tools: NormalizedTool[],
  options: AdjudicationBatchOptions = {},
): AdjudicationBatch[] {
  const casesPerBatch = Math.max(1, options.casesPerBatch ?? DEFAULT_CASES_PER_BATCH);
  const candidatesPerCase = Math.max(
    1,
    options.candidatesPerCase ?? DEFAULT_CANDIDATES_PER_CASE,
  );
  const toolsBySlug = toolMap(tools);
  const cases = inference.cases.map((source, index) =>
    buildCase(
      source,
      `case_${index.toString().padStart(4, "0")}`,
      toolsBySlug,
      candidatesPerCase,
    ),
  );

  const batches: AdjudicationBatch[] = [];
  for (let index = 0; index < cases.length; index += casesPerBatch) {
    batches.push({
      batchId: `batch_${batches.length.toString().padStart(3, "0")}`,
      cases: cases.slice(index, index + casesPerBatch),
    });
  }
  return batches;
}

export function renderAdjudicationPrompt(batch: AdjudicationBatch): string {
  return `Evaluate every case in this batch:\n${JSON.stringify(
    { batch_id: batch.batchId, cases: batch.cases.map((item) => item.payload) },
    null,
    2,
  )}`;
}

function fallbackAll(
  batch: AdjudicationBatch,
  issue: ModelProtocolIssue,
): ModelValidationResult {
  return {
    decisions: [],
    fallbackCaseIds: batch.cases.map((item) => item.caseId),
    issues: [issue],
  };
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return undefined;
  }
  return value;
}

export function validateModelResponse(
  content: string,
  batch: AdjudicationBatch,
): ModelValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    return fallbackAll(batch, {
      code: "invalid_json",
      message: `model response for ${batch.batchId} was not JSON`,
    });
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.decisions)) {
    return fallbackAll(batch, {
      code: "invalid_decisions",
      message: `model response for ${batch.batchId} did not contain a decisions array`,
    });
  }

  const casesById = new Map(batch.cases.map((item) => [item.caseId, item]));
  const decisionsById = new Map<string, ValidatedModelDecision>();
  const fallbackIds = new Set<string>();
  const issues: ModelProtocolIssue[] = [];

  for (const rawDecision of parsed.decisions) {
    if (!isRecord(rawDecision) || typeof rawDecision.case_id !== "string") {
      issues.push({ code: "malformed_decision", message: "model returned a malformed decision" });
      continue;
    }

    const caseId = rawDecision.case_id;
    const adjudicationCase = casesById.get(caseId);
    if (!adjudicationCase) {
      issues.push({
        code: "unknown_case",
        caseId,
        message: `model invented unknown case ${caseId}`,
      });
      continue;
    }
    if (decisionsById.has(caseId) || fallbackIds.has(caseId)) {
      decisionsById.delete(caseId);
      fallbackIds.add(caseId);
      issues.push({
        code: "duplicate_case",
        caseId,
        message: `model returned more than one decision for ${caseId}`,
      });
      continue;
    }

    const producerSlugs = stringArray(rawDecision.accepted_producers);
    if (!producerSlugs) {
      fallbackIds.add(caseId);
      issues.push({
        code: "malformed_decision",
        caseId,
        message: `accepted_producers for ${caseId} was not a string array`,
      });
      continue;
    }

    const candidatesByProducer = new Map(
      adjudicationCase.candidates.map((candidate) => [candidate.producerSlug, candidate]),
    );
    const invalidProducers = producerSlugs.filter((slug) => !candidatesByProducer.has(slug));
    if (invalidProducers.length > 0) {
      fallbackIds.add(caseId);
      issues.push({
        code: "invalid_producers",
        caseId,
        message: `model selected non-candidate producer(s) for ${caseId}: ${invalidProducers.join(", ")}`,
      });
      continue;
    }

    const acceptedCandidates = [...new Set(producerSlugs)].map(
      (slug) => candidatesByProducer.get(slug)!,
    );
    decisionsById.set(caseId, {
      caseId,
      acceptedCandidates,
      reason: typeof rawDecision.reason === "string" ? compactText(rawDecision.reason) : "",
    });
  }

  for (const adjudicationCase of batch.cases) {
    if (decisionsById.has(adjudicationCase.caseId) || fallbackIds.has(adjudicationCase.caseId)) {
      continue;
    }
    fallbackIds.add(adjudicationCase.caseId);
    issues.push({
      code: "missing_case",
      caseId: adjudicationCase.caseId,
      message: `model omitted ${adjudicationCase.caseId}`,
    });
  }

  return {
    decisions: [...decisionsById.values()].filter((decision) => !fallbackIds.has(decision.caseId)),
    fallbackCaseIds: [...fallbackIds].sort((left, right) => left.localeCompare(right, "en-US")),
    issues,
  };
}
