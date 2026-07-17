import {
  LlmUsageTracker,
  WikiCompiler,
  findEvidenceAnchor,
  getSourceArtifact,
  loadConfig,
  querySource,
  requestJson,
  requireLlm,
  type LlmProvider,
} from "@intelligent-agent-system/llm-wiki-compiler";
import type {
  PaperPassport,
  ReaderQuestionOptions,
  ReadingQuestion,
  ResolvedReaderConfig,
} from "./types.js";

export async function answerPaperQuestion(
  config: ResolvedReaderConfig,
  paper: PaperPassport,
  question: string,
  options: ReaderQuestionOptions = {},
): Promise<ReadingQuestion> {
  if (!question.trim()) throw new Error("Question must not be empty");
  const sourceId = paper.acquisition.fullTextSourceId;
  if (!sourceId) {
    throw new Error(`Paper ${paper.id} has no acquired full-text source`);
  }
  const source = await getSourceArtifact(sourceId, { root: config.root });
  if (!source) throw new Error(`Full-text source not found: ${sourceId}`);
  const matches = querySource(source, question, 8);
  if (!matches.length) {
    return {
      question,
      answer: "No evidence in this paper matched the question.",
      citations: [],
    };
  }
  const provider = await resolveQuestionLlm(config, options);
  const usage = new LlmUsageTracker(options.maxLlmTokens);
  const raw = await requestJson(
    provider,
    {
      purpose: "query",
      maxTokens: 2_500,
      prompt: `Answer the question only from the supplied paper excerpts. Return JSON {answer:string,citations:string[]} where every citation is one exact verbatim quote copied from an excerpt. If the excerpts do not answer the question, answer that evidence is insufficient and return no citations.
Question: ${question}
Excerpts: ${JSON.stringify(matches.map((match) => match.excerpt))}`,
    },
    parseQuestionResponse,
    usage,
  );
  const citations = raw.citations.map((quote) => {
    if (!matches.some((match) => match.excerpt.includes(quote))) {
      throw new Error("Paper answer cited text outside supplied excerpts");
    }
    return findEvidenceAnchor(source, quote);
  });
  return {
    question,
    answer: raw.answer,
    citations,
  };
}

export async function answerCorpusQuestion(
  config: ResolvedReaderConfig,
  question: string,
  options: ReaderQuestionOptions = {},
) {
  const wiki = new WikiCompiler({
    root: config.root,
    ...(options.approveLlm === true ? { approveLlm: true } : {}),
    ...(options.llmProvider ? { llmProvider: options.llmProvider } : {}),
    ...(options.maxLlmTokens === undefined
      ? {}
      : { maxLlmTokens: options.maxLlmTokens }),
  });
  return wiki.query(question);
}

async function resolveQuestionLlm(
  config: ResolvedReaderConfig,
  options: ReaderQuestionOptions,
): Promise<LlmProvider> {
  if (options.llmProvider) return options.llmProvider;
  const wikiConfig = await loadConfig(config.root);
  return requireLlm(wikiConfig, {
    root: config.root,
    ...(options.approveLlm === true ? { approveLlm: true } : {}),
    ...(options.maxLlmTokens === undefined
      ? {}
      : { maxLlmTokens: options.maxLlmTokens }),
  });
}

function parseQuestionResponse(value: unknown): {
  answer: string;
  citations: string[];
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Paper answer must be an object");
  }
  const data = value as Record<string, unknown>;
  if (typeof data.answer !== "string" || !data.answer.trim()) {
    throw new Error("Paper answer must contain answer text");
  }
  if (
    !Array.isArray(data.citations) ||
    data.citations.some((item) => typeof item !== "string" || !item.trim())
  ) {
    throw new Error("Paper answer citations must be strings");
  }
  return { answer: data.answer.trim(), citations: data.citations };
}
