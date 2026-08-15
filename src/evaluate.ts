import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { inferDependencyCandidates } from "./candidates.js";
import { loadCatalogFile } from "./catalog.js";
import { generateOffline } from "./generate.js";
import type { DependencyGraph, GraphEdge, NormalizedTool } from "./types.js";

interface GoldCase {
  from: string;
  to: string;
  label: string;
  expected: boolean;
  rationale: string;
}

interface GoldFile {
  schema_version: number;
  description: string;
  cases: GoldCase[];
}

function edgeKey(edge: Pick<GraphEdge, "from" | "to" | "label">): string {
  return `${edge.from}\u0000${edge.to}\u0000${edge.label}`;
}

function loadJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function weakComponentCount(nodeIds: string[], edges: GraphEdge[]): number {
  const parent = new Map(nodeIds.map((id) => [id, id]));
  const find = (id: string): string => {
    const current = parent.get(id) ?? id;
    if (current === id) return id;
    const root = find(current);
    parent.set(id, root);
    return root;
  };
  for (const edge of edges) {
    const left = find(edge.from);
    const right = find(edge.to);
    if (left !== right) parent.set(left, right);
  }
  return new Set(nodeIds.map(find)).size;
}

export function evaluateGraph(
  tools: NormalizedTool[],
  graph: DependencyGraph,
  gold: GoldFile,
) {
  const startedAt = performance.now();
  const catalogSlugs = new Set(tools.map((tool) => tool.slug));
  const nodeIds = graph.nodes.map((node) => node.id);
  const graphNodeSet = new Set(nodeIds);
  const graphEdges = new Set(graph.edges.map(edgeKey));
  const inference = inferDependencyCandidates(tools);
  const candidateEdges = new Set(
    inference.cases.flatMap((item) =>
      item.candidates.map((candidate) =>
        edgeKey({
          from: candidate.producerSlug,
          to: candidate.consumerSlug,
          label: candidate.label,
        }),
      ),
    ),
  );
  const offline = generateOffline(tools).graph;
  const offlineEdges = new Set(offline.edges.map(edgeKey));
  const duplicateNodes = nodeIds.length - new Set(nodeIds).size;
  const duplicateEdges = graph.edges.length - graphEdges.size;
  const danglingEdges = graph.edges.filter(
    (edge) => !graphNodeSet.has(edge.from) || !graphNodeSet.has(edge.to),
  ).length;
  const selfEdges = graph.edges.filter((edge) => edge.from === edge.to).length;
  const degree = new Map<string, number>();
  for (const edge of graph.edges) degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
  const isolatedNodes = nodeIds.filter(
    (id) => !graph.edges.some((edge) => edge.from === id || edge.to === id),
  ).length;
  const goldResults = gold.cases.map((item) => {
    const key = edgeKey(item);
    const selected = graphEdges.has(key);
    return {
      ...item,
      candidate_retrieved: candidateEdges.has(key),
      selected,
      passed: selected === item.expected,
    };
  });
  const positives = goldResults.filter((item) => item.expected);
  const negatives = goldResults.filter((item) => !item.expected);
  const onlineOnly = [...graphEdges].filter((key) => !offlineEdges.has(key)).length;
  const offlineOnly = [...offlineEdges].filter((key) => !graphEdges.has(key)).length;
  const intersection = [...graphEdges].filter((key) => offlineEdges.has(key)).length;

  return {
    schema_version: 1,
    catalog: {
      tools: tools.length,
      identifier_inputs: inference.stats.identifierInputs,
      indexed_outputs: inference.stats.indexedOutputs,
      candidate_cases: inference.stats.candidateCases,
      candidates: inference.stats.candidates,
    },
    graph: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      provenance_ratio: graph.nodes.length === 0
        ? 1
        : graph.nodes.filter((node) => catalogSlugs.has(node.id)).length / graph.nodes.length,
      labeled_edge_ratio: graph.edges.length === 0
        ? 1
        : graph.edges.filter((edge) => edge.label.length > 0).length / graph.edges.length,
      duplicate_nodes: duplicateNodes,
      duplicate_edges: duplicateEdges,
      dangling_edges: danglingEdges,
      self_edges: selfEdges,
      isolated_nodes: isolatedNodes,
      weak_components: weakComponentCount(nodeIds, graph.edges),
      max_producer_out_degree: Math.max(0, ...degree.values()),
      hub_edge_share: graph.edges.length === 0
        ? 0
        : Math.max(0, ...degree.values()) / graph.edges.length,
    },
    gold: {
      cases: goldResults.length,
      passed: goldResults.filter((item) => item.passed).length,
      accuracy: goldResults.filter((item) => item.passed).length / goldResults.length,
      positive_candidate_recall: positives.filter((item) => item.candidate_retrieved).length / positives.length,
      positive_selection_recall: positives.filter((item) => item.selected).length / positives.length,
      negative_rejection_rate: negatives.filter((item) => !item.selected).length / negatives.length,
      results: goldResults,
    },
    comparison: {
      offline_edges: offline.edges.length,
      online_edges: graph.edges.length,
      intersection,
      online_only: onlineOnly,
      offline_only: offlineOnly,
      jaccard: intersection / (intersection + onlineOnly + offlineOnly),
    },
    evaluation_duration_ms: Math.round(performance.now() - startedAt),
  };
}

function main() {
  const [, , catalogPath, graphPath, outputPath] = process.argv;
  if (!catalogPath || !graphPath) {
    throw new Error("usage: npm run evaluate -- <catalog.json> <graph.json> [report.json]");
  }
  const tools = loadCatalogFile(catalogPath).tools;
  const graph = loadJson<DependencyGraph>(graphPath);
  const gold = loadJson<GoldFile>("evaluation/github-gold.json");
  const report = evaluateGraph(tools, graph, gold);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) {
    writeFileSync(outputPath, serialized, "utf8");
    process.stdout.write(
      `${JSON.stringify({
        output: outputPath,
        nodes: report.graph.nodes,
        edges: report.graph.edges,
        gold_accuracy: report.gold.accuracy,
        positive_selection_recall: report.gold.positive_selection_recall,
        negative_rejection_rate: report.gold.negative_rejection_rate,
      })}\n`,
    );
  } else {
    process.stdout.write(serialized);
  }
  if (report.graph.provenance_ratio !== 1 || report.graph.dangling_edges > 0) process.exitCode = 1;
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entrypoint === import.meta.url) main();
