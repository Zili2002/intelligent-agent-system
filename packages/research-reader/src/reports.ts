import path from "node:path";
import { atomicWriteJson, atomicWriteText } from "@intelligent-agent/shared";
import type {
  PaperPassport,
  ReaderTrackingRun,
  ResolvedReaderConfig,
} from "./types.js";
import { listFeedback } from "./feedback.js";
import {
  listPaperPassports,
  listPaperReviews,
  listReadingSessions,
  loadResearchProfile,
} from "./store.js";

export async function generateDailyTrackingReport(
  config: ResolvedReaderConfig,
  run: ReaderTrackingRun,
  papers: PaperPassport[],
  date: string,
): Promise<{ markdownPath: string; jsonPath: string }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error("Daily report date must be YYYY-MM-DD");
  }
  const sorted = [...papers].sort(
    (left, right) =>
      right.reading.priority - left.reading.priority ||
      left.metadata.title.localeCompare(right.metadata.title),
  );
  const groups = {
    priority: sorted.filter(
      (paper) => paper.triage?.recommendation === "priority",
    ),
    deepRead: sorted.filter(
      (paper) => paper.triage?.recommendation === "deep-read",
    ),
    skim: sorted.filter((paper) => paper.triage?.recommendation === "skim"),
    archive: sorted.filter(
      (paper) => paper.triage?.recommendation === "archive",
    ),
    manualReview: sorted.filter(
      (paper) => paper.triage?.recommendation === "manual-review",
    ),
  };
  const markdownPath = path.join(config.dailyReportsDir, `${date}.md`);
  const jsonPath = path.join(config.dailyReportsDir, `${date}.json`);
  const markdown = `# Research Reader Daily Report - ${date}

## Run

- Run ID: ${run.id}
- Subscriptions: ${run.subscriptions}
- Searches: ${run.searches}
- Candidates: ${run.candidates}
- Created: ${run.created}
- Updated: ${run.updated}
- LLM input Tokens: ${run.usage?.inputTokens ?? 0}
- LLM output Tokens: ${run.usage?.outputTokens ?? 0}
- Errors: ${run.errors.length}

${section("Priority", groups.priority)}
${section("Deep Read", groups.deepRead)}
${section("Skim", groups.skim)}
${section("Manual Review", groups.manualReview)}
${section("Archive", groups.archive)}
## Errors

${run.errors.map((error) => `- ${error}`).join("\n") || "_None._"}
`;
  await Promise.all([
    atomicWriteText(markdownPath, markdown),
    atomicWriteJson(jsonPath, {
      version: 1,
      date,
      run,
      paperIds: sorted.map((paper) => paper.id),
      groups: Object.fromEntries(
        Object.entries(groups).map(([name, items]) => [
          name,
          items.map((paper) => paper.id),
        ]),
      ),
    }),
  ]);
  return { markdownPath, jsonPath };
}

function section(title: string, papers: PaperPassport[]): string {
  const rows = papers.map((paper) => {
    const triage = paper.triage;
    return `### ${paper.metadata.title}

- Paper ID: ${paper.id}
- Relevance: ${triage?.relevanceScore.toFixed(2) ?? "unknown"}
- Confidence: ${triage?.confidence.toFixed(2) ?? "unknown"}
- Evidence: ${paper.acquisition.status}
- Reasons: ${triage?.reasons.join("; ") || "none"}
`;
  });
  return `## ${title} (${papers.length})

${rows.join("\n") || "_None._"}
`;
}

