import {
  acquireSearchResult,
  getSourceArtifact,
  validateEvidenceAnchor,
} from "@intelligent-agent-system/llm-wiki-compiler";
import { initResearchReader } from "./init.js";
import { loadReaderConfig } from "./config.js";
import { mergeLiteratureMetadata } from "./identity.js";
import {
  checkpointReadingSession,
  completeReadingSession,
  pauseReadingSession,
  resumeReadingSession,
  startReadingSession,
} from "./reading.js";
import { appendPaperNote, readPaperNote } from "./notes.js";
import { answerCorpusQuestion, answerPaperQuestion } from "./questions.js";
import { comparePapers as createComparison } from "./compare.js";
import { extractPaperToWiki } from "./extract.js";
import {
  listFeedback,
  rebuildResearchProfile,
  recordFeedback,
  updateExplicitProfile,
  type FeedbackInput,
} from "./feedback.js";
import {
  createCalibrationBenchmark,
  evaluateCalibration,
  loadCalibration,
} from "./calibration.js";
import { generateTrendReport, generateWeeklyReport } from "./reports.js";
import { generateLatestDailyReport } from "./latest-report.js";
import { runReaderDaemon } from "./scheduler.js";
import {
  approveRequest,
  listApprovalRequests,
  rejectRequest,
} from "./approvals.js";
import { checkReaderHealth } from "./health.js";
import { addPaperAnnotation, listPaperAnnotations } from "./annotations.js";
import { buildReaderNavigation, recommendReadingPath } from "./navigation.js";
import { buildReadingAnalytics, evaluateDialogueHealth } from "./analytics.js";
import {
  initializeReasoningPatterns,
  listReasoningPatterns,
} from "./patterns.js";
import {
  completeRetentionCheck,
  createRetentionCheck,
  listRetentionChecks,
} from "./retention.js";
import { createSurveyPlan } from "./survey.js";
import {
  LITERATURE_ADAPTER_CONTRACT,
  literatureAdapterRegistry,
  runLiteratureAdapter,
  type AdapterRunOptions,
} from "./adapters/index.js";
import {
  FileNotificationProvider,
  sendReaderNotification,
} from "./notifications.js";
import { getReaderStatus } from "./status.js";
import {
  listPaperPassports,
  listPaperReviews,
  listReadingSessions,
  loadPaperPassport,
  loadPaperReview,
  loadReadingSession,
  loadResearchProfile,
  loadSubscriptions,
  mutatePaperPassport,
  savePaperPassport,
  savePaperReview,
  saveReadingSession,
  saveResearchProfile,
  saveSubscriptions,
} from "./store.js";
import {
  addSubscription,
  removeSubscription,
  setSubscriptionEnabled,
  type CreateSubscriptionInput,
} from "./subscriptions.js";
import {
  listTrackingRuns,
  readTrackingHistory,
  trackLiterature,
} from "./tracking.js";
import { reviewPaper as createPaperReview } from "./reviewer/review.js";
import type {
  PaperPassport,
  PaperReview,
  ReaderAcquireOptions,
  ReaderExtractOptions,
  ReaderDaemonOptions,
  ReaderQuestionOptions,
  ReaderReviewOptions,
  ReaderServiceOptions,
  ReaderSubscriptions,
  ReaderTrackOptions,
  ReadingCheckpointInput,
  ReadingMode,
  ReadingSession,
  ReadingStatus,
  ResearchProfile,
} from "./types.js";

const ALLOWED_READING_TRANSITIONS: Record<ReadingStatus, ReadingStatus[]> = {
  unread: ["queued", "reading", "dismissed"],
  queued: ["unread", "reading", "dismissed"],
  reading: ["read", "revisit", "dismissed"],
  read: ["revisit"],
  revisit: ["reading", "read", "dismissed"],
  dismissed: ["unread", "queued"],
};

export class ResearchReader {
  readonly root: string;

  constructor(options: ReaderServiceOptions = {}) {
    this.root = options.root ?? process.cwd();
  }

  init() {
    return initResearchReader(this.root);
  }

  async status() {
    return getReaderStatus(await loadReaderConfig(this.root));
  }

