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
    if (candidate.score < minimumScore) {
      return rejected(candidate, "below_minimum_score");
    }
    if (candidate.score < bestScore - scoreWindow) {
      return rejected(candidate, "outside_score_window");
    }
    if (acceptedCount >= maxEdgesPerInput) {
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
