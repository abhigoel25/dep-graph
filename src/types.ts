export type JsonObject = Record<string, unknown>;
export type JsonSchema = JsonObject;

export interface NormalizedTool {
  slug: string;
  name: string;
  description: string;
  tags: string[];
  deprecated: boolean;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  toolkit?: string;
  version?: string;
}

export type CatalogWarningCode = "duplicate_slug" | "malformed_tool";

export interface CatalogWarning {
  code: CatalogWarningCode;
  message: string;
  index: number;
  slug?: string;
}

export interface NormalizedCatalog {
  tools: NormalizedTool[];
  warnings: CatalogWarning[];
  source: string;
}

export type FieldSource = "input" | "output";

export interface FieldEvidence {
  name: string;
  path: string;
  pathSegments: string[];
  types: string[];
  description: string;
  title: string;
  required: boolean;
  source: FieldSource;
}

export type SchemaWarningCode = "cyclic_ref" | "depth_limit" | "unresolved_ref";

export interface SchemaWarning {
  code: SchemaWarningCode;
  message: string;
  path: string;
  ref?: string;
}

export interface SchemaIndex {
  fields: FieldEvidence[];
  warnings: SchemaWarning[];
}

export type CandidateConfidence = "high" | "medium" | "low";

export interface CandidateFeature {
  code: string;
  detail: string;
  weight: number;
}

export interface DependencyCandidate {
  producerSlug: string;
  consumerSlug: string;
  label: string;
  outputPath: string;
  score: number;
  confidence: CandidateConfidence;
  evidence: CandidateFeature[];
}

export interface CandidateCase {
  consumerSlug: string;
  label: string;
  input: FieldEvidence;
  candidates: DependencyCandidate[];
}

export interface CandidateInferenceStats {
  tools: number;
  requiredInputs: number;
  identifierInputs: number;
  indexedOutputs: number;
  candidateCases: number;
  candidates: number;
}

export interface CandidateInferenceResult {
  cases: CandidateCase[];
  stats: CandidateInferenceStats;
}

export type SelectionRejectionReason =
  | "below_minimum_score"
  | "outside_score_window"
  | "per_input_limit";

export interface CandidateDecision {
  candidate: DependencyCandidate;
  accepted: boolean;
  reason?: SelectionRejectionReason;
}

export interface DeterministicSelectionStats {
  cases: number;
  abstainedCases: number;
  selectedEdges: number;
  rejectedCandidates: number;
}

export interface DeterministicSelectionResult {
  edges: GraphEdge[];
  decisions: CandidateDecision[];
  stats: DeterministicSelectionStats;
}

export interface GraphNode {
  id: string;
  service?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  label: string;
}

export interface DependencyGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export type GraphIntegrityIssueCode =
  | "consumer_not_found"
  | "duplicate_node"
  | "label_not_required"
  | "node_not_found"
  | "producer_not_found"
  | "self_edge";

export interface GraphIntegrityIssue {
  code: GraphIntegrityIssueCode;
  message: string;
  edge?: GraphEdge;
  nodeId?: string;
}
