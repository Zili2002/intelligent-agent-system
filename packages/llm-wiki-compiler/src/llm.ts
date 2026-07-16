import Anthropic from "@anthropic-ai/sdk";
import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  ResolvedWikiConfig,
  ServiceOptions,
} from "./types.js";

const ANSI_ESCAPE = /\u001B\[[0-?]*[ -/]*[@-~]/g;
const TRANSIENT_LLM_ATTEMPTS = 3;

export function isRetryableLlmTransportError(error: unknown): boolean {
  const status =
    error && typeof error === "object" && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
  return (
    typeof status === "number" &&
    (status === 408 ||
      status === 409 ||
      status === 429 ||
      status === 499 ||
      status >= 500)
  );
}

async function completeWithRetry(
  provider: LlmProvider,
  request: LlmRequest,
): Promise<LlmResponse> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await provider.complete(request);
    } catch (error) {
      if (
        attempt >= TRANSIENT_LLM_ATTEMPTS ||
        !isRetryableLlmTransportError(error)
      ) {
        throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, 1_000 * 2 ** (attempt - 1)),
      );
    }
  }
}

export function cleanModel(value: string): string {
  return value
    .replace(ANSI_ESCAPE, "")
    .replace(/\[[0-9;]*m\]?/g, "")
    .trim();
}

export class WikiLlmResponseError extends Error {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  readonly stopReason: string | null | undefined;
  readonly purpose: LlmRequest["purpose"];
  readonly responseText: string | undefined;

  constructor(
    message: string,
    request: LlmRequest,
    response?: LlmResponse,
    totalUsage?: LlmResponse["usage"],
  ) {
    super(message);
    this.name = "WikiLlmResponseError";
    this.purpose = request.purpose;
    this.inputTokens = totalUsage?.inputTokens ?? response?.usage?.inputTokens;
    this.outputTokens =
      totalUsage?.outputTokens ?? response?.usage?.outputTokens;
    this.stopReason = response?.stopReason;
    this.responseText = response?.text;
  }

  addUsage(usage?: LlmResponse["usage"]): void {
    this.inputTokens = (this.inputTokens ?? 0) + (usage?.inputTokens ?? 0);
    this.outputTokens = (this.outputTokens ?? 0) + (usage?.outputTokens ?? 0);
  }
}

export class LlmUsageTracker {
  #inputTokens = 0;
  #outputTokens = 0;
  #reservedTokens = 0;
  readonly #maxTokens: number | undefined;

  constructor(maxTokens?: number) {
    if (
      maxTokens !== undefined &&
      (!Number.isInteger(maxTokens) || maxTokens < 1)
    ) {
      throw new Error("maxLlmTokens must be a positive integer");
    }
    this.#maxTokens = maxTokens;
  }

  boundRequest(request: LlmRequest): LlmRequest {
    if (this.#maxTokens === undefined) return request;
    const estimatedInputTokens =
      Buffer.byteLength(request.prompt, "utf8") + 256;
    const availableOutputTokens =
      this.#maxTokens -
      this.#inputTokens -
      this.#outputTokens -
      this.#reservedTokens -
      estimatedInputTokens;
    if (availableOutputTokens < 128) {
      throw new WikiLlmResponseError(
        `LLM ${request.purpose} request cannot fit within the remaining token budget (${estimatedInputTokens} input tokens estimated, ${this.#maxTokens - this.#inputTokens - this.#outputTokens - this.#reservedTokens} total tokens remaining)`,
        request,
        undefined,
        this.result(),
      );
    }
    return {
      ...request,
      maxTokens: Math.min(request.maxTokens, Math.floor(availableOutputTokens)),
    };
  }

  add(usage?: LlmResponse["usage"]): void {
    this.#inputTokens += usage?.inputTokens ?? 0;
    this.#outputTokens += usage?.outputTokens ?? 0;
  }

  reserveRequest(request: LlmRequest): {
    request: LlmRequest;
    commit: (usage?: LlmResponse["usage"]) => void;
    release: () => void;
  } {
    const bounded = this.boundRequest(request);
    if (this.#maxTokens === undefined) {
      let settled = false;
      return {
        request: bounded,
        commit: (usage) => {
          if (settled) return;
          settled = true;
          this.add(usage);
        },
        release: () => {
          settled = true;
        },
      };
    }
    const estimatedInputTokens =
      Buffer.byteLength(bounded.prompt, "utf8") + 256;
    const reservation = estimatedInputTokens + bounded.maxTokens;
    this.#reservedTokens += reservation;
    let settled = false;
    const settle = (usage?: LlmResponse["usage"]) => {
      if (settled) return;
      settled = true;
      this.#reservedTokens -= reservation;
      this.add(usage);
    };
    return {
      request: bounded,
      commit: settle,
      release: () => settle(),
    };
  }

  result() {
    return { inputTokens: this.#inputTokens, outputTokens: this.#outputTokens };
  }
}

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly #client: Anthropic;
  readonly #model: string;
  readonly #thinking: ResolvedWikiConfig["llm"]["thinking"];

  constructor(config: ResolvedWikiConfig) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const authToken = process.env.ANTHROPIC_AUTH_TOKEN;
    if (!apiKey && !authToken) {
      throw new Error(
        "LLM knowledge operations require ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN, or an injected llmProvider.",
      );
    }
    this.#model = cleanModel(process.env.ANTHROPIC_MODEL ?? config.llm.model);
    this.#thinking = config.llm.thinking;
    if (!this.#model) throw new Error("Anthropic model must not be empty");
    this.#client = new Anthropic({
      ...(apiKey ? { apiKey } : {}),
      ...(authToken ? { authToken } : {}),
      ...(process.env.ANTHROPIC_BASE_URL
        ? { baseURL: process.env.ANTHROPIC_BASE_URL }
        : {}),
    });
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const response = await this.#client.messages.create({
      model: this.#model,
      max_tokens: request.maxTokens,
      ...(this.#thinking.type === "adaptive"
        ? {
            thinking: { type: "adaptive" as const },
            output_config: { effort: this.#thinking.effort },
          }
        : { temperature: 0 }),
      system:
        "You are an evidence-grounded research compiler. Return only a single JSON object; never use Markdown fences.",
      messages: [{ role: "user", content: request.prompt }],
    });
    const text = response.content
      .filter(
        (block): block is Extract<typeof block, { type: "text" }> =>
          block.type === "text",
      )
      .map((block) => block.text)
      .join("");
    if (!text)
      throw new WikiLlmResponseError(
        `Anthropic ${request.purpose} returned no text`,
        request,
        {
          text: "",
          usage: {
            inputTokens: response.usage.input_tokens,
            outputTokens: response.usage.output_tokens,
          },
          stopReason: response.stop_reason,
        },
      );
    return {
      text,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      stopReason: response.stop_reason,
    };
  }
}

