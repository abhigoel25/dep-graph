/**
 * Generator entrypoint. Read a toolkit catalog, infer its dependencies, write a graph.
 *
 * How we run it:
 *   - The path to a toolkit's catalog JSON is passed as a CLI ARGUMENT, e.g.
 *     `node --import tsx src/generate.ts path/to/catalog.json`. We append it as the last
 *     argument, so reading the final argv entry works whatever else your command carries.
 *   - Write your graph to `dependency_graph.json` in the working directory.
 *   - For LLM access, the OpenAI SDK reads OPENAI_API_KEY / OPENAI_BASE_URL from the
 *     environment (set from your assessment page's AI credentials; the same are provided
 *     when we run your generator). DEPENDENCY_GRAPH_MODEL optionally overrides the model.
 *
 * The generator first retrieves candidates from required-input and nested-output schema
 * evidence, then asks a model to adjudicate only those closed candidates. Missing or failed
 * model access falls back safely without weakening the catalog-provenance firewall.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  adjudicateCandidates,
  createModelTransportFromEnv,
} from "./adjudicator.js";
import type {
  AdjudicationMode,
  AdjudicationResult,
  ModelTransport,
} from "./adjudicator.js";
import { inferDependencyCandidates } from "./candidates.js";
import { loadCatalogFile } from "./catalog.js";
import { assembleGraph, writeGraphAtomic } from "./graph.js";
import { selectDeterministicEdges } from "./selection.js";
import type {
  CandidateInferenceResult,
  DependencyGraph,
  NormalizedTool,
  OfflineGenerationResult,
} from "./types.js";

// The catalog path is the last CLI argument (we append it after your run command).
const OUT_PATH = "dependency_graph.json";

export function generateOffline(tools: NormalizedTool[]): OfflineGenerationResult {
  const inference = inferDependencyCandidates(tools);
  const selection = selectDeterministicEdges(inference);
  const graph = assembleGraph(tools, selection.edges);
  return { graph, inference, selection };
}

export type GenerationResult =
  | {
      decisionPath: "deterministic";
      mode: "offline";
      graph: DependencyGraph;
      inference: CandidateInferenceResult;
      selection: OfflineGenerationResult["selection"];
    }
  | {
      decisionPath: "adjudicator";
      mode: AdjudicationMode;
      graph: DependencyGraph;
      inference: CandidateInferenceResult;
      adjudication: AdjudicationResult;
    };

export async function generateGraph(
  tools: NormalizedTool[],
  transport?: ModelTransport,
): Promise<GenerationResult> {
  if (!transport) {
    const offline = generateOffline(tools);
    return { ...offline, decisionPath: "deterministic", mode: "offline" };
  }

  const inference = inferDependencyCandidates(tools);
  const adjudication = await adjudicateCandidates(inference, tools, transport);
  const graph = assembleGraph(tools, adjudication.edges);
  return {
    decisionPath: "adjudicator",
    mode: adjudication.mode,
    graph,
    inference,
    adjudication,
  };
}

async function main() {
  const catalogPath = process.argv.length > 2 ? process.argv.at(-1) : undefined;
  if (!catalogPath) throw new Error("pass the toolkit catalog path as the first argument");

  const catalog = loadCatalogFile(catalogPath);
  const result = await generateGraph(catalog.tools, createModelTransportFromEnv());
  writeGraphAtomic(result.graph, OUT_PATH);
  if (catalog.warnings.length > 0) {
    console.error(`catalog loaded with ${catalog.warnings.length} warning(s)`);
  }
  console.error(
    `indexed ${result.inference.stats.identifierInputs} identifier inputs and ` +
      `${result.inference.stats.indexedOutputs} output fields`,
  );
  if (result.decisionPath === "adjudicator") {
    const stats = result.adjudication.stats;
    console.error(
      `adjudication ${result.mode}: ${stats.modelCases} model case(s), ` +
        `${stats.fallbackCases} fallback case(s), ${stats.retries} retry attempt(s)`,
    );
  } else {
    console.error("adjudication offline: assessment model credentials were not configured");
  }
  console.error(
    `wrote ${result.graph.nodes.length} nodes, ${result.graph.edges.length} edges to ${OUT_PATH}`,
  );
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entrypoint === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
