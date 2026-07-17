import path from "node:path";
import { atomicWriteJson, readJsonIfExists } from "@intelligent-agent/shared";
import { listFeedback } from "./feedback.js";
import { listPaperReviews } from "./store.js";
import type {
  CalibrationEvaluation,
  ReaderFeedbackEvent,
  ResolvedReaderConfig,
} from "./types.js";

const EVALUATION_FILE = "evaluation.json";

export async function evaluateCalibration(
  config: ResolvedReaderConfig,
  now = new Date(),
): Promise<CalibrationEvaluation> {
  const [feedback, reviews] = await Promise.all([
    listFeedback(config),
    listPaperReviews(config),
  ]);
  const latestReview = new Map<string, (typeof reviews)[number]>();
  for (const review of reviews) {
    const prior = latestReview.get(review.paperId);
    if (!prior || review.createdAt > prior.createdAt) {
      latestReview.set(review.paperId, review);
    }
  }
  const objectivePairs = feedbackPairs(
    feedback.filter(
      (event) =>
        event.explicit &&
        event.type === "quality-rating" &&
        event.value !== undefined,
    ),
    latestReview,
    (event, review) =>
      review.scientificQuality === undefined
        ? undefined
        : [review.scientificQuality, event.value!],
  );
  const preferencePairs = feedbackPairs(
    feedback.filter(
      (event) =>
        event.explicit &&
        event.type === "personal-value" &&
        event.value !== undefined,
    ),
    latestReview,
    (event, review) => [review.personalRelevance * 10, event.value!],
  );
  const recommendationEvents = feedback.filter(
    (event) =>
      event.explicit &&
      event.type === "recommendation-feedback" &&
      event.accepted !== undefined,
  );
  const explicitSamples = feedback.filter((event) => event.explicit).length;
  const calibrated =
    explicitSamples >= config.profile.minimumExplicitFeedback &&
    (objectivePairs.length > 0 || preferencePairs.length > 0);
  const evaluation: CalibrationEvaluation = {
    version: 1,
    status: calibrated ? "calibrated" : "uncalibrated",
    generatedAt: now.toISOString(),
    explicitSamples,
    objectiveSamples: objectivePairs.length,
    preferenceSamples: preferencePairs.length,
    ...(objectivePairs.length
      ? { objective: objectiveMetrics(objectivePairs) }
      : {}),
    ...(preferencePairs.length || recommendationEvents.length
      ? {
          preference: {
            meanAbsoluteError: meanAbsoluteError(preferencePairs),
            recommendationAgreement: recommendationEvents.length
              ? recommendationEvents.filter((event) => event.accepted).length /
                recommendationEvents.length
              : 0,
          },
        }
      : {}),
  };
  await atomicWriteJson(calibrationPath(config), evaluation);
  return evaluation;
}

export function loadCalibration(
  config: ResolvedReaderConfig,
): Promise<CalibrationEvaluation | undefined> {
  return readJsonIfExists(calibrationPath(config), parseCalibration);
}

export async function createCalibrationBenchmark(
  config: ResolvedReaderConfig,
  paperIds?: string[],
  now = new Date(),
): Promise<{
  version: 1;
  createdAt: string;
  entries: Array<{
    paperId: string;
    expectedQuality: null;
    expectedRecommendation: null;
  }>;
}> {
  const reviews = await listPaperReviews(config);
  const available = [
    ...new Set(paperIds ?? reviews.map((review) => review.paperId)),
  ];
  if (!available.length) {
    throw new Error(
      "Calibration benchmark requires Paper IDs or existing Reviews",
    );
  }
  const benchmark = {
    version: 1 as const,
    createdAt: now.toISOString(),
    entries: available.map((paperId) => ({
      paperId,
      expectedQuality: null,
      expectedRecommendation: null,
    })),
  };
  await atomicWriteJson(
    path.join(config.calibrationDir, "benchmark.json"),
    benchmark,
  );
  return benchmark;
}

function objectiveMetrics(pairs: Array<[number, number]>): {
  meanAbsoluteError: number;
  falsePositiveRate: number;
  falseNegativeRate: number;
} {
  const positives = pairs.filter(([, actual]) => actual < 7);
  const negatives = pairs.filter(([, actual]) => actual >= 7);
  const falsePositives = positives.filter(([predicted]) => predicted >= 7);
  const falseNegatives = negatives.filter(([predicted]) => predicted < 7);
  return {
    meanAbsoluteError: meanAbsoluteError(pairs),
    falsePositiveRate: positives.length
      ? falsePositives.length / positives.length
      : 0,
    falseNegativeRate: negatives.length
      ? falseNegatives.length / negatives.length
      : 0,
  };
}

function meanAbsoluteError(pairs: Array<[number, number]>): number {
  if (!pairs.length) return 0;
  return (
    pairs.reduce(
      (total, [predicted, actual]) => total + Math.abs(predicted - actual),
      0,
    ) / pairs.length
  );
}

function feedbackPairs(
  events: ReaderFeedbackEvent[],
  reviews: Map<string, Awaited<ReturnType<typeof listPaperReviews>>[number]>,
  pair: (
    event: ReaderFeedbackEvent,
    review: Awaited<ReturnType<typeof listPaperReviews>>[number],
  ) => [number, number] | undefined,
): Array<[number, number]> {
  return events.flatMap((event) => {
    const review = reviews.get(event.paperId);
    if (!review) return [];
    const result = pair(event, review);
    return result ? [result] : [];
  });
}

function calibrationPath(config: ResolvedReaderConfig): string {
  return path.join(config.calibrationDir, EVALUATION_FILE);
}

function parseCalibration(value: unknown): CalibrationEvaluation {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("version" in value) ||
    value.version !== 1 ||
    !("status" in value) ||
    (value.status !== "uncalibrated" && value.status !== "calibrated") ||
    !("generatedAt" in value) ||
    typeof value.generatedAt !== "string"
  ) {
    throw new Error("Invalid Reader calibration evaluation");
  }
  return value as CalibrationEvaluation;
}
