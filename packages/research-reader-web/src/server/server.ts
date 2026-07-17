import { randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WikiCompiler,
  getSourceArtifact,
  loadConfig,
  type LlmProvider,
} from "@intelligent-agent-system/llm-wiki-compiler";
import {
  ResearchReader,
  secureExistingPath,
  type ReadingStatus,
} from "@intelligent-agent-system/research-reader";

export interface ReaderWebServerOptions {
  root: string;
  host?: "127.0.0.1" | "::1" | "localhost";
  port?: number;
  clientDir?: string;
  approveLlm?: boolean;
  maxLlmTokens?: number;
  llmProvider?: LlmProvider;
}

export interface ReaderWebServer {
  readonly csrfToken: string;
  readonly server: Server;
  start(): Promise<{ host: string; port: number; url: string }>;
  stop(): Promise<void>;
}

export function createReaderWebServer(
  options: ReaderWebServerOptions,
): ReaderWebServer {
  const root = path.resolve(options.root);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error("Research Reader Web may bind only to localhost");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("Web port must be from 0 to 65535");
  }
  const defaultClientDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "client",
  );
  const clientDir = path.resolve(options.clientDir ?? defaultClientDir);
  const csrfToken = randomBytes(32).toString("hex");
  const reader = new ResearchReader({ root });
  const server = createServer((request, response) => {
    void handleRequest(
      request,
      response,
      reader,
      root,
      clientDir,
      csrfToken,
      options,
    );
  });
  return {
    csrfToken,
    server,
    start: () =>
      new Promise((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(port, host, () => {
          server.off("error", onError);
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("Unable to resolve Reader Web address"));
            return;
          }
          resolve({
            host,
            port: address.port,
            url: `http://${host === "::1" ? "[::1]" : host}:${address.port}`,
          });
        });
      }),
    stop: () =>
      new Promise((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  reader: ResearchReader,
  root: string,
  clientDir: string,
  csrfToken: string,
  options: ReaderWebServerOptions,
): Promise<void> {
  applySecurityHeaders(response);
  try {
    if (!validHostHeader(request.headers.host)) {
      sendJson(response, 403, { error: "Invalid localhost Host header" });
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url, reader, root, csrfToken, options);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "Method not allowed" });
      return;
    }
    await serveStatic(
      response,
      clientDir,
      url.pathname,
      request.method === "HEAD",
    );
  } catch (error) {
    sendJson(response, 500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  reader: ResearchReader,
  root: string,
  csrfToken: string,
  options: ReaderWebServerOptions,
): Promise<void> {
  if (request.method !== "GET" && !validCsrf(request, csrfToken)) {
    sendJson(response, 403, { error: "Invalid CSRF token" });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/session") {
    sendJson(response, 200, { csrfToken });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/status") {
    sendJson(response, 200, await reader.status());
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, await reader.health());
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/papers") {
    sendJson(response, 200, await reader.listPapers());
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/corpus/ask") {
    const body = await jsonBody(request);
    const question = requiredString(body.question, "question");
    sendJson(
      response,
      200,
      await reader.askCorpus(question, llmOptions(options)),
    );
    return;
  }
  const match = url.pathname.match(
    /^\/api\/papers\/([A-Za-z0-9][A-Za-z0-9._-]{0,199})(?:\/(.*))?$/,
  );
  if (!match) {
    sendJson(response, 404, { error: "API route not found" });
    return;
  }
  const paperId = match[1]!;
  const action = match[2] ?? "";
  if (request.method === "GET" && !action) {
    const paper = await reader.getPaper(paperId);
    if (!paper) {
      sendJson(response, 404, { error: "Paper not found" });
      return;
    }
    sendJson(response, 200, paper);
    return;
  }
  if (request.method === "GET" && action === "reviews") {
    sendJson(response, 200, await reader.listReviews(paperId));
    return;
  }
  if (request.method === "GET" && action === "annotations") {
    sendJson(response, 200, await reader.annotations(paperId));
    return;
  }
  if (request.method === "POST" && action === "annotations") {
    const body = await jsonBody(request);
    sendJson(
      response,
      201,
      await reader.addAnnotation(paperId, {
        note: requiredString(body.note, "note"),
        ...(body.page === undefined
          ? {}
          : { page: positiveInteger(body.page, "page") }),
        ...(typeof body.selectedQuote === "string" && body.selectedQuote
          ? { selectedQuote: body.selectedQuote }
          : {}),
        ...(typeof body.drawingDataUrl === "string" && body.drawingDataUrl
          ? { drawingDataUrl: body.drawingDataUrl }
          : {}),
        ...(typeof body.voiceTranscript === "string" && body.voiceTranscript
          ? { voiceTranscript: body.voiceTranscript }
          : {}),
      }),
    );
    return;
  }
  if (request.method === "POST" && action === "mark") {
    const body = await jsonBody(request);
    sendJson(
      response,
      200,
      await reader.markPaper(paperId, readingStatus(body.status)),
    );
    return;
  }
  if (request.method === "POST" && action === "ask") {
    const body = await jsonBody(request);
    sendJson(
      response,
      200,
      await reader.askPaper(
        paperId,
        requiredString(body.question, "question"),
        llmOptions(options),
        typeof body.sessionId === "string" ? body.sessionId : undefined,
      ),
    );
    return;
  }
  if (request.method === "GET" && action === "text") {
    const paper = await reader.getPaper(paperId);
    const sourceId = paper?.acquisition.fullTextSourceId;
    if (!sourceId) {
      sendJson(response, 404, { error: "Paper has no full-text source" });
      return;
    }
    const source = await getSourceArtifact(sourceId, { root });
    if (!source) {
      sendJson(response, 404, { error: "Full-text source not found" });
      return;
    }
    sendText(response, 200, source.content, "text/plain; charset=utf-8");
    return;
  }
  if (request.method === "GET" && action === "pdf") {
    const pdf = await findRawPdf(root, paperId, reader);
    if (!pdf) {
      sendJson(response, 404, { error: "Local PDF is unavailable" });
      return;
    }
    response.writeHead(200, {
      "content-type": "application/pdf",
      "content-length": pdf.size,
      "cache-control": "private, no-store",
    });
    createReadStream(pdf.path).pipe(response);
    return;
  }
  sendJson(response, 404, { error: "Paper API route not found" });
}

