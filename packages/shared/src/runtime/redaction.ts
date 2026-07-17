const ASSIGNMENT_SECRET =
  /((?:ANTHROPIC_(?:API_KEY|AUTH_TOKEN)|OPENALEX_API_KEY|API_KEY|AUTH_TOKEN|ACCESS_TOKEN|PASSWORD)\s*[=:]\s*)[^\s,;]+/gi;
const BEARER_SECRET =
  /((?:authorization|proxy-authorization)\s*[=:]\s*bearer\s+)[^\s,;]+/gi;
const TOKEN_SECRET = /\b(?:sk|api)[-_][A-Za-z0-9_-]{12,}\b/g;
const SENSITIVE_KEYS = new Set([
  "password",
  "passphrase",
  "secret",
  "clientsecret",
  "apikey",
  "apitoken",
  "authtoken",
  "accesstoken",
  "refreshtoken",
  "token",
  "credential",
  "credentials",
  "authorization",
  "proxyauthorization",
]);

export function redactSecrets(value: string): string {
  return value
    .replace(ASSIGNMENT_SECRET, "$1[REDACTED]")
    .replace(BEARER_SECRET, "$1[REDACTED]")
    .replace(TOKEN_SECRET, "[REDACTED]");
}

export function sanitizeJson(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeJson(item));
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      isSensitiveKey(key) ? "[REDACTED]" : sanitizeJson(item),
    ]),
  );
}

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEYS.has(key.replace(/[^A-Za-z0-9]/g, "").toLowerCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
