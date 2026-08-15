import { readFileSync } from "node:fs";

import type {
  CatalogWarning,
  JsonObject,
  JsonSchema,
  NormalizedCatalog,
  NormalizedTool,
} from "./types.js";

export type CatalogErrorCode =
  | "empty_catalog"
  | "invalid_json"
  | "invalid_path"
  | "read_failed"
  | "unsupported_shape";

export class CatalogError extends Error {
  readonly code: CatalogErrorCode;

  constructor(code: CatalogErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CatalogError";
    this.code = code;
  }
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function firstObject(...values: unknown[]): JsonSchema {
  return values.find(isJsonObject) ?? {};
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(nonEmptyString).filter((item): item is string => item !== undefined);
}

function toolkitSlug(value: unknown): string | undefined {
  if (typeof value === "string") return nonEmptyString(value);
  if (!isJsonObject(value)) return undefined;
  return nonEmptyString(value.slug) ?? nonEmptyString(value.name);
}

function rawToolsFrom(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;

  if (isJsonObject(value)) {
    if (Array.isArray(value.tools)) return value.tools;
    if (Array.isArray(value.items)) return value.items;
  }

  throw new CatalogError(
    "unsupported_shape",
    'catalog must be a JSON array or an object containing a "tools" or "items" array',
  );
}

function slugFrom(tool: JsonObject): string | undefined {
  const fn = isJsonObject(tool.function) ? tool.function : undefined;
  return (
    nonEmptyString(tool.slug) ??
    nonEmptyString(tool.name) ??
    (fn ? nonEmptyString(fn.name) : undefined)
  );
}

function normalizeTool(tool: JsonObject, slug: string): NormalizedTool {
  const fn = isJsonObject(tool.function) ? tool.function : undefined;
  const normalized: NormalizedTool = {
    slug,
    name: nonEmptyString(tool.name) ?? slug,
    description: nonEmptyString(tool.description) ?? "",
    tags: stringArray(tool.tags),
    deprecated: tool.isDeprecated === true || tool.deprecated === true,
    inputSchema: firstObject(
      tool.inputParameters,
      tool.inputSchema,
      tool.input_parameters,
      tool.parameters,
      fn?.parameters,
    ),
    outputSchema: firstObject(
      tool.outputParameters,
      tool.outputSchema,
      tool.output_parameters,
      tool.responseSchema,
      fn?.outputParameters,
      fn?.outputSchema,
    ),
  };

  const toolkit = toolkitSlug(tool.toolkit);
  const version = nonEmptyString(tool.version);
  if (toolkit) normalized.toolkit = toolkit;
  if (version) normalized.version = version;
  return normalized;
}

function duplicateWarning(
  index: number,
  slug: string,
  kept: NormalizedTool,
): CatalogWarning {
  return {
    code: "duplicate_slug",
    index,
    slug,
    message: `duplicate tool slug "${slug}"; kept ${kept.deprecated ? "deprecated" : "active"} entry`,
  };
}

export function normalizeCatalog(value: unknown, source = "<memory>"): NormalizedCatalog {
  const rawTools = rawToolsFrom(value);
  const warnings: CatalogWarning[] = [];
  const bySlug = new Map<string, NormalizedTool>();

  rawTools.forEach((rawTool, index) => {
    if (!isJsonObject(rawTool)) {
      warnings.push({
        code: "malformed_tool",
        index,
        message: `ignored catalog entry ${index}: expected an object`,
      });
      return;
    }

    const slug = slugFrom(rawTool);
    if (!slug) {
      warnings.push({
        code: "malformed_tool",
        index,
        message: `ignored catalog entry ${index}: missing a non-empty slug or name`,
      });
      return;
    }

    const candidate = normalizeTool(rawTool, slug);
    const key = slug.toLocaleUpperCase("en-US");
    const current = bySlug.get(key);
    if (!current) {
      bySlug.set(key, candidate);
      return;
    }

    if (current.deprecated && !candidate.deprecated) {
      bySlug.set(key, candidate);
      warnings.push(duplicateWarning(index, slug, candidate));
      return;
    }

    warnings.push(duplicateWarning(index, slug, current));
  });

  const tools = [...bySlug.values()].sort((left, right) =>
    left.slug.localeCompare(right.slug, "en-US"),
  );

  if (tools.length === 0) {
    throw new CatalogError("empty_catalog", `catalog ${source} contains no usable tools`);
  }

  return { tools, warnings, source };
}

export function loadCatalogFile(catalogPath: string): NormalizedCatalog {
  const path = nonEmptyString(catalogPath);
  if (!path) {
    throw new CatalogError("invalid_path", "pass a non-empty toolkit catalog path");
  }

  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    throw new CatalogError("read_failed", `could not read catalog at ${path}`, {
      cause: error,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch (error) {
    throw new CatalogError("invalid_json", `catalog at ${path} is not valid JSON`, {
      cause: error,
    });
  }

  return normalizeCatalog(parsed, path);
}
