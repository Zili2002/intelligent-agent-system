import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface FileLock {
  path: string;
  owner: string;
  release(): Promise<void>;
}

export interface FileLockOptions {
  staleMs?: number;
  owner?: string;
  waitTimeoutMs?: number;
  retryDelayMs?: number;
}

interface FileLockMetadata {
  owner: string;
  pid: number;
  hostname: string;
  createdAt: string;
}

export async function acquireFileLock(
  lockPath: string,
  options: FileLockOptions = {},
): Promise<FileLock> {
  if (!lockPath.trim()) throw new Error("Lock path must not be empty");
  await mkdir(path.dirname(lockPath), { recursive: true });
  const owner = options.owner ?? `${process.pid}-${randomUUID()}`;
  const staleMs = options.staleMs ?? 5 * 60_000;
  const waitTimeoutMs = options.waitTimeoutMs ?? 0;
  const retryDelayMs = options.retryDelayMs ?? 10;
  if (!Number.isFinite(staleMs) || staleMs < 0) {
    throw new Error("staleMs must be a non-negative finite number");
  }
  if (!Number.isFinite(waitTimeoutMs) || waitTimeoutMs < 0) {
    throw new Error("waitTimeoutMs must be a non-negative finite number");
  }
  if (!Number.isFinite(retryDelayMs) || retryDelayMs < 1) {
    throw new Error("retryDelayMs must be a positive finite number");
  }
  const deadline = Date.now() + waitTimeoutMs;

  for (;;) {
    try {
      const handle = await open(lockPath, "wx");
      const metadata: FileLockMetadata = {
        owner,
        pid: process.pid,
        hostname: os.hostname(),
        createdAt: new Date().toISOString(),
      };
      try {
        await handle.writeFile(`${JSON.stringify(metadata)}\n`, "utf8");
      } catch (error) {
        await handle.close();
        await removeLock(lockPath);
        throw error;
      }
      await handle.close();
      return {
        path: lockPath,
        owner,
        async release() {
          await releaseOwnedLock(lockPath, owner);
        },
      };
    } catch (error) {
      const contention =
        isAlreadyExists(error) ||
        (isAccessDenied(error) &&
          ((await lockAppearsPresent(lockPath)) || waitTimeoutMs > 0));
      if (!contention) throw error;
      if (await recoverStaleLock(lockPath, staleMs)) {
        continue;
      }
      if (Date.now() < deadline) {
        await delay(Math.min(retryDelayMs, Math.max(1, deadline - Date.now())));
        continue;
      }
      throw new Error(`Lock is already held: ${lockPath}`);
    }
  }

  async function recoverStaleLock(
    lockPath: string,
    staleMs: number,
  ): Promise<boolean> {
    const recoveryPath = `${lockPath}.recovery`;
    const recovery = await tryAcquireRecoveryGuard(recoveryPath, staleMs);
    if (!recovery) return false;
    try {
      if (!(await ownsLock(recoveryPath, recovery.owner))) return false;
      if (!(await isStaleLock(lockPath, staleMs))) return false;
      if (!(await ownsLock(recoveryPath, recovery.owner))) return false;
      await removeLock(lockPath);
      return true;
    } finally {
      await releaseOwnedLock(recoveryPath, recovery.owner);
    }
  }

  async function tryAcquireRecoveryGuard(
    recoveryPath: string,
    staleMs: number,
  ): Promise<{ owner: string } | undefined> {
    const owner = `${process.pid}-${randomUUID()}`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(recoveryPath, "wx");
        try {
          await handle.writeFile(
            `${JSON.stringify({
              owner,
              pid: process.pid,
              hostname: os.hostname(),
              createdAt: new Date().toISOString(),
            } satisfies FileLockMetadata)}\n`,
            "utf8",
          );
        } finally {
          await handle.close();
        }
        return { owner };
      } catch (error) {
        const contention = isAlreadyExists(error) || isAccessDenied(error);
        if (!contention) throw error;
        if (attempt === 0 && (await isStaleLock(recoveryPath, staleMs))) {
          await removeLock(recoveryPath);
          continue;
        }
        return undefined;
      }
    }
    return undefined;
  }

  async function ownsLock(lockPath: string, owner: string): Promise<boolean> {
    return (await readLockMetadata(lockPath))?.owner === owner;
  }
}

export async function withFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const lock = await acquireFileLock(lockPath, options);
  try {
    return await operation();
  } finally {
    await lock.release();
  }
}

async function releaseOwnedLock(
  lockPath: string,
  owner: string,
): Promise<void> {
  const metadata = await readLockMetadata(lockPath);
  if (metadata?.owner === owner) {
    await removeLock(lockPath);
  }
}

async function readLockMetadata(
  lockPath: string,
): Promise<FileLockMetadata | undefined> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return JSON.parse(await readFile(lockPath, "utf8")) as FileLockMetadata;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      if (
        (isAccessDenied(error) || error instanceof SyntaxError) &&
        attempt < 19
      ) {
        await delay(5);
        continue;
      }
      if (isAccessDenied(error) || error instanceof SyntaxError) {
        return undefined;
      }
      throw error;
    }
  }
  return undefined;
}

async function isStaleLock(
  lockPath: string,
  staleMs: number,
): Promise<boolean> {
  try {
    const [content, file] = await Promise.all([
      readFile(lockPath, "utf8"),
      stat(lockPath),
    ]);
    let metadata: FileLockMetadata | undefined;
    try {
      metadata = JSON.parse(content) as FileLockMetadata;
    } catch {
      metadata = undefined;
    }
    if (
      metadata?.hostname === os.hostname() &&
      Number.isInteger(metadata.pid) &&
      processIsAlive(metadata.pid)
    ) {
      return false;
    }
    return Date.now() - file.mtimeMs > staleMs;
  } catch (error) {
    if (isNotFound(error)) return true;
    if (isAccessDenied(error)) return false;
    try {
      const file = await stat(lockPath);
      return Date.now() - file.mtimeMs > staleMs;
    } catch (statError) {
      if (isNotFound(statError)) return true;
      if (isAccessDenied(statError)) return false;
      throw statError;
    }
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EPERM"
    );
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isAccessDenied(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EPERM" ||
      error.code === "EACCES" ||
      error.code === "EBUSY")
  );
}

async function removeLock(lockPath: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rm(lockPath, { force: true });
      return;
    } catch (error) {
      if (isNotFound(error)) return;
      if (!isAccessDenied(error) || attempt === 19) throw error;
      await delay(5);
    }
  }
}

async function lockAppearsPresent(lockPath: string): Promise<boolean> {
  try {
    await stat(lockPath);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    if (isAccessDenied(error)) return true;
    throw error;
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
