import path from "node:path";
import type { ResolvedReaderConfig } from "./types.js";

const PROFILE_FILE = "profile.json";
const SUBSCRIPTIONS_FILE = "subscriptions.json";

export function profilePath(config: ResolvedReaderConfig): string {
  return path.join(config.metaDir, PROFILE_FILE);
}

export function subscriptionsPath(config: ResolvedReaderConfig): string {
  return path.join(config.metaDir, SUBSCRIPTIONS_FILE);
}
