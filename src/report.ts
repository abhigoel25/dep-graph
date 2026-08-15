import type { GenerationResult } from "./generate.js";

function edgeKey(from: string, to: string, label: string): string {
  return `${from}\u0000${to}\u0000${label}`;
}

export function buildInferenceReport(result: GenerationResult) {
  const selected = new Set(
    result.graph.edges.map((edge) => edgeKey(edge.from, edge.to, edge.label)),
  );
  const modelDecisions = result.decisionPath === "adjudicator"
    ? new Map(result.adjudication.modelDecisions.map((item) => [item.caseId, item]))
    : new Map();
  const issuesByCase = new Map<string, string[]>();
  if (result.decisionPath === "adjudicator") {
    for (const issue of result.adjudication.issues) {
      const key = issue.caseId ?? "run";
      const messages = issuesByCase.get(key) ?? [];
      messages.push(`${issue.code}: ${issue.message}`);
      issuesByCase.set(key, messages);
    }
  }

  const cases = result.inference.cases.map((item, index) => {
    const caseId = `case_${index.toString().padStart(4, "0")}`;
    const modelDecision = modelDecisions.get(caseId);
    return {
      case_id: caseId,
      consumer: item.consumerSlug,
      required_input: {
        name: item.input.name,
        path: item.input.path,
        types: item.input.types,
        description: item.input.description,
      },
      decision_source: result.decisionPath === "deterministic"
        ? "deterministic"
        : modelDecision
          ? "model"
          : "fallback",
      rationale: modelDecision?.reason ?? null,
      issues: issuesByCase.get(caseId) ?? [],
      candidates: item.candidates.map((candidate, rank) => ({
        rank: rank + 1,
        producer: candidate.producerSlug,
        output_path: candidate.outputPath,
        score: candidate.score,
        confidence: candidate.confidence,
        presented_to_model: result.decisionPath === "adjudicator" ? rank < 6 : false,
        selected: selected.has(
          edgeKey(candidate.producerSlug, candidate.consumerSlug, candidate.label),
        ),
        evidence: candidate.evidence,
      })),
    };
  });

  return {
    schema_version: 1,
    run: {
      mode: result.mode,
      decision_path: result.decisionPath,
      graph_nodes: result.graph.nodes.length,
      graph_edges: result.graph.edges.length,
      inference: result.inference.stats,
      adjudication: result.decisionPath === "adjudicator"
        ? result.adjudication.stats
        : null,
      issues: result.decisionPath === "adjudicator"
        ? result.adjudication.issues
        : [],
    },
    cases,
  };
}
