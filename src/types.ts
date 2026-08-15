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
