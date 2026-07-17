import path from "node:path";
import { atomicWriteJson, readJsonIfExists } from "@intelligent-agent/shared";
import type { ReaderMigrationState, ResolvedReaderConfig } from "./types.js";
import { READER_SCHEMA_VERSION } from "./types.js";

const MIGRATION_STATE_FILE = "state.json";

export async function ensureMigrationState(
  config: ResolvedReaderConfig,
): Promise<ReaderMigrationState> {
  const filePath = migrationStatePath(config);
  const existing = await readJsonIfExists(filePath, parseMigrationState);
  if (existing) {
    if (existing.schemaVersion > READER_SCHEMA_VERSION) {
      throw new Error(
        `Reader schema ${existing.schemaVersion} is newer than supported schema ${READER_SCHEMA_VERSION}`,
      );
    }
    return existing;
  }
  const state: ReaderMigrationState = {
    version: 1,
    schemaVersion: READER_SCHEMA_VERSION,
    applied: [],
  };
  await atomicWriteJson(filePath, state);
  return state;
}

export function parseMigrationState(value: unknown): ReaderMigrationState {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("version" in value) ||
    value.version !== 1 ||
    !("schemaVersion" in value) ||
    typeof value.schemaVersion !== "number" ||
    !Number.isInteger(value.schemaVersion) ||
    !("applied" in value) ||
    !Array.isArray(value.applied)
  ) {
    throw new Error("Invalid Reader migration state");
  }
  return value as ReaderMigrationState;
}

export function migrationStatePath(config: ResolvedReaderConfig): string {
  return path.join(config.migrationsDir, MIGRATION_STATE_FILE);
}
