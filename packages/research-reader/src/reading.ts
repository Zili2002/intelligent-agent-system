import { randomUUID } from "node:crypto";
import {
  loadPaperPassport,
  loadReadingSession,
  mutatePaperPassport,
  saveReadingSession,
} from "./store.js";
import type {
  ReadingCheckpointInput,
  ReadingMode,
  ReadingSession,
  ResolvedReaderConfig,
} from "./types.js";

export async function startReadingSession(
  config: ResolvedReaderConfig,
  paperId: string,
  mode: ReadingMode,
  intent: ReadingSession["intent"],
  now = new Date(),
): Promise<ReadingSession> {
  const timestamp = now.toISOString();
  let session: ReadingSession | undefined;
  await mutatePaperPassport(config, paperId, (current) => {
    if (!current) throw new Error(`Paper not found: ${paperId}`);
    session = {
      version: 1,
      id: `session-${randomUUID()}`,
      paperId,
      ...(current.lifecycle.latestVersionId
        ? { sourceVersion: current.lifecycle.latestVersionId }
        : {}),
      mode,
      intent,
      status: "active",
      checkpoints: [],
      progress: {},
      questions: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    current.reading.status =
      current.reading.status === "read" ? "revisit" : "reading";
    current.reading.startedAt ??= timestamp;
    current.updatedAt = timestamp;
    return current;
  });
  if (!session) throw new Error(`Unable to start Reading Session: ${paperId}`);
  await saveReadingSession(config, session);
  return session;
}

export async function checkpointReadingSession(
  config: ResolvedReaderConfig,
  sessionId: string,
  input: ReadingCheckpointInput,
  now = new Date(),
): Promise<ReadingSession> {
  const session = await requiredSession(config, sessionId);
  if (session.status === "completed") {
    throw new Error(`Reading Session is already completed: ${sessionId}`);
  }
  const timestamp = now.toISOString();
  const checkpoint = session.checkpoints.find(
    (item) => item.level === input.level,
  );
  if (checkpoint) {
    checkpoint.userConfirmed = input.userConfirmed;
    if (input.userConfirmed) checkpoint.completedAt = timestamp;
    else delete checkpoint.completedAt;
  } else {
    session.checkpoints.push({
      level: input.level,
      userConfirmed: input.userConfirmed,
      ...(input.userConfirmed ? { completedAt: timestamp } : {}),
    });
    session.checkpoints.sort((left, right) => left.level - right.level);
  }
  if (input.page !== undefined) session.progress.page = input.page;
  if (input.section !== undefined) session.progress.section = input.section;
  if (input.percent !== undefined) {
    if (input.percent < 0 || input.percent > 100) {
      throw new Error("Reading progress percent must be from 0 to 100");
    }
    session.progress.percent = input.percent;
  }
  if (input.understanding !== undefined) {
    if (input.understanding < 0 || input.understanding > 5) {
      throw new Error("Understanding score must be from 0 to 5");
    }
    session.selfAssessment = {
      understanding: input.understanding,
      unresolvedQuestions: [...(input.unresolvedQuestions ?? [])],
    };
  } else if (input.unresolvedQuestions !== undefined) {
    session.selfAssessment = {
      understanding: session.selfAssessment?.understanding ?? 0,
      unresolvedQuestions: [...input.unresolvedQuestions],
    };
  }
  session.status = "active";
  session.updatedAt = timestamp;
  await saveReadingSession(config, session);
  return session;
}

export async function pauseReadingSession(
  config: ResolvedReaderConfig,
  sessionId: string,
  now = new Date(),
): Promise<ReadingSession> {
  const session = await requiredSession(config, sessionId);
  if (session.status === "completed") {
    throw new Error(`Reading Session is already completed: ${sessionId}`);
  }
  session.status = "paused";
  session.updatedAt = now.toISOString();
  await saveReadingSession(config, session);
  return session;
}

export async function resumeReadingSession(
  config: ResolvedReaderConfig,
  sessionId: string,
  now = new Date(),
): Promise<ReadingSession> {
  const session = await requiredSession(config, sessionId);
  if (session.status === "completed") {
    throw new Error(`Reading Session is already completed: ${sessionId}`);
  }
  session.status = "active";
  session.updatedAt = now.toISOString();
  await saveReadingSession(config, session);
  return session;
}

export async function completeReadingSession(
  config: ResolvedReaderConfig,
  sessionId: string,
  now = new Date(),
): Promise<ReadingSession> {
  const session = await requiredSession(config, sessionId);
  const requiredLevel = levelForMode(session.mode);
  if (config.reading.requireLevelConfirmation) {
    for (let level = 1; level <= requiredLevel; level += 1) {
      if (
        !session.checkpoints.some(
          (checkpoint) =>
            checkpoint.level === level && checkpoint.userConfirmed,
        )
      ) {
        throw new Error(
          `Reading Session requires confirmed Level ${level} before completion`,
        );
      }
    }
  }
  const timestamp = now.toISOString();
  session.status = "completed";
  session.progress.percent = 100;
  session.updatedAt = timestamp;
  await saveReadingSession(config, session);
  await mutatePaperPassport(config, session.paperId, (paper) => {
    if (!paper) throw new Error(`Paper not found: ${session.paperId}`);
    paper.reading.status = "read";
    paper.reading.completedAt = timestamp;
    paper.reading.progress = 100;
    if (session.selfAssessment) {
      paper.reading.understandingScore = session.selfAssessment.understanding;
    }
    paper.updatedAt = timestamp;
    return paper;
  });
  return session;
}

function levelForMode(mode: ReadingMode): 1 | 2 | 3 {
  if (mode === "quick-scan") return 1;
  if (mode === "guided-read") return 2;
  return 3;
}

async function requiredSession(
  config: ResolvedReaderConfig,
  sessionId: string,
): Promise<ReadingSession> {
  const session = await loadReadingSession(config, sessionId);
  if (!session) throw new Error(`Reading Session not found: ${sessionId}`);
  return session;
}
