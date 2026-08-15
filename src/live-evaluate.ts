import { readFileSync, writeFileSync } from "node:fs";

import {
  adjudicateCandidates,
  createModelTransportFromEnv,
  DEFAULT_MODEL,
} from "./adjudicator.js";
import { inferDependencyCandidates } from "./candidates.js";
import { loadCatalogFile } from "./catalog.js";

interface GoldCase {
  from: string;
  to: string;
  label: string;
  expected: boolean;
  rationale: string;
}

interface GoldFile {
  cases: GoldCase[];
}

function edgeKey(from: string, to: string, label: string): string {
  return `${from}\u0000${to}\u0000${label}`;
}

async function main() {
  const catalogPath = process.argv[2] ?? "github_catalog.json";
  const goldPath = process.argv[3] ?? "evaluation/github-gold.json";
  const outputPath = process.argv[4] ?? "evaluation/live-calibration-report.json";
  const transport = createModelTransportFromEnv();
  if (!transport) throw new Error("OPENAI_API_KEY and OPENAI_BASE_URL are required");

  const tools = loadCatalogFile(catalogPath).tools;
  const inference = inferDependencyCandidates(tools);
  const gold = JSON.parse(readFileSync(goldPath, "utf8")) as GoldFile;
  const wantedCases = new Set(gold.cases.map((item) => `${item.to}\u0000${item.label}`));
  const focusedCases = inference.cases.filter((item) =>
    wantedCases.has(`${item.consumerSlug}\u0000${item.label}`),
  );
  const adjudication = await adjudicateCandidates(
    { ...inference, cases: focusedCases },
    tools,
    transport,
    { casesPerBatch: 20, concurrency: 1 },
  );
  const selected = new Set(
    adjudication.edges.map((edge) => edgeKey(edge.from, edge.to, edge.label)),
  );
  const results = gold.cases.map((item) => {
    const actual = selected.has(edgeKey(item.from, item.to, item.label));
    return { ...item, actual, passed: actual === item.expected };
  });
  const positives = results.filter((item) => item.expected);
  const negatives = results.filter((item) => !item.expected);
  const report = {
    schema_version: 1,
    model: process.env.DEPENDENCY_GRAPH_MODEL ?? DEFAULT_MODEL,
    focused_cases: focusedCases.length,
    gold_cases: results.length,
    passed: results.filter((item) => item.passed).length,
    accuracy: results.filter((item) => item.passed).length / results.length,
    positive_selection_recall: positives.filter((item) => item.actual).length / positives.length,
    negative_rejection_rate: negatives.filter((item) => !item.actual).length / negatives.length,
    adjudication: adjudication.stats,
    issues: adjudication.issues,
    results,
  };
  writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(
    `${JSON.stringify({
      output: outputPath,
      model: report.model,
      accuracy: report.accuracy,
      positive_selection_recall: report.positive_selection_recall,
      negative_rejection_rate: report.negative_rejection_rate,
    })}\n`,
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
