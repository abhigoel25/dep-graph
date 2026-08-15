import type {
  CandidateCase,
  CandidateDecision,
  CandidateInferenceResult,
  DependencyCandidate,
  DeterministicSelectionResult,
  GraphEdge,
  SelectionRejectionReason,
} from "./types.js";

const DEFAULT_MINIMUM_SCORE = 14;
const DEFAULT_SCORE_WINDOW = 2;
const DEFAULT_MAX_EDGES_PER_INPUT = 4;
const GENERIC_CONTENT_LABELS = new Set(["name", "names"]);
const SUBJECT_STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "create",
  "add",
  "update",
  "delete",
  "remove",
  "get",
  "list",
  "search",
  "check",
  "assign",
  "approve",
  "cancel",
  "close",
  "download",
  "enable",
  "disable",
  "replace",
  "request",
  "upload",
  "for",
  "to",
  "of",
  "in",
  "on",
  "id",
  "number",
  "name",
  "sha",
  "ref",
  "repository",
  "user",
  "organization",
  "team",
]);

export interface DeterministicSelectionOptions {
  maxEdgesPerInput?: number;
  minimumScore?: number;
  scoreWindow?: number;
}

function compareCandidates(left: DependencyCandidate, right: DependencyCandidate): number {
  if (left.score !== right.score) return right.score - left.score;
  const byProducer = left.producerSlug.localeCompare(right.producerSlug, "en-US");
  return byProducer !== 0
    ? byProducer
    : left.outputPath.localeCompare(right.outputPath, "en-US");
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

function rejected(
  candidate: DependencyCandidate,
  reason: SelectionRejectionReason,
): CandidateDecision {
  return { candidate, accepted: false, reason };
}

function hasEvidence(candidate: DependencyCandidate, code: string): boolean {
  return candidate.evidence.some((feature) => feature.code === code);
}

function semanticTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((token) => token.length > 1 && !SUBJECT_STOP_WORDS.has(token))
      .map((token) =>
        token.endsWith("ies")
          ? `${token.slice(0, -3)}y`
          : token.endsWith("s") && !token.endsWith("ss")
            ? token.slice(0, -1)
            : token,
      ),
  );
}

function subjectMatchesLabel(candidate: DependencyCandidate): boolean {
  const producerTokens = semanticTokens(candidate.producerSlug);
  return [...semanticTokens(candidate.label)].some((token) => producerTokens.has(token));
}

function producerSubjectSupportedByConsumer(candidate: DependencyCandidate): boolean {
  const producerTokens = semanticTokens(candidate.producerSlug);
  const consumerTokens = semanticTokens(candidate.consumerSlug);
  return [...producerTokens].every((token) => consumerTokens.has(token));
}

function isDirectGenericOutput(candidate: DependencyCandidate): boolean {
  const containers = candidate.outputPath
    .split(".")
    .slice(0, -1)
    .map((segment) => segment.replace(/\[\]$/u, "").toLowerCase());
  return containers.every((segment) => ["data", "result", "response", "output"].includes(segment));
}

/**
 * Creation responses often expose the new resource through a generic `data.id`
 * or `data.number`. Their lexical score is deliberately modest, so permit them
 * only when independent semantic signals agree on resource and request scope.
 */
function isGuardedCreation(candidate: DependencyCandidate): boolean {
  return (
    candidate.score >= 9 &&
    hasEvidence(candidate, "creation_operation") &&
    hasEvidence(candidate, "producer_context_match") &&
    hasEvidence(candidate, "shared_scope") &&
    hasEvidence(candidate, "generic_output_penalty") &&
    subjectMatchesLabel(candidate) &&
    producerSubjectSupportedByConsumer(candidate) &&
    isDirectGenericOutput(candidate)
  );
}

function semanticRejection(
  candidate: DependencyCandidate,
): SelectionRejectionReason | undefined {
  const normalizedLabel = candidate.label.trim().toLowerCase();
  const isMutationLike =
    hasEvidence(candidate, "creation_operation") ||
    hasEvidence(candidate, "mutation_operation");

  // Names are usually user-authored content rather than stable identifiers.
  // Deterministic mode accepts them from discovery operations, but otherwise
  // abstains and leaves the ambiguous relationship to model adjudication.
  if (
    GENERIC_CONTENT_LABELS.has(normalizedLabel) &&
    !hasEvidence(candidate, "discovery_operation")
  ) {
    return "generic_content_field";
  }

  // A mutation response can contain many nested, incidental resources. Without
  // an explicit producer/input entity match, a high lexical score is unsafe.
  if (isMutationLike && !hasEvidence(candidate, "producer_context_match")) {
    return "producer_context_mismatch";
  }

  return undefined;
}

function selectCase(
  candidateCase: CandidateCase,
  minimumScore: number,
  scoreWindow: number,
  maxEdgesPerInput: number,
): CandidateDecision[] {
  const candidates = [...candidateCase.candidates].sort(compareCandidates);
  const bestScore = candidates[0]?.score ?? Number.NEGATIVE_INFINITY;
  let acceptedCount = 0;

  return candidates.map((candidate) => {
    const semanticReason = semanticRejection(candidate);
    if (semanticReason) return rejected(candidate, semanticReason);

    const guardedCreation = isGuardedCreation(candidate);
    if (candidate.score < minimumScore && !guardedCreation) {
      return rejected(candidate, "below_minimum_score");
    }
    if (candidate.score < bestScore - scoreWindow && !guardedCreation) {
      return rejected(candidate, "outside_score_window");
    }
    if (acceptedCount >= maxEdgesPerInput && !guardedCreation) {
      return rejected(candidate, "per_input_limit");
    }
    acceptedCount += 1;
    return { candidate, accepted: true };
  });
}

export function selectDeterministicEdges(
  inference: CandidateInferenceResult,
  options: DeterministicSelectionOptions = {},
): DeterministicSelectionResult {
  const minimumScore = options.minimumScore ?? DEFAULT_MINIMUM_SCORE;
  const scoreWindow = Math.max(0, options.scoreWindow ?? DEFAULT_SCORE_WINDOW);
  const maxEdgesPerInput = Math.max(
    1,
    options.maxEdgesPerInput ?? DEFAULT_MAX_EDGES_PER_INPUT,
  );
  const decisions = inference.cases.flatMap((candidateCase) =>
    selectCase(candidateCase, minimumScore, scoreWindow, maxEdgesPerInput),
  );

  const uniqueEdges = new Map<string, GraphEdge>();
  for (const decision of decisions) {
    if (!decision.accepted) continue;
    const edge: GraphEdge = {
      from: decision.candidate.producerSlug,
      to: decision.candidate.consumerSlug,
      label: decision.candidate.label,
    };
    uniqueEdges.set(edgeKey(edge), edge);
  }
  const edges = [...uniqueEdges.values()].sort(compareEdges);
  const casesWithAccepted = new Set(
    decisions
      .filter((decision) => decision.accepted)
      .map((decision) => `${decision.candidate.consumerSlug}\u0000${decision.candidate.label}`),
  );

  return {
    edges,
    decisions,
    stats: {
      cases: inference.cases.length,
      abstainedCases: inference.cases.length - casesWithAccepted.size,
      selectedEdges: edges.length,
      rejectedCandidates: decisions.filter((decision) => !decision.accepted).length,
    },
  };
}
