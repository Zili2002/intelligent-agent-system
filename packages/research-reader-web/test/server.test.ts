import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { request as httpRequest } from "node:http";
import {
  ingestContent,
  type LlmProvider,
  type LlmRequest,
} from "@intelligent-agent-system/llm-wiki-compiler";
import {
  ResearchReader,
  type PaperPassport,
} from "@intelligent-agent-system/research-reader";
import { createReaderWebServer } from "../src/server/index.js";

const SOURCE_QUOTE =
  "World representations support predictive control for robots.";

class QuestionProvider implements LlmProvider {
  readonly name = "web-question";

  async complete(request: LlmRequest) {
    assert.equal(request.purpose, "query");
    return {
      text: JSON.stringify({
        answer: "The source connects representation and control.",
        citations: [SOURCE_QUOTE],
      }),
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }
}

function passport(sourceId: string): PaperPassport {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: "paper-web",
    canonicalKey: "work:paper-web:2026:reader",
    sourceIds: [sourceId],
    metadata: {
      id: "paper-web",
      title: "Web Reader Paper",
      url: "https://example.org/paper-web",
      provider: "fixture",
      year: 2026,
    },
    discovery: [],
    acquisition: { status: "available", fullTextSourceId: sourceId },
    reading: {
      status: "unread",
      priority: 50,
      userTags: [],
    },
    reviewIds: [],
    knowledge: {
      compiled: false,
      claimIds: [],
      wikiPaths: [],
    },
    lifecycle: {
      reviewStale: false,
      retracted: false,
    },
    createdAt: now,
    updatedAt: now,
  };
}

test("Web server is localhost-only and protects mutations with CSRF", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "reader-web-"));
  const clientDir = path.join(root, "client");
  await mkdir(clientDir, { recursive: true });
  await writeFile(
    path.join(clientDir, "index.html"),
    "<h1>Reader</h1>",
    "utf8",
  );
  await writeFile(path.join(clientDir, "worker.mjs"), "export {};", "utf8");
  const reader = new ResearchReader({ root });
  await reader.init();
  const source = await ingestContent(
    `# Introduction

${SOURCE_QUOTE}
`,
    "web-source.md",
    { root, title: "Web Reader Paper" },
  );
  await reader.savePaper(passport(source.artifact.id));
  await writeFile(path.join(root, "raw", "paper.pdf"), "%PDF-1.4\n", "utf8");
  await writeFile(
    path.join(root, "raw", "manifest.json"),
    `${JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      entries: [
        {
          sourceId: source.artifact.id,
          title: "Web Reader Paper",
          mediaType: "application/pdf",
          normalizedSha256: source.artifact.id,
          origins: [
            {
              kind: "file",
              input: "paper.pdf",
              targetPath: "paper.pdf",
              capturedAt: new Date().toISOString(),
              restoreMode: "existing",
            },
          ],
        },
      ],
    })}\n`,
    "utf8",
  );
  assert.throws(
    () =>
      createReaderWebServer({
        root,
        host: "0.0.0.0" as "127.0.0.1",
      }),
    /localhost/,
  );
  const web = createReaderWebServer({
    root,
    port: 0,
    clientDir,
    llmProvider: new QuestionProvider(),
  });
  try {
    const address = await web.start();
    const sessionResponse = await fetch(`${address.url}/api/session`);
    assert.equal(sessionResponse.status, 200);
    const session = (await sessionResponse.json()) as { csrfToken: string };
    const papers = await fetch(`${address.url}/api/papers`);
    assert.equal(papers.status, 200);
    assert.equal(((await papers.json()) as unknown[]).length, 1);
    assert.equal(
      await requestStatus(`${address.url}/api/status`, "evil.example"),
      403,
    );
    const text = await fetch(`${address.url}/api/papers/paper-web/text`);
    assert.match(await text.text(), /predictive control/);
    const pdf = await fetch(`${address.url}/api/papers/paper-web/pdf`);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");
    const worker = await fetch(`${address.url}/worker.mjs`);
    assert.match(worker.headers.get("content-type") ?? "", /text\/javascript/);

    const rejected = await fetch(
      `${address.url}/api/papers/paper-web/annotations`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: "Missing CSRF" }),
      },
    );
    assert.equal(rejected.status, 403);
    const created = await fetch(
      `${address.url}/api/papers/paper-web/annotations`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-reader-csrf": session.csrfToken,
        },
        body: JSON.stringify({
          selectedQuote: SOURCE_QUOTE,
          note: "Grounded annotation",
        }),
      },
    );
    assert.equal(created.status, 201);
    const answer = await fetch(`${address.url}/api/papers/paper-web/ask`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-reader-csrf": session.csrfToken,
      },
      body: JSON.stringify({
        question: "How are representation and control connected?",
      }),
    });
    assert.equal(answer.status, 200);
    assert.equal(
      ((await answer.json()) as { citations: unknown[] }).citations.length,
      1,
    );
    const traversal = await fetch(`${address.url}/..%2fsecret.txt`);
    assert.equal(traversal.status, 404);
    assert.equal(sessionResponse.headers.get("x-frame-options"), "DENY");
  } finally {
    await web.stop();
    await rm(root, { recursive: true, force: true });
  }
});

function requestStatus(url: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { headers: { host } }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    request.once("error", reject);
    request.end();
  });
}
