import type {
  FieldEvidence,
  FieldSource,
  JsonObject,
  JsonSchema,
  SchemaIndex,
  SchemaWarning,
} from "./types.js";
import { isJsonObject } from "./catalog.js";

const MAX_SCHEMA_DEPTH = 48;
const OUTPUT_WRAPPER_FIELDS = new Set(["data", "error", "errors", "success", "successful"]);
const COMBINATORS = ["allOf", "anyOf", "oneOf"] as const;

interface FieldMetadata {
  description: string;
  title: string;
  declaredTypes?: string[];
}

interface WalkContext {
  root: JsonSchema;
  source: FieldSource;
  fields: Map<string, FieldEvidence>;
  warnings: SchemaWarning[];
  activeRefs: Set<string>;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en-US"));
}

function displayPath(pathSegments: string[]): string {
  return pathSegments.join(".");
}

function fieldName(pathSegments: string[]): string {
  return (pathSegments.at(-1) ?? "").replace(/\[\]$/, "");
}

function metadataFor(schema: JsonSchema, inherited?: FieldMetadata): FieldMetadata {
  const metadata: FieldMetadata = {
    description: nonEmptyString(schema.description) ?? inherited?.description ?? "",
    title: nonEmptyString(schema.title) ?? inherited?.title ?? "",
  };
  const types = strings(schema.type);
  if (types.length > 0) metadata.declaredTypes = uniqueSorted(types);
  else if (inherited?.declaredTypes) metadata.declaredTypes = inherited.declaredTypes;
  return metadata;
}

function mergeField(existing: FieldEvidence, candidate: FieldEvidence): FieldEvidence {
  return {
    ...existing,
    types: uniqueSorted([...existing.types, ...candidate.types]),
    description:
      candidate.description.length > existing.description.length
        ? candidate.description
        : existing.description,
    title: candidate.title.length > existing.title.length ? candidate.title : existing.title,
    required: existing.required || candidate.required,
  };
}

function recordLeaf(
  schema: JsonSchema,
  pathSegments: string[],
  required: boolean,
  metadata: FieldMetadata,
  context: WalkContext,
): void {
  if (pathSegments.length === 0) return;

  const name = fieldName(pathSegments);
  if (
    context.source === "output" &&
    pathSegments.length === 1 &&
    OUTPUT_WRAPPER_FIELDS.has(name.toLocaleLowerCase("en-US"))
  ) {
    return;
  }

  if (context.source === "input" && !required) return;

  const schemaTypes = strings(schema.type);
  const evidence: FieldEvidence = {
    name,
    path: displayPath(pathSegments),
    pathSegments: [...pathSegments],
    types: uniqueSorted(metadata.declaredTypes ?? schemaTypes),
    description: metadata.description,
    title: metadata.title,
    required,
    source: context.source,
  };
  const key = `${evidence.source}:${evidence.path}`;
  const existing = context.fields.get(key);
  context.fields.set(key, existing ? mergeField(existing, evidence) : evidence);
}

function decodeJsonPointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolveLocalRef(root: JsonSchema, ref: string): JsonObject | undefined {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;

  let current: unknown = root;
  for (const encodedSegment of ref.slice(2).split("/")) {
    if (!isJsonObject(current)) return undefined;
    current = current[decodeJsonPointerSegment(encodedSegment)];
  }
  return isJsonObject(current) ? current : undefined;
}

function combineReferencedSchema(resolved: JsonSchema, referencing: JsonSchema): JsonSchema {
  const combined: JsonSchema = { ...resolved, ...referencing };
  delete combined.$ref;

  const resolvedProperties = isJsonObject(resolved.properties) ? resolved.properties : {};
  const siblingProperties = isJsonObject(referencing.properties) ? referencing.properties : {};
  if (Object.keys(resolvedProperties).length > 0 || Object.keys(siblingProperties).length > 0) {
    combined.properties = { ...resolvedProperties, ...siblingProperties };
  }

  const required = uniqueSorted([...strings(resolved.required), ...strings(referencing.required)]);
  if (required.length > 0) combined.required = required;
  return combined;
}

function addWarning(
  context: WalkContext,
  warning: SchemaWarning,
): void {
  const duplicate = context.warnings.some(
    (existing) =>
      existing.code === warning.code &&
      existing.path === warning.path &&
      existing.ref === warning.ref,
  );
  if (!duplicate) context.warnings.push(warning);
}

