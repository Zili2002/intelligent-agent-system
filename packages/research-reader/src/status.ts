import type {
  ReaderStatus,
  ReadingStatus,
  ResolvedReaderConfig,
} from "./types.js";
import {
  listPaperPassports,
  listPaperReviews,
  listReadingSessions,
  loadMigrationState,
  loadSubscriptions,
} from "./store.js";
import { listTrackingRuns } from "./tracking.js";

export async function getReaderStatus(
  config: ResolvedReaderConfig,
): Promise<ReaderStatus> {
  const [papers, reviews, sessions, subscriptions, migration, runs] =
    await Promise.all([
      listPaperPassports(config),
      listPaperReviews(config),
      listReadingSessions(config),
      loadSubscriptions(config),
      loadMigrationState(config),
      listTrackingRuns(config, 10_000),
    ]);
  const readingByStatus: Record<ReadingStatus, number> = {
    unread: 0,
    queued: 0,
    reading: 0,
    read: 0,
    revisit: 0,
    dismissed: 0,
  };
  for (const paper of papers) readingByStatus[paper.reading.status] += 1;
  return {
    root: config.root,
    configPath: config.configPath,
    schemaVersion: migration?.schemaVersion ?? 0,
    subscriptions: subscriptions?.items.length ?? 0,
    papers: papers.length,
    reviews: reviews.length,
    sessions: sessions.length,
    runs: runs.length,
    readingByStatus,
  };
}