export function requireLlm(
  config: ResolvedWikiConfig,
  options: ServiceOptions,
): LlmProvider {
  if (!config.researchFocus.trim()) {
    throw new Error(
      "LLM knowledge operations require a non-empty researchFocus in .llmwiki-config.json.",
    );
  }
  if (options.llmProvider) return options.llmProvider;
  if (!options.approveLlm) {
    throw new Error(
      "LLM knowledge operations require explicit approval. Pass approveLlm: true or use --approve-llm.",
    );
  }
  return new AnthropicProvider(config);
}

function escapeJsonStringControls(value: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (const character of value) {
    if (!inString) {
      output += character;
      if (character === '"') inString = true;
      continue;
    }
    if (escaped) {
      output += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      output += character;
      escaped = true;
      continue;
    }
    if (character === '"') {
      output += character;
      inString = false;
      continue;
    }
    const code = character.charCodeAt(0);
    if (code <= 0x1f) {
      output +=
        character === "\b"
          ? "\\b"
          : character === "\f"
            ? "\\f"
            : character === "\n"
              ? "\\n"
              : character === "\r"
                ? "\\r"
                : character === "\t"
                  ? "\\t"
                  : `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    output += character;
  }
  return output;
}

function closeJsonContainers(value: string): string | undefined {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const character of value) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      stack.push("}");
    } else if (character === "[") {
      stack.push("]");
    } else if (character === "}" || character === "]") {
      if (stack.pop() !== character) return undefined;
    }
  }
  if (inString || escaped || !stack.length) return undefined;
  return `${value}${stack.reverse().join("")}`;
}

export async function requestJson<T>(
  provider: LlmProvider,
  request: LlmRequest,
  validate: (value: unknown) => T,
  tracker?: LlmUsageTracker,
): Promise<T> {
  const reservation = tracker?.reserveRequest(request);
  const boundedRequest = reservation?.request ?? request;
  let response: LlmResponse;
  try {
    response = await completeWithRetry(provider, boundedRequest);
    reservation?.commit(response.usage);
  } catch (error) {
    if (error instanceof WikiLlmResponseError) {
      reservation?.commit({
        ...(error.inputTokens === undefined
          ? {}
          : { inputTokens: error.inputTokens }),
        ...(error.outputTokens === undefined
          ? {}
          : { outputTokens: error.outputTokens }),
      });
    } else {
      reservation?.release();
    }
    throw error;
  }
  const totalUsage = tracker?.result();
  const usage = response.usage
    ? ` (input=${response.usage.inputTokens ?? "unknown"}, output=${response.usage.outputTokens ?? "unknown"})`
    : "";
  if (response.stopReason === "max_tokens") {
    throw new WikiLlmResponseError(
      `LLM ${request.purpose} response was truncated${usage}`,
      boundedRequest,
      response,
      totalUsage,
    );
  }
  const trimmed = response.text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i);
  const json = fenced ? (fenced[1] ?? "") : trimmed;
  if (trimmed.startsWith("```") && !fenced) {
    throw new WikiLlmResponseError(
      `LLM ${request.purpose} returned invalid JSON${usage}: expected one surrounding JSON fence only`,
      boundedRequest,
      response,
      totalUsage,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    const escapedControls = escapeJsonStringControls(json);
    try {
      parsed = JSON.parse(escapedControls);
    } catch {
      const closed = closeJsonContainers(escapedControls);
      try {
        if (!closed) throw new Error("JSON containers cannot be repaired");
        parsed = JSON.parse(closed);
      } catch {
        throw new WikiLlmResponseError(
          `LLM ${request.purpose} returned invalid JSON${usage}: ${error instanceof Error ? error.message : String(error)}`,
          boundedRequest,
          response,
          totalUsage,
        );
      }
    }
  }
  try {
    return validate(parsed);
  } catch (error) {
    throw new WikiLlmResponseError(
      `LLM ${request.purpose} returned invalid schema${usage}: ${error instanceof Error ? error.message : String(error)}`,
      boundedRequest,
      response,
      totalUsage,
    );
  }
}