function requiredNames(schema: JsonSchema): Set<string> {
  return new Set(strings(schema.required));
}

function markArrayPath(pathSegments: string[]): string[] {
  if (pathSegments.length === 0) return pathSegments;
  const result = [...pathSegments];
  const last = result.at(-1);
  if (last && !last.endsWith("[]")) result[result.length - 1] = `${last}[]`;
  return result;
}

function walkSchema(
  schema: JsonSchema,
  pathSegments: string[],
  required: boolean,
  depth: number,
  context: WalkContext,
  inheritedMetadata?: FieldMetadata,
): void {
  if (depth > MAX_SCHEMA_DEPTH) {
    addWarning(context, {
      code: "depth_limit",
      path: displayPath(pathSegments),
      message: `stopped schema traversal after ${MAX_SCHEMA_DEPTH} levels`,
    });
    return;
  }

  const metadata = metadataFor(schema, inheritedMetadata);
  const ref = nonEmptyString(schema.$ref);
  if (ref) {
    if (context.activeRefs.has(ref)) {
      addWarning(context, {
        code: "cyclic_ref",
        path: displayPath(pathSegments),
        ref,
        message: `stopped cyclic schema reference ${ref}`,
      });
      return;
    }

    const resolved = resolveLocalRef(context.root, ref);
    if (!resolved) {
      addWarning(context, {
        code: "unresolved_ref",
        path: displayPath(pathSegments),
        ref,
        message: `could not resolve local schema reference ${ref}`,
      });
      return;
    }

    context.activeRefs.add(ref);
    walkSchema(
      combineReferencedSchema(resolved, schema),
      pathSegments,
      required,
      depth + 1,
      context,
      metadata,
    );
    context.activeRefs.delete(ref);
    return;
  }

  let traversedCombination = false;
  for (const keyword of COMBINATORS) {
    const variants = schema[keyword];
    if (!Array.isArray(variants)) continue;
    for (const variant of variants) {
      if (!isJsonObject(variant)) continue;
      traversedCombination = true;
      walkSchema(variant, pathSegments, required, depth + 1, context, metadata);
    }
  }
  const properties = isJsonObject(schema.properties) ? schema.properties : undefined;
  if (properties && Object.keys(properties).length > 0) {
    const requiredSet = requiredNames(schema);
    for (const [name, propertySchema] of Object.entries(properties)) {
      if (!isJsonObject(propertySchema)) continue;
      walkSchema(
        propertySchema,
        [...pathSegments, name],
        required && requiredSet.has(name),
        depth + 1,
        context,
      );
    }
    return;
  }

  const items = schema.items;
  if (isJsonObject(items)) {
    const arrayMetadata: FieldMetadata = {
      ...metadata,
      declaredTypes: ["array"],
    };
    walkSchema(
      items,
      markArrayPath(pathSegments),
      required,
      depth + 1,
      context,
      arrayMetadata,
    );
    return;
  }

  if (Array.isArray(items)) {
    for (const item of items) {
      if (!isJsonObject(item)) continue;
      const arrayMetadata: FieldMetadata = {
        ...metadata,
        declaredTypes: ["array"],
      };
      walkSchema(
        item,
        markArrayPath(pathSegments),
        required,
        depth + 1,
        context,
        arrayMetadata,
      );
    }
    return;
  }

  if (!traversedCombination) recordLeaf(schema, pathSegments, required, metadata, context);
}

export function indexSchemaFields(schema: JsonSchema, source: FieldSource): SchemaIndex {
  const context: WalkContext = {
    root: schema,
    source,
    fields: new Map(),
    warnings: [],
    activeRefs: new Set(),
  };

  walkSchema(schema, [], true, 0, context);
  const fields = [...context.fields.values()].sort((left, right) =>
    left.path.localeCompare(right.path, "en-US"),
  );
  const warnings = [...context.warnings].sort((left, right) => {
    const byPath = left.path.localeCompare(right.path, "en-US");
    return byPath !== 0 ? byPath : left.code.localeCompare(right.code, "en-US");
  });
  return { fields, warnings };
}

export function indexRequiredInputs(schema: JsonSchema): SchemaIndex {
  return indexSchemaFields(schema, "input");
}

export function indexOutputs(schema: JsonSchema): SchemaIndex {
  return indexSchemaFields(schema, "output");
}
