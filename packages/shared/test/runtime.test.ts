import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acquireFileLock,
  appendJsonLine,
  atomicWriteJson,
  readJsonIfExists,
  readJsonLines,
  redactSecrets,
  sanitizeJson,
  withFileLock,
  withRetry,
} from "../src/index.js";

function parseRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value as Record<string, unknown>;
}

test("atomic JSON creates parent directories and replaces complete values", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shared-atomic-"));
  const target = path.join(root, "nested", "value.json");
  try {
    await atomicWriteJson(target, { version: 1, value: "first" });
    await atomicWriteJson(target, { version: 2, value: "second" });
    const parsed = await readJsonIfExists(target, parseRecord);
    assert.deepEqual(parsed, { version: 2, value: "second" });
    assert.equal(
      await readJsonIfExists(path.join(root, "missing.json"), parseRecord),
      undefined,
    );
    assert.equal((await readFile(target, "utf8")).endsWith("\n"), true);
    await assert.rejects(
      () => atomicWriteJson(target, undefined),
      /JSON-serializable/,
    );
  } finally {
    await removeWithRetry(root);
  }
});

test("file locks exclude concurrent owners and recover stale locks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shared-file-lock-"));
  const lockPath = path.join(root, "locks", "reader.lock");
  try {
    const first = await acquireFileLock(lockPath);
    await assert.rejects(() => acquireFileLock(lockPath), /already held/);
    await first.release();

    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(
      lockPath,
      `${JSON.stringify({
        owner: "stale",
        pid: 999_999,
        hostname: os.hostname(),
        createdAt: new Date(0).toISOString(),
      })}\n`,
      "utf8",
    );
    const old = new Date(Date.now() - 60_000);
    await utimes(lockPath, old, old);
    const recovered = await acquireFileLock(lockPath, { staleMs: 1 });
    await recovered.release();

    await writeFile(
      lockPath,
      JSON.stringify({
        owner: "stale-race",
        pid: 999_999,
        hostname: os.hostname(),
        createdAt: new Date(0).toISOString(),
      }),
      "utf8",
    );
    await utimes(lockPath, old, old);
    const contenders = await Promise.allSettled([
      acquireFileLock(lockPath, { staleMs: 1 }),
      acquireFileLock(lockPath, { staleMs: 1 }),
    ]);
    const winners = contenders.filter(
      (
        contender,
      ): contender is PromiseFulfilledResult<
        Awaited<ReturnType<typeof acquireFileLock>>
      > => contender.status === "fulfilled",
    );
    assert.equal(winners.length, 1);
    await winners[0]!.value.release();

    const result = await withFileLock(lockPath, async () => "done");
    assert.equal(result, "done");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retry applies bounded backoff and stops on non-transient failures", async () => {
  const delays: number[] = [];
  let attempts = 0;
  const result = await withRetry(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("HTTP 503 temporary failure");
      return "ok";
    },
    { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 100 },
    { sleep: async (milliseconds) => void delays.push(milliseconds) },
  );
  assert.equal(result.value, "ok");
  assert.equal(result.attempts, 3);
  assert.deepEqual(delays, [10, 20]);

  let invalidAttempts = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          invalidAttempts += 1;
          throw new Error("invalid reader configuration");
        },
        { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 2 },
      ),
    /invalid/,
  );
  assert.equal(invalidAttempts, 1);
});

test("JSONL redacts secrets, preserves order, and supports tail limits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "shared-jsonl-"));
  const target = path.join(root, "runs", "history.jsonl");
  try {
    await appendJsonLine(target, {
      index: 1,
      message: "ANTHROPIC_AUTH_TOKEN=secret-value",
    });
    await appendJsonLine(target, {
      index: 2,
      nested: { authorization: "Authorization: Bearer private-token" },
    });
    const records = await readJsonLines(target, parseRecord);
    assert.equal(records.length, 2);
    assert.equal(JSON.stringify(records).includes("secret-value"), false);
    assert.equal(JSON.stringify(records).includes("private-token"), false);
    const tail = await readJsonLines(target, parseRecord, { limit: 1 });
    assert.equal(tail[0]?.index, 2);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        appendJsonLine(target, { index: index + 3 }),
      ),
    );
    assert.equal((await readJsonLines(target, parseRecord)).length, 22);
  } finally {
    await removeWithRetry(root);
  }
});

test("redaction sanitizes nested values without changing non-secret data", () => {
  assert.equal(
    redactSecrets("OPENALEX_API_KEY=secret-value plain"),
    "OPENALEX_API_KEY=[REDACTED] plain",
  );
  assert.deepEqual(
    sanitizeJson({
      token: "api-abcdefghijklmnop",
      values: ["safe", "PASSWORD=hunter2"],
    }),
    {
      token: "[REDACTED]",
      values: ["safe", "PASSWORD=[REDACTED]"],
    },
  );
  assert.deepEqual(
    sanitizeJson({
      password: "plain",
      accessToken: "plain",
      api_key: "plain",
      inputTokens: 123,
    }),
    {
      password: "[REDACTED]",
      accessToken: "[REDACTED]",
      api_key: "[REDACTED]",
      inputTokens: 123,
    },
  );
});

async function removeWithRetry(target: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if (
        attempt === 4 ||
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        (error.code !== "ENOTEMPTY" && error.code !== "EPERM")
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
