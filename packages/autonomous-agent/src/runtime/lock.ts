import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export interface MissionLock {
  path: string;
  release(): Promise<void>;
}

interface LockMetadata {
  owner: string;
  pid: number;
  hostname: string;
  createdAt: string;
}

export async function acquireMissionLock(
  root: string,
  missionId: string,
  options: { staleMs?: number; owner?: string } = {},
): Promise<MissionLock> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(missionId)) {
    throw new Error(`Invalid mission ID for lock: ${missionId}`);
  }
  const locksDirectory = path.join(root, "runs", "locks");
  await mkdir(locksDirectory, { recursive: true });
  const lockPath = path.join(locksDirectory, `${missionId}.lock`);
  const owner = options.owner ?? `${process.pid}-${Date.now()}`;
  const staleMs = options.staleMs ?? 5 * 60_000;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      const metadata: LockMetadata = {
        owner,
        pid: process.pid,
        hostname: os.hostname(),
        createdAt: new Date().toISOString(),
      };
      await handle.writeFile(JSON.stringify(metadata), "utf8");
      await handle.close();
      return {
        path: lockPath,
        async release() {
          await releaseOwnedLock(lockPath, owner);
        },
      };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      if (attempt === 0 && (await isStaleLock(lockPath, staleMs))) {
        await rm(lockPath, { force: true });
        continue;
      }
      throw new Error(`Mission ${missionId} is already running`);
    }
  }
  throw new Error(`Unable to acquire mission lock for ${missionId}`);
}

async function releaseOwnedLock(
  lockPath: string,
  owner: string,
): Promise<void> {
  try {
    const metadata = JSON.parse(
      await readFile(lockPath, "utf8"),
    ) as LockMetadata;
    if (metadata.owner === owner) {
      await rm(lockPath, { force: true });
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

async function isStaleLock(
  lockPath: string,
  staleMs: number,
): Promise<boolean> {
  try {
    const [metadata, file] = await Promise.all([
      readFile(lockPath, "utf8").then(
        (content) => JSON.parse(content) as LockMetadata,
      ),
      stat(lockPath),
    ]);
    if (
      metadata.hostname === os.hostname() &&
      Number.isInteger(metadata.pid) &&
      processIsAlive(metadata.pid)
    ) {
      return false;
    }
    return Date.now() - file.mtimeMs > staleMs;
  } catch (error) {
    if (isNotFound(error)) return true;
    try {
      const file = await stat(lockPath);
      return Date.now() - file.mtimeMs > staleMs;
    } catch (statError) {
      return isNotFound(statError);
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