  async listPapers(options: { status?: ReadingStatus } = {}) {
    const papers = await listPaperPassports(await loadReaderConfig(this.root));
    return papers
      .filter(
        (paper) =>
          options.status === undefined ||
          paper.reading.status === options.status,
      )
      .sort(
        (left, right) =>
          right.reading.priority - left.reading.priority ||
          right.updatedAt.localeCompare(left.updatedAt),
      );
  }

  async listQueue(
    options: {
      recommendation?: NonNullable<PaperPassport["triage"]>["recommendation"];
    } = {},
  ) {
    const papers = await this.listPapers();
    return papers.filter(
      (paper) =>
        paper.reading.status !== "dismissed" &&
        paper.triage !== undefined &&
        (options.recommendation === undefined ||
          paper.triage.recommendation === options.recommendation),
    );
  }

  async getPaper(paperId: string) {
    return loadPaperPassport(await loadReaderConfig(this.root), paperId);
  }

  async savePaper(passport: PaperPassport) {
    const config = await loadReaderConfig(this.root);
    const now = new Date().toISOString();
    const stored: PaperPassport = {
      ...structuredClone(passport),
      updatedAt: now,
    };
    return savePaperPassport(config, stored);
  }

  async markPaper(paperId: string, status: ReadingStatus) {
    const config = await loadReaderConfig(this.root);
    return mutatePaperPassport(config, paperId, (paper) => {
      if (!paper) throw new Error(`Paper not found: ${paperId}`);
      const current = paper.reading.status;
      if (
        current !== status &&
        !ALLOWED_READING_TRANSITIONS[current].includes(status)
      ) {
        throw new Error(`Invalid reading transition: ${current} -> ${status}`);
      }
      const now = new Date().toISOString();
      paper.reading.status = status;
      if (status === "reading") paper.reading.startedAt ??= now;
      if (status === "read") paper.reading.completedAt ??= now;
      paper.updatedAt = now;
      return paper;
    });
  }

  async acquirePaper(paperId: string, options: ReaderAcquireOptions = {}) {
    const config = await loadReaderConfig(this.root);
    const paper = await loadPaperPassport(config, paperId);
    if (!paper) throw new Error(`Paper not found: ${paperId}`);
    if (!paper.candidate) {
      throw new Error(
        `Paper ${paperId} has no stored search candidate for acquisition`,
      );
    }
    try {
      const acquisition = await acquireSearchResult(paper.candidate, {
        root: config.root,
        ...(options.approveNetwork === true ? { approveNetwork: true } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.oaOnly === undefined ? {} : { oaOnly: options.oaOnly }),
        ...(options.maxFileBytes === undefined
          ? {}
          : { maxFileBytes: options.maxFileBytes }),
      });
      await mutatePaperPassport(config, paperId, (current) => {
        if (!current) throw new Error(`Paper not found: ${paperId}`);
        if (
          paper.lifecycle.latestVersionId &&
          current.lifecycle.latestVersionId &&
          paper.lifecycle.latestVersionId !== current.lifecycle.latestVersionId
        ) {
          throw new Error(
            `Paper version changed during acquisition: ${current.lifecycle.latestVersionId}`,
          );
        }
        const previousSource = current.acquisition.fullTextSourceId;
        current.acquisition = {
          status: "available",
          fullTextSourceId: acquisition.imported.artifact.id,
          lastAttemptAt: new Date().toISOString(),
        };
        if (
          previousSource &&
          previousSource !== acquisition.imported.artifact.id &&
          current.reviewIds.length
        ) {
          current.lifecycle.reviewStale = true;
        }
        if (!current.sourceIds.includes(acquisition.imported.artifact.id)) {
          current.sourceIds.push(acquisition.imported.artifact.id);
        }
        if (acquisition.imported.artifact.literature) {
          current.metadata = mergeLiteratureMetadata(
            current.metadata,
            acquisition.imported.artifact.literature,
          );
        }
        current.updatedAt = new Date().toISOString();
        return current;
      });
      return acquisition;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await mutatePaperPassport(config, paperId, (current) => {
        if (!current) throw new Error(`Paper not found: ${paperId}`);
        const attemptedAt = new Date().toISOString();
        current.acquisition =
          current.acquisition.status === "available"
            ? {
                ...current.acquisition,
                lastAttemptError: message,
                lastAttemptAt: attemptedAt,
              }
            : {
                status: "failed",
                failureReason: message,
                lastAttemptError: message,
                lastAttemptAt: attemptedAt,
              };
        current.updatedAt = attemptedAt;
        return current;
      });
      throw error;
    }
  }

