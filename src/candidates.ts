import { indexOutputs, indexRequiredInputs } from "./schema.js";
import {
  entityTokens,
  identityTokens,
  isGenericIdentityName,
  isIdentifierLike,
  normalizeName,
  tokenOverlap,
  tokenize,
  uniqueTokens,
} from "./semantics.js";
import type {
  CandidateCase,
  CandidateConfidence,
  CandidateFeature,
  CandidateInferenceResult,
  DependencyCandidate,
  FieldEvidence,
  NormalizedTool,
} from "./types.js";

const DEFAULT_TOP_K = 8;
const DEFAULT_MIN_SCORE = 6;
const DISCOVERY_ACTIONS = new Set(["find", "get", "list", "read", "retrieve", "search"]);
const CREATION_ACTIONS = new Set(["add", "create", "start", "trigger"]);
const MUTATING_ACTIONS = new Set([
  "archive",
  "close",
  "delete",
  "disable",
  "dismiss",
  "merge",
  "remove",
  "stop",
  "update",
]);

interface IndexedTool {
  tool: NormalizedTool;
  inputs: FieldEvidence[];
  outputs: FieldEvidence[];
  toolEntities: string[];
  actionTokens: string[];
}

interface OutputRecord {
  indexedTool: IndexedTool;
  field: FieldEvidence;
  identity: string[];
  localEntities: string[];
  globalEntities: string[];
  contextEntities: string[];
}

interface OutputIndexes {
  byIdentityEntity: Map<string, OutputRecord[]>;
  byName: Map<string, OutputRecord[]>;
}

export interface CandidateOptions {
  minScore?: number;
  topK?: number;
}

function localEntityTokens(field: FieldEvidence): string[] {
  const parent = field.pathSegments.at(-2) ?? "";
  return entityTokens(parent, field.name, field.title);
}

function globalEntityTokens(field: FieldEvidence): string[] {
  return entityTokens(field.path, field.title);
}

function fieldIdentityTokens(field: FieldEvidence, allowDescriptionFallback = true): string[] {
  const direct = uniqueTokens(field.name, field.title).filter((token) =>
    identityTokens(token).includes(token),
  );
  if (direct.length > 0) return direct;
  return allowDescriptionFallback ? identityTokens(field.description) : [];
}

function indexedTools(tools: NormalizedTool[]): IndexedTool[] {
  return tools.map((tool) => ({
    tool,
    inputs: indexRequiredInputs(tool.inputSchema).fields,
    outputs: indexOutputs(tool.outputSchema).fields,
    toolEntities: entityTokens(tool.slug, tool.name, ...tool.tags),
    actionTokens: tokenize(`${tool.slug} ${tool.name}`),
  }));
}

function typeCompatibility(left: FieldEvidence, right: FieldEvidence): "exact" | "compatible" | "unknown" | "none" {
  if (left.types.length === 0 || right.types.length === 0) return "unknown";
  if (tokenOverlap(left.types, right.types).length > 0) return "exact";
  const numeric = new Set(["integer", "number"]);
  if (left.types.some((type) => numeric.has(type)) && right.types.some((type) => numeric.has(type))) {
    return "compatible";
  }
  return "none";
}

function inputEntities(field: FieldEvidence): string[] {
  const structural = entityTokens(field.name, field.path, field.title);
  return structural.length > 0 ? structural : entityTokens(field.description);
}

function requiresEquivalentValue(producer: IndexedTool, target: FieldEvidence): boolean {
  const targetName = normalizeName(target.name);
  const targetIdentity = fieldIdentityTokens(target);
  const targetEntities = inputEntities(target);

  return producer.inputs.some((input) => {
    if (normalizeName(input.name) === targetName) return true;
    const sharedIdentity = tokenOverlap(fieldIdentityTokens(input), targetIdentity);
    if (sharedIdentity.length === 0) return false;
    const inputFieldEntities = inputEntities(input);
    if (targetEntities.length === 0 && inputFieldEntities.length === 0) return true;
    return tokenOverlap(inputFieldEntities, targetEntities).length > 0;
  });
}

function sharedScopeCount(producer: IndexedTool, consumer: IndexedTool, target: FieldEvidence): number {
  const targetName = normalizeName(target.name);
  const producerNames = new Set(
    producer.inputs.map((field) => normalizeName(field.name)).filter((name) => name !== targetName),
  );
  return new Set(
    consumer.inputs
      .map((field) => normalizeName(field.name))
      .filter((name) => name !== targetName && producerNames.has(name)),
  ).size;
}

function operationPrior(indexedTool: IndexedTool): { code: string; detail: string; weight: number } {
  const actions = new Set(indexedTool.actionTokens);
  const discovery = [...DISCOVERY_ACTIONS].find((action) => actions.has(action));
  if (discovery) {
    return {
      code: "discovery_operation",
      detail: `producer is a ${discovery} operation`,
      weight: 1.5,
    };
  }

  const creation = [...CREATION_ACTIONS].find((action) => actions.has(action));
  if (creation) {
    return {
      code: "creation_operation",
      detail: `producer is a ${creation} operation that may return a new identifier`,
      weight: 1,
    };
  }

  const mutation = [...MUTATING_ACTIONS].find((action) => actions.has(action));
  if (mutation) {
    return {
      code: "mutation_operation",
      detail: `producer is a ${mutation} operation`,
      weight: -0.5,
    };
  }

  return { code: "neutral_operation", detail: "producer operation has no role prior", weight: 0 };
}

