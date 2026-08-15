import { existsSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { indexRequiredInputs } from "./schema.js";
import type {
  DependencyGraph,
  GraphEdge,
  GraphIntegrityIssue,
  GraphNode,
  NormalizedTool,
} from "./types.js";

export class GraphIntegrityError extends Error {
  readonly issues: GraphIntegrityIssue[];

  constructor(issues: GraphIntegrityIssue[]) {
    super(`graph integrity check failed with ${issues.length} issue(s)`);
    this.name = "GraphIntegrityError";
    this.issues = issues;
  }
}

function compareNodes(left: GraphNode, right: GraphNode): number {
  return left.id.localeCompare(right.id, "en-US");
}

function compareEdges(left: GraphEdge, right: GraphEdge): number {
  const byProducer = left.from.localeCompare(right.from, "en-US");
  if (byProducer !== 0) return byProducer;
  const byConsumer = left.to.localeCompare(right.to, "en-US");
  return byConsumer !== 0 ? byConsumer : left.label.localeCompare(right.label, "en-US");
}

function nodeFor(tool: NormalizedTool): GraphNode {
  if (tool.toolkit) return { id: tool.slug, service: tool.toolkit };
  return { id: tool.slug };
}

function edgeKey(edge: GraphEdge): string {
  return `${edge.from}\u0000${edge.to}\u0000${edge.label}`;
}

function requiredLabels(tools: NormalizedTool[]): Map<string, Set<string>> {
  return new Map(
    tools.map((tool) => [
      tool.slug,
      new Set(indexRequiredInputs(tool.inputSchema).fields.map((field) => field.name)),
    ]),
  );
}

export function validateGraph(graph: DependencyGraph, tools: NormalizedTool[]): void {
  const issues: GraphIntegrityIssue[] = [];
  const catalogSlugs = new Set(tools.map((tool) => tool.slug));
  const graphSlugs = new Set<string>();
  const labelsByConsumer = requiredLabels(tools);

  for (const node of graph.nodes) {
    if (graphSlugs.has(node.id)) {
      issues.push({
        code: "duplicate_node",
        nodeId: node.id,
        message: `graph contains duplicate node ${node.id}`,
      });
    }
    graphSlugs.add(node.id);
    if (!catalogSlugs.has(node.id)) {
      issues.push({
        code: "node_not_found",
        nodeId: node.id,
        message: `node ${node.id} does not come from the catalog`,
      });
    }
  }

  for (const edge of graph.edges) {
    if (!graphSlugs.has(edge.from)) {
      issues.push({
        code: "producer_not_found",
        edge,
        message: `edge producer ${edge.from} is not a graph node`,
      });
    }
    if (!graphSlugs.has(edge.to)) {
      issues.push({
        code: "consumer_not_found",
        edge,
        message: `edge consumer ${edge.to} is not a graph node`,
      });
    }
    if (edge.from === edge.to) {
      issues.push({ code: "self_edge", edge, message: `self-edge is not a useful prerequisite` });
    }
    if (!labelsByConsumer.get(edge.to)?.has(edge.label)) {
      issues.push({
        code: "label_not_required",
        edge,
        message: `edge label ${edge.label} is not a required input of ${edge.to}`,
      });
    }
  }

  if (issues.length > 0) throw new GraphIntegrityError(issues);
}

export function assembleGraph(
  tools: NormalizedTool[],
  proposedEdges: Iterable<GraphEdge>,
): DependencyGraph {
  const nodes = tools.map(nodeFor).sort(compareNodes);
  const uniqueEdges = new Map<string, GraphEdge>();
  for (const edge of proposedEdges) uniqueEdges.set(edgeKey(edge), edge);
  const edges = [...uniqueEdges.values()].sort(compareEdges);
  const graph = { nodes, edges };
  validateGraph(graph, tools);
  return graph;
}

export function writeGraphAtomic(graph: DependencyGraph, outputPath: string): void {
  const directory = dirname(outputPath);
  const temporaryPath = join(
    directory,
    `.${basename(outputPath)}.${process.pid}.${Date.now()}.tmp`,
  );

  try {
    writeFileSync(temporaryPath, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
    renameSync(temporaryPath, outputPath);
  } catch (error) {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    throw error;
  }
}