  async listReviews(paperId?: string) {
    return listPaperReviews(await loadReaderConfig(this.root), paperId);
  }

  async getReview(paperId: string, reviewId: string) {
    return loadPaperReview(
      await loadReaderConfig(this.root),
      paperId,
      reviewId,
    );
  }

  async saveReview(review: PaperReview) {
    const config = await loadReaderConfig(this.root);
    const anchors = [
      ...Object.values(review.dimensions).flatMap(
        (dimension) => dimension?.evidence ?? [],
      ),
      ...review.adversarialChallenges.flatMap(
        (challenge) => challenge.evidence,
      ),
      ...(review.integrityIssues ?? []).flatMap((issue) => issue.evidence),
    ];
    if (anchors.length) {
      const source = await getSourceArtifact(review.sourceId, {
        root: config.root,
      });
      if (!source) {
        throw new Error(`Review evidence source not found: ${review.sourceId}`);
      }
      for (const anchor of anchors) validateEvidenceAnchor(source, anchor);
    }
    let reviewPath = "";
    await mutatePaperPassport(config, review.paperId, async (paper) => {
      if (!paper) throw new Error(`Paper not found: ${review.paperId}`);
      if (review.level !== "fast") {
        if (paper.acquisition.fullTextSourceId !== review.sourceId) {
          throw new Error(
            `Review source ${review.sourceId} is not the current full-text source for ${paper.id}`,
          );
        }
        if (
          paper.lifecycle.latestVersionId &&
          review.sourceVersion !== paper.lifecycle.latestVersionId
        ) {
          throw new Error(
            `Review version does not match current paper version ${paper.lifecycle.latestVersionId}`,
          );
        }
      }
      reviewPath = await savePaperReview(config, review);
      if (!paper.reviewIds.includes(review.id)) paper.reviewIds.push(review.id);
      if (review.level !== "fast") paper.lifecycle.reviewStale = false;
      paper.updatedAt = new Date().toISOString();
      return paper;
    });
    return reviewPath;
  }

  async reviewPaper(paperId: string, options: ReaderReviewOptions) {
    const config = await loadReaderConfig(this.root);
    const paper = await loadPaperPassport(config, paperId);
    if (!paper) throw new Error(`Paper not found: ${paperId}`);
    const review = await createPaperReview(config, paper, options);
    await this.saveReview(review);
    return review;
  }

  async listSessions() {
    return listReadingSessions(await loadReaderConfig(this.root));
  }

  async getSession(sessionId: string) {
    return loadReadingSession(await loadReaderConfig(this.root), sessionId);
  }

  async saveSession(session: ReadingSession) {
    const config = await loadReaderConfig(this.root);
    if (!(await loadPaperPassport(config, session.paperId))) {
      throw new Error(`Paper not found: ${session.paperId}`);
    }
    return saveReadingSession(config, {
      ...structuredClone(session),
      updatedAt: new Date().toISOString(),
    });
  }

  async startReading(
    paperId: string,
    mode: ReadingMode,
    intent: ReadingSession["intent"] = "exploratory",
  ) {
    return startReadingSession(
      await loadReaderConfig(this.root),
      paperId,
      mode,
      intent,
    );
  }

  async checkpointReading(sessionId: string, input: ReadingCheckpointInput) {
    return checkpointReadingSession(
      await loadReaderConfig(this.root),
      sessionId,
      input,
    );
  }

  async pauseReading(sessionId: string) {
    return pauseReadingSession(await loadReaderConfig(this.root), sessionId);
  }

  async resumeReading(sessionId: string) {
    return resumeReadingSession(await loadReaderConfig(this.root), sessionId);
  }

  async completeReading(sessionId: string) {
    return completeReadingSession(await loadReaderConfig(this.root), sessionId);
  }