function confidenceFor(score: number): CandidateConfidence {
  if (score >= 14) return "high";
  if (score >= 10) return "medium";
  return "low";
}

function pushFeature(
  evidence: CandidateFeature[],
  code: string,
  detail: string,
  weight: number,
): void {
  if (weight === 0) return;
  evidence.push({ code, detail, weight });
}

function scoreCandidate(
  producer: IndexedTool,
  output: OutputRecord,
  consumer: IndexedTool,
  input: FieldEvidence,
): DependencyCandidate | undefined {
  if (producer.tool.deprecated || producer.tool.slug === consumer.tool.slug) return undefined;
  if (requiresEquivalentValue(producer, input)) return undefined;

  const inputIdentity = fieldIdentityTokens(input);
  const sharedIdentity = tokenOverlap(inputIdentity, output.identity);
  const namesMatch = normalizeName(input.name) === normalizeName(output.field.name);
  if (!namesMatch && sharedIdentity.length === 0) return undefined;

  const compatibility = typeCompatibility(input, output.field);
  if (compatibility === "none") return undefined;

  const fieldEntities = inputEntities(input);
  const localOverlap = tokenOverlap(fieldEntities, output.localEntities);
  const globalOverlap = tokenOverlap(fieldEntities, output.globalEntities);
  const consumerToolOverlap = tokenOverlap(consumer.toolEntities, output.globalEntities);
  const producerConsumerOverlap = tokenOverlap(consumer.toolEntities, producer.toolEntities);
  const fieldProducerOverlap = tokenOverlap(fieldEntities, producer.toolEntities);

  if (
    !namesMatch &&
    fieldEntities.length > 0 &&
    globalOverlap.length === 0 &&
    fieldProducerOverlap.length === 0
  ) {
    return undefined;
  }
  if (
    isGenericIdentityName(input.name) &&
    localOverlap.length === 0 &&
    consumerToolOverlap.length === 0 &&
    producerConsumerOverlap.length === 0
  ) {
    return undefined;
  }

  const evidence: CandidateFeature[] = [];
  if (namesMatch) {
    pushFeature(evidence, "exact_field_name", `both fields normalize to ${normalizeName(input.name)}`, 8);
  }
  if (sharedIdentity.length > 0) {
    pushFeature(
      evidence,
      "identity_match",
      `shared identity token(s): ${sharedIdentity.join(", ")}`,
      4,
    );
  }

  if (compatibility === "exact") {
    pushFeature(evidence, "exact_type", `compatible type(s): ${input.types.join(", ")}`, 2);
  } else if (compatibility === "compatible") {
    pushFeature(evidence, "numeric_type", "integer and number types are compatible", 1.5);
  } else {
    pushFeature(evidence, "unknown_type", "one schema omits a concrete type", 0.25);
  }

  if (localOverlap.length > 0) {
    pushFeature(
      evidence,
      "local_entity_match",
      `nearest output container matches ${localOverlap.join(", ")}`,
      Math.min(localOverlap.length, 2) * 6,
    );
  }
  if (globalOverlap.length > 0) {
    pushFeature(
      evidence,
      "path_entity_match",
      `output path matches ${globalOverlap.join(", ")}`,
      Math.min(globalOverlap.length, 2) * 2,
    );
  }
  if (consumerToolOverlap.length > 0) {
    pushFeature(
      evidence,
      "consumer_context_match",
      `consumer context matches output path on ${consumerToolOverlap.join(", ")}`,
      Math.min(consumerToolOverlap.length, 2),
    );
  }
  if (producerConsumerOverlap.length > 0) {
    pushFeature(
      evidence,
      "tool_context_match",
      `producer and consumer share ${producerConsumerOverlap.join(", ")}`,
      Math.min(producerConsumerOverlap.length, 2) * 0.5,
    );
  }
  if (fieldProducerOverlap.length > 0) {
    pushFeature(
      evidence,
      "producer_context_match",
      `producer context matches input on ${fieldProducerOverlap.join(", ")}`,
      Math.min(fieldProducerOverlap.length, 2) * 3,
    );
  }

  const sharedScope = sharedScopeCount(producer, consumer, input);
  if (sharedScope > 0) {
    pushFeature(
      evidence,
      "shared_scope",
      `${sharedScope} other required context field(s) overlap`,
      Math.min(sharedScope, 4) * 0.5,
    );
  }

  const role = operationPrior(producer);
  pushFeature(evidence, role.code, role.detail, role.weight);

  if (isGenericIdentityName(output.field.name) && localOverlap.length === 0) {
    pushFeature(
      evidence,
      "generic_output_penalty",
      "generic output identity lacks matching nearest-container context",
      -2,
    );
  }

  const excessDepth = Math.max(0, output.field.pathSegments.length - 3);
  if (excessDepth > 0) {
    pushFeature(
      evidence,
      "path_depth_penalty",
      `output is ${excessDepth} level(s) deeper than a direct resource field`,
      -0.5 * excessDepth,
    );
  }

  const score = Number(
    evidence.reduce((total, feature) => total + feature.weight, 0).toFixed(3),
  );
  return {
    producerSlug: producer.tool.slug,
    consumerSlug: consumer.tool.slug,
    label: input.name,
    outputPath: output.field.path,
    score,
    confidence: confidenceFor(score),
    evidence,
  };
}

