import path from "node:path";
import { atomicWriteJson } from "@intelligent-agent/shared";
import {
  listPaperPassports,
  listPaperReviews,
  listReadingSessions,
} from "./store.js";
import type {
  DialogueHealth,
  ReadingAnalytics,
  ReadingMode,
  ResolvedReaderConfig,
} from "./types.js";

export async function buildReadingAnalytics(
  config: ResolvedReaderConfig,
  now = new Date(),
): Promise<ReadingAnalytics> {
  const [papers, sessions] = await Promise.all([
    listPaperPassports(config),
    listReadingSessions(config),
  ]);
  const sessionsByMode: Record<ReadingMode, number> = {
    "quick-scan": 0,
    "guided-read": 0,
    "deep-dive": 0,
    compare: 0,
    extract: 0,
  };
  for (const session of sessions) sessionsByMode[session.mode] += 1;
  const understandings = sessions
    .map((session) => session.selfAssessment?.understanding)
    .filter((value): value is number => value !== undefined);
  const analytics: ReadingAnalytics = {
    version: 1,
    generatedAt: now.toISOString(),
    papers: papers.length,
    completedPapers: papers.filter((paper) => paper.reading.status === "read")
      .length,
    sessions: sessions.length,
    completedSessions: sessions.filter(
      (session) => session.status === "completed",
    ).length,
    sessionsByMode,
    ...(understandings.length
      ? {
          averageExplicitUnderstanding:
            understandings.reduce((total, value) => total + value, 0) /
            understandings.length,
        }
      : {}),
    unresolvedQuestions: [
      ...new Set(
        sessions.flatMap(
          (session) => session.selfAssessment?.unresolvedQuestions ?? [],
        ),
      ),
    ],
  };
  await atomicWriteJson(
    path.join(config.metaDir, "reading-analytics.json"),
    analytics,
  );
  return analytics;
}

export async function evaluateDialogueHealth(
  config: ResolvedReaderConfig,
  now = new Date(),
): Promise<DialogueHealth> {
  const [sessions, reviews] = await Promise.all([
    listReadingSessions(config),
    listPaperReviews(config),
  ]);
  const latestReviews = new Map<string, (typeof reviews)[number]>();
  for (const review of reviews) {
    if (!latestReviews.has(review.paperId))
      latestReviews.set(review.paperId, review);
  }
  const signals: DialogueHealth["signals"] = [];
  for (const session of sessions) {
    const answered = session.questions.filter((question) => question.answer);
    const agreementAnswers = answered.filter((question) =>
      /^(?:yes|agreed|correct|indeed|是的|同意)\b/i.test(
        question.answer?.trim() ?? "",
      ),
    );
    if (answered.length >= 5 && agreementAnswers.length === answered.length) {
      signals.push({
        sessionId: session.id,
        type: "persistent-agreement",
        message:
          "Five or more consecutive recorded answers begin with agreement language; inject an evidence-backed challenge before convergence.",
      });
    }
    const review = latestReviews.get(session.paperId);
    if (
      review?.criticalIssues.length &&
      !session.selfAssessment?.unresolvedQuestions.length
    ) {
      signals.push({
        sessionId: session.id,
        type: "conflict-avoidance",
        message:
          "The latest Review records critical issues but the Reading Session records no unresolved question.",
      });
    }
    if (
      session.intent === "exploratory" &&
      session.status === "completed" &&
      session.questions.length === 0
    ) {
      signals.push({
        sessionId: session.id,
        type: "premature-convergence",
        message:
          "An exploratory Reading Session completed without recording any question; confirm that exploration was intentionally concluded.",
      });
    }
  }
  const health: DialogueHealth = {
    version: 1,
    generatedAt: now.toISOString(),
    signals,
  };
  await atomicWriteJson(
    path.join(config.metaDir, "dialogue-health.json"),
    health,
  );
  return health;
}