  async addNote(paperId: string, content: string) {
    return appendPaperNote(await loadReaderConfig(this.root), paperId, content);
  }

  async readNote(paperId: string) {
    return readPaperNote(await loadReaderConfig(this.root), paperId);
  }

  async askPaper(
    paperId: string,
    question: string,
    options: ReaderQuestionOptions = {},
    sessionId?: string,
  ) {
    const config = await loadReaderConfig(this.root);
    const paper = await loadPaperPassport(config, paperId);
    if (!paper) throw new Error(`Paper not found: ${paperId}`);
    const answer = await answerPaperQuestion(config, paper, question, options);
    if (sessionId) {
      const session = await loadReadingSession(config, sessionId);
      if (!session) throw new Error(`Reading Session not found: ${sessionId}`);
      if (session.paperId !== paperId) {
        throw new Error(
          `Reading Session ${sessionId} belongs to ${session.paperId}`,
        );
      }
      session.questions.push(answer);
      session.updatedAt = new Date().toISOString();
      await saveReadingSession(config, session);
    }
    return answer;
  }

  async askCorpus(question: string, options: ReaderQuestionOptions = {}) {
    return answerCorpusQuestion(
      await loadReaderConfig(this.root),
      question,
      options,
    );
  }

  async comparePapers(paperIds: string[], options: ReaderQuestionOptions = {}) {
    const config = await loadReaderConfig(this.root);
    const papers: PaperPassport[] = [];
    for (const paperId of paperIds) {
      const paper = await loadPaperPassport(config, paperId);
      if (!paper) throw new Error(`Paper not found: ${paperId}`);
      papers.push(paper);
    }
    return createComparison(config, papers, options);
  }

  async extractPaper(paperId: string, options: ReaderExtractOptions = {}) {
    const config = await loadReaderConfig(this.root);
    const paper = await loadPaperPassport(config, paperId);
    if (!paper) throw new Error(`Paper not found: ${paperId}`);
    return extractPaperToWiki(config, paper, options);
  }

  async getProfile(): Promise<ResearchProfile> {
    const profile = await loadResearchProfile(
      await loadReaderConfig(this.root),
    );
    if (!profile) throw new Error("Research Profile is missing");
    return profile;
  }

  async saveProfile(profile: ResearchProfile) {
    return saveResearchProfile(await loadReaderConfig(this.root), {
      ...structuredClone(profile),
      updatedAt: new Date().toISOString(),
    });
  }

  async recordFeedback(input: FeedbackInput) {
    return recordFeedback(await loadReaderConfig(this.root), input);
  }

  async listFeedback(limit?: number) {
    return listFeedback(await loadReaderConfig(this.root), limit);
  }

  async rebuildProfile(force = false) {
    return rebuildResearchProfile(await loadReaderConfig(this.root), {
      force,
    });
  }

  async updateProfile(input: {
    topics?: string[];
    methods?: string[];
    followedAuthors?: string[];
    excludedTopics?: string[];
    preferredLanguages?: string[];
  }) {
    return updateExplicitProfile(await loadReaderConfig(this.root), input);
  }

  async evaluateCalibration() {
    return evaluateCalibration(await loadReaderConfig(this.root));
  }

  async createCalibration(paperIds?: string[]) {
    return createCalibrationBenchmark(
      await loadReaderConfig(this.root),
      paperIds,
    );
  }

  async calibration() {
    return loadCalibration(await loadReaderConfig(this.root));
  }

  async weeklyReport() {
    return generateWeeklyReport(await loadReaderConfig(this.root));
  }

  async dailyReport() {
    return generateLatestDailyReport(await loadReaderConfig(this.root));
  }

  async trendReport() {
    return generateTrendReport(await loadReaderConfig(this.root));
  }

  async daemon(options: ReaderDaemonOptions) {
    return runReaderDaemon(await loadReaderConfig(this.root), options);
  }

  async approvals() {
    return listApprovalRequests(await loadReaderConfig(this.root));
  }

  async approve(requestId: string, decidedBy: string) {
    return approveRequest(
      await loadReaderConfig(this.root),
      requestId,
      decidedBy,
    );
  }