function addToIndex(index: Map<string, OutputRecord[]>, key: string, record: OutputRecord): void {
  const records = index.get(key) ?? [];
  records.push(record);
  index.set(key, records);
}

function outputRecords(indexes: IndexedTool[]): OutputIndexes {
  const byIdentityEntity = new Map<string, OutputRecord[]>();
  const byName = new Map<string, OutputRecord[]>();
  for (const indexedTool of indexes) {
    for (const field of indexedTool.outputs) {
      const identity = fieldIdentityTokens(field, false);
      if (identity.length === 0) continue;
      const localEntities = localEntityTokens(field);
      const globalEntities = globalEntityTokens(field);
      const record: OutputRecord = {
        indexedTool,
        field,
        identity,
        localEntities,
        globalEntities,
        contextEntities: uniqueTokens(...globalEntities, ...indexedTool.toolEntities),
      };
      addToIndex(byName, normalizeName(field.name), record);
      for (const token of identity) {
        for (const entity of record.contextEntities) {
          addToIndex(byIdentityEntity, `${token}:${entity}`, record);
        }
      }
    }
  }
  return { byIdentityEntity, byName };
}

function compareCandidates(left: DependencyCandidate, right: DependencyCandidate): number {
  if (left.score !== right.score) return right.score - left.score;
  const byProducer = left.producerSlug.localeCompare(right.producerSlug, "en-US");
  if (byProducer !== 0) return byProducer;
  const byDepth = left.outputPath.split(".").length - right.outputPath.split(".").length;
  return byDepth !== 0 ? byDepth : left.outputPath.localeCompare(right.outputPath, "en-US");
}

export function inferDependencyCandidates(
  tools: NormalizedTool[],
  options: CandidateOptions = {},
): CandidateInferenceResult {
  const topK = Math.max(1, options.topK ?? DEFAULT_TOP_K);
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const indexes = indexedTools(tools);
  const outputIndexes = outputRecords(indexes);
  const cases: CandidateCase[] = [];
  let requiredInputs = 0;
  let identifierInputs = 0;

  for (const consumer of indexes) {
    requiredInputs += consumer.inputs.length;
    for (const input of consumer.inputs) {
      if (!isIdentifierLike(input.name, input.description, input.title)) continue;
      identifierInputs += 1;
      const inputIdentity = fieldIdentityTokens(input);
      const possibleRecords = new Set<OutputRecord>();
      for (const record of outputIndexes.byName.get(normalizeName(input.name)) ?? []) {
        possibleRecords.add(record);
      }
      const lookupEntities = inputEntities(input);
      const contextualEntities = lookupEntities.length > 0 ? lookupEntities : consumer.toolEntities;
      for (const token of inputIdentity) {
        for (const entity of contextualEntities) {
          for (const record of outputIndexes.byIdentityEntity.get(`${token}:${entity}`) ?? []) {
            possibleRecords.add(record);
          }
        }
      }

      const bestByProducer = new Map<string, DependencyCandidate>();
      for (const output of possibleRecords) {
        const candidate = scoreCandidate(output.indexedTool, output, consumer, input);
        if (!candidate || candidate.score < minScore) continue;
        const current = bestByProducer.get(candidate.producerSlug);
        if (!current || compareCandidates(candidate, current) < 0) {
          bestByProducer.set(candidate.producerSlug, candidate);
        }
      }

      const candidates = [...bestByProducer.values()].sort(compareCandidates).slice(0, topK);
      if (candidates.length > 0) {
        cases.push({
          consumerSlug: consumer.tool.slug,
          label: input.name,
          input,
          candidates,
        });
      }
    }
  }

  cases.sort((left, right) => {
    const byConsumer = left.consumerSlug.localeCompare(right.consumerSlug, "en-US");
    return byConsumer !== 0 ? byConsumer : left.label.localeCompare(right.label, "en-US");
  });

  return {
    cases,
    stats: {
      tools: tools.length,
      requiredInputs,
      identifierInputs,
      indexedOutputs: indexes.reduce((total, indexed) => total + indexed.outputs.length, 0),
      candidateCases: cases.length,
      candidates: cases.reduce((total, candidateCase) => total + candidateCase.candidates.length, 0),
    },
  };
}
