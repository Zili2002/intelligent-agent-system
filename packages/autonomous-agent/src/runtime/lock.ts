import path from "node:path";
import { acquireFileLock } from "@intelligent-agent/shared";

export interface MissionLock {
  path: string;
  release(): Promise<void>;
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
  const lockPath = path.join(locksDirectory, `${missionId}.lock`);
  try {
    const lock = await acquireFileLock(lockPath, options);
    return {
      path: lock.path,
      release: lock.release,
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Lock is already held:")
    ) {
      throw new Error(`Mission ${missionId} is already running`, {
        cause: error,
      });
    }
    throw error;
  }
}