async function findRawPdf(
  root: string,
  paperId: string,
  reader: ResearchReader,
): Promise<{ path: string; size: number } | undefined> {
  const paper = await reader.getPaper(paperId);
  const sourceId = paper?.acquisition.fullTextSourceId;
  if (!sourceId) return undefined;
  const [manifest, wikiConfig] = await Promise.all([
    new WikiCompiler({ root }).manifest(),
    loadConfig(root),
  ]);
  const entry = manifest.entries.find((item) => item.sourceId === sourceId);
  if (!entry || entry.mediaType !== "application/pdf") return undefined;
  for (const origin of entry.origins) {
    if (!origin.targetPath) continue;
    const candidate = path.resolve(wikiConfig.rawDir, origin.targetPath);
    if (!isContained(wikiConfig.rawDir, candidate) || !existsSync(candidate)) {
      continue;
    }
    const secure = await secureExistingPath(wikiConfig.rawDir, candidate);
    const file = await stat(secure);
    if (file.isFile()) return { path: secure, size: file.size };
  }
  return undefined;
}

async function serveStatic(
  response: ServerResponse,
  clientDir: string,
  pathname: string,
  head: boolean,
): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    sendJson(response, 400, { error: "Invalid URL encoding" });
    return;
  }
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  let candidate = path.resolve(clientDir, relative);
  if (!isContained(clientDir, candidate)) {
    sendJson(response, 404, { error: "Static path not found" });
    return;
  }
  if (!existsSync(candidate) || !(await stat(candidate)).isFile()) {
    candidate = path.resolve(clientDir, "index.html");
  }
  if (!isContained(clientDir, candidate) || !existsSync(candidate)) {
    sendJson(response, 404, { error: "Web client is not built" });
    return;
  }
  let secure: string;
  try {
    secure = await secureExistingPath(clientDir, candidate);
  } catch {
    sendJson(response, 404, { error: "Static path not found" });
    return;
  }
  const content = await readFile(secure);
  response.writeHead(200, {
    "content-type": mimeType(secure),
    "content-length": content.length,
    "cache-control": secure.endsWith("index.html")
      ? "no-store"
      : "public, max-age=31536000, immutable",
  });
  response.end(head ? undefined : content);
}

async function jsonBody(
  request: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_048_576) throw new Error("JSON request body is too large");
    chunks.push(buffer);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    throw new Error("Request body must be valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function llmOptions(options: ReaderWebServerOptions) {
  return {
    ...(options.approveLlm === true ? { approveLlm: true } : {}),
    ...(options.llmProvider ? { llmProvider: options.llmProvider } : {}),
    ...(options.maxLlmTokens === undefined
      ? {}
      : { maxLlmTokens: options.maxLlmTokens }),
  };
}

function validCsrf(request: IncomingMessage, token: string): boolean {
  return request.headers["x-reader-csrf"] === token;
}

function validHostHeader(value: string | undefined): boolean {
  return Boolean(
    value && /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(value),
  );
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function readingStatus(value: unknown): ReadingStatus {
  if (
    value !== "unread" &&
    value !== "queued" &&
    value !== "reading" &&
    value !== "read" &&
    value !== "revisit" &&
    value !== "dismissed"
  ) {
    throw new Error("Invalid reading status");
  }
  return value;
}

function isContained(root: string, target: string): boolean {
  const relationship = path.relative(path.resolve(root), path.resolve(target));
  return (
    relationship !== ".." &&
    !relationship.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relationship)
  );
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader(
    "content-security-policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'",
  );
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  const body = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendText(
  response: ServerResponse,
  status: number,
  value: string,
  contentType: string,
): void {
  const body = Buffer.from(value, "utf8");
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": body.length,
    "cache-control": "private, no-store",
  });
  response.end(body);
}

function mimeType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}