export async function generateWeeklyReport(
  config: ResolvedReaderConfig,
  now = new Date(),
): Promise<{ markdownPath: string; jsonPath: string }> {
  const [papers, reviews, sessions, feedback, profile] = await Promise.all([
    listPaperPassports(config),
    listPaperReviews(config),
    listReadingSessions(config),
    listFeedback(config),
    loadResearchProfile(config),
  ]);
  const week = isoWeek(now);
  const recentBoundary = now.getTime() - 7 * 86_400_000;
  const recentSessions = sessions.filter(
    (session) => Date.parse(session.updatedAt) >= recentBoundary,
  );
  const recentFeedback = feedback.filter(
    (event) => Date.parse(event.createdAt) >= recentBoundary,
  );
  const topicCounts = titleTopics(papers);
  const markdownPath = path.join(config.weeklyReportsDir, `${week}.md`);
  const jsonPath = path.join(config.weeklyReportsDir, `${week}.json`);
  const markdown = `# Research Reader Weekly Report - ${week}

## Activity

- Papers tracked: ${papers.length}
- Papers read: ${papers.filter((paper) => paper.reading.status === "read").length}
- Reading Sessions updated: ${recentSessions.length}
- Reviews: ${reviews.length}
- Explicit feedback events: ${recentFeedback.filter((event) => event.explicit).length}

## Current focus

${profile?.learned.recentFocus.map((item) => `- ${item.term}: ${item.weight.toFixed(2)}`).join("\n") || "_Uncalibrated._"}

## Strong areas

${profile?.learned.strongAreas.map((item) => `- ${item.term}`).join("\n") || "_No confirmed strong areas._"}

## Weak areas

${profile?.learned.weakAreas.map((item) => `- ${item.term}`).join("\n") || "_No confirmed weak areas._"}

## Frequent topics

${
  topicCounts
    .slice(0, 20)
    .map(([topic, count]) => `- ${topic}: ${count}`)
    .join("\n") || "_No topics._"
}


## Unresolved questions

${
  recentSessions
    .flatMap((session) => session.selfAssessment?.unresolvedQuestions ?? [])
    .map((question) => `- ${question}`)
    .join("\n") || "_None._"
}
`;
  const data = {
    version: 1,
    week,
    generatedAt: now.toISOString(),
    papers: papers.length,
    read: papers.filter((paper) => paper.reading.status === "read").length,
    sessions: recentSessions.length,
    reviews: reviews.length,
    explicitFeedback: recentFeedback.filter((event) => event.explicit).length,
    topics: topicCounts,
  };
  await Promise.all([
    atomicWriteText(markdownPath, markdown),
    atomicWriteJson(jsonPath, data),
  ]);
  return { markdownPath, jsonPath };
}

export async function generateTrendReport(
  config: ResolvedReaderConfig,
  now = new Date(),
): Promise<{ markdownPath: string; jsonPath: string }> {
  const papers = await listPaperPassports(config);
  const topics = titleTopics(papers);
  const date = now.toISOString().slice(0, 10);
  const markdownPath = path.join(config.trendsReportsDir, `topics-${date}.md`);
  const jsonPath = path.join(config.trendsReportsDir, `topics-${date}.json`);
  const markdown = `# Research Reader Topic Trends - ${date}

This report is generated from deterministic Paper Passport title counts.

${topics.map(([topic, count]) => `- ${topic}: ${count}`).join("\n") || "_No topics._"}
`;
  await Promise.all([
    atomicWriteText(markdownPath, markdown),
    atomicWriteJson(jsonPath, {
      version: 1,
      generatedAt: now.toISOString(),
      paperIds: papers.map((paper) => paper.id),
      topics,
    }),
  ]);
  return { markdownPath, jsonPath };
}

function titleTopics(papers: PaperPassport[]): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const paper of papers) {
    for (const token of new Set(
      paper.metadata.title
        .normalize("NFKC")
        .toLocaleLowerCase()
        .match(/[\p{Letter}\p{Number}]+/gu)
        ?.filter((item) => item.length > 3) ?? [],
    )) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }
  return [...counts].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  );
}

function isoWeek(date: Date): string {
  const value = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const day = value.getUTCDay() || 7;
  value.setUTCDate(value.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(value.getUTCFullYear(), 0, 1));
  const week = Math.ceil(
    ((value.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7,
  );
  return `${value.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
