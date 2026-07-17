import { generateDailyTrackingReport } from "./reports.js";
import { listPaperPassports } from "./store.js";
import { listTrackingRuns } from "./tracking.js";
import type { ResolvedReaderConfig } from "./types.js";

export async function generateLatestDailyReport(
  config: ResolvedReaderConfig,
): Promise<{ markdownPath: string; jsonPath: string }> {
  const run = (await listTrackingRuns(config, 100)).find(
    (item) => item.status === "completed",
  );
  if (!run) throw new Error("No completed tracking run is available");
  const papers = (await listPaperPassports(config)).filter((paper) =>
    paper.discovery.some((discovery) => discovery.runId === run.id),
  );
  return generateDailyTrackingReport(
    config,
    run,
    papers,
    run.startedAt.slice(0, 10),
  );
}
