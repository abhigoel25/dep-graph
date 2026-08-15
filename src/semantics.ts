const IDENTITY_TOKENS = new Set([
  "id",
  "identifier",
  "key",
  "name",
  "number",
  "ref",
  "reference",
  "sha",
  "slug",
  "url",
  "uuid",
]);

const ACTION_TOKENS = new Set([
  "accept",
  "add",
  "archive",
  "cancel",
  "close",
  "create",
  "delete",
  "disable",
  "dismiss",
  "enable",
  "find",
  "get",
  "list",
  "merge",
  "open",
  "read",
  "remove",
  "retrieve",
  "run",
  "search",
  "set",
  "start",
  "stop",
  "trigger",
  "unarchive",
  "update",
]);

const SCHEMA_TOKENS = new Set([
  "array",
  "data",
  "input",
  "object",
  "output",
  "parameter",
  "request",
  "response",
  "result",
  "value",
  "wrapper",
]);

const DESCRIPTION_STOP_TOKENS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "this",
  "to",
  "used",
  "using",
  "with",
]);

const TOKEN_ALIASES: Readonly<Record<string, string>> = {
  ids: "id",
  identifier: "id",
  identifiers: "id",
  num: "number",
  nums: "number",
  reference: "ref",
  references: "ref",
  statuses: "status",
};

function singularize(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("sses")) return token.slice(0, -2);
  if (token.endsWith("xes") || token.endsWith("zes") || token.endsWith("ches")) {
    return token.slice(0, -2);
  }
  if (
    token.endsWith("s") &&
    !token.endsWith("ss") &&
    !token.endsWith("us") &&
    !token.endsWith("is")
  ) {
    return token.slice(0, -1);
  }
  return token;
}

export function tokenize(value: string): string[] {
  const separated = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLocaleLowerCase("en-US")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  if (!separated) return [];
  return separated.split(/\s+/).map((token) => {
    const aliased = TOKEN_ALIASES[token] ?? token;
    const singular = singularize(aliased);
    return TOKEN_ALIASES[singular] ?? singular;
  });
}

export function normalizeName(value: string): string {
  return tokenize(value).join("_");
}

export function uniqueTokens(...values: string[]): string[] {
  return [...new Set(values.flatMap(tokenize))].sort((left, right) =>
    left.localeCompare(right, "en-US"),
  );
}

export function identityTokens(value: string): string[] {
  return uniqueTokens(value).filter((token) => IDENTITY_TOKENS.has(token));
}

export function isIdentifierLike(name: string, description = "", title = ""): boolean {
  if (identityTokens(name).length > 0) return true;
  const explanatoryTokens = uniqueTokens(description, title);
  return explanatoryTokens.includes("id") || explanatoryTokens.includes("number");
}

export function entityTokens(...values: string[]): string[] {
  return uniqueTokens(...values).filter(
    (token) =>
      !IDENTITY_TOKENS.has(token) &&
      !ACTION_TOKENS.has(token) &&
      !SCHEMA_TOKENS.has(token) &&
      !DESCRIPTION_STOP_TOKENS.has(token),
  );
}

export function tokenOverlap(left: Iterable<string>, right: Iterable<string>): string[] {
  const rightSet = new Set(right);
  return uniqueSorted([...left].filter((token) => rightSet.has(token)));
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right, "en-US"));
}

export function isGenericIdentityName(name: string): boolean {
  const tokens = tokenize(name);
  return tokens.length > 0 && tokens.every((token) => IDENTITY_TOKENS.has(token));
}