  async reject(requestId: string, reason: string, decidedBy: string) {
    return rejectRequest(
      await loadReaderConfig(this.root),
      requestId,
      reason,
      decidedBy,
    );
  }

  async health() {
    return checkReaderHealth(await loadReaderConfig(this.root));
  }

  async annotations(paperId: string) {
    return listPaperAnnotations(await loadReaderConfig(this.root), paperId);
  }

  async addAnnotation(
    paperId: string,
    input: {
      page?: number;
      selectedQuote?: string;
      drawingDataUrl?: string;
      voiceTranscript?: string;
      note: string;
    },
  ) {
    return addPaperAnnotation(
      await loadReaderConfig(this.root),
      paperId,
      input,
    );
  }

  async navigation() {
    return buildReaderNavigation(await loadReaderConfig(this.root));
  }

  async readingPath(topic: string) {
    return recommendReadingPath(await loadReaderConfig(this.root), topic);
  }

  async analytics() {
    return buildReadingAnalytics(await loadReaderConfig(this.root));
  }

  async dialogueHealth() {
    return evaluateDialogueHealth(await loadReaderConfig(this.root));
  }

  async patterns() {
    const config = await loadReaderConfig(this.root);
    await initializeReasoningPatterns(config);
    return listReasoningPatterns(config);
  }

  async createRetention(paperId: string, questions: string[], dueAt?: Date) {
    return createRetentionCheck(
      await loadReaderConfig(this.root),
      paperId,
      questions,
      { ...(dueAt ? { dueAt } : {}) },
    );
  }

  async completeRetention(checkId: string, selfScores: number[]) {
    return completeRetentionCheck(
      await loadReaderConfig(this.root),
      checkId,
      selfScores,
    );
  }

  async retentionChecks() {
    return listRetentionChecks(await loadReaderConfig(this.root));
  }

  async surveyPlan(question: string) {
    return createSurveyPlan(await loadReaderConfig(this.root), question);
  }

  adapters() {
    return literatureAdapterRegistry.list();
  }

  adapterContract() {
    return LITERATURE_ADAPTER_CONTRACT;
  }

  async runAdapter(
    name: string,
    source: string,
    options: AdapterRunOptions = {},
  ) {
    return runLiteratureAdapter(
      await loadReaderConfig(this.root),
      name,
      source,
      options,
    );
  }

  async notifyFile(
    filePath: string,
    notification: { title: string; body: string; paperIds?: string[] },
  ) {
    return sendReaderNotification(new FileNotificationProvider(filePath), {
      ...notification,
      createdAt: new Date().toISOString(),
    });
  }

  async getSubscriptions(): Promise<ReaderSubscriptions> {
    const subscriptions = await loadSubscriptions(
      await loadReaderConfig(this.root),
    );
    if (!subscriptions) throw new Error("Reader subscriptions are missing");
    return subscriptions;
  }

  async saveSubscriptions(subscriptions: ReaderSubscriptions) {
    return saveSubscriptions(await loadReaderConfig(this.root), subscriptions);
  }

  async addSubscription(input: CreateSubscriptionInput) {
    const subscriptions = await this.getSubscriptions();
    const created = addSubscription(subscriptions, input);
    await this.saveSubscriptions(subscriptions);
    return created;
  }

  async setSubscriptionEnabled(subscriptionId: string, enabled: boolean) {
    const subscriptions = await this.getSubscriptions();
    const updated = setSubscriptionEnabled(
      subscriptions,
      subscriptionId,
      enabled,
    );
    await this.saveSubscriptions(subscriptions);
    return updated;
  }

  async removeSubscription(subscriptionId: string) {
    const subscriptions = await this.getSubscriptions();
    const removed = removeSubscription(subscriptions, subscriptionId);
    await this.saveSubscriptions(subscriptions);
    return removed;
  }

  async track(options: ReaderTrackOptions = {}) {
    return trackLiterature(await loadReaderConfig(this.root), options);
  }

  async runs(limit = 20) {
    return listTrackingRuns(await loadReaderConfig(this.root), limit);
  }

  async history(limit = 50) {
    return readTrackingHistory(await loadReaderConfig(this.root), limit);
  }
}
