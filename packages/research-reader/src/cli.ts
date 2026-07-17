#!/usr/bin/env node

import path from "node:path";
import { Command, InvalidArgumentError } from "commander";
import type { SearchProviderName } from "@intelligent-agent-system/llm-wiki-compiler";
import { ResearchReader } from "./service.js";
import type {
  FeedbackType,
  ReadingRecommendation,
  ReadingMode,
  ReadingStatus,
  ReviewLevel,
  SubscriptionKind,
} from "./types.js";

const READING_STATUSES: ReadingStatus[] = [
  "unread",
  "queued",
  "reading",
  "read",
  "revisit",
  "dismissed",
];
const SUBSCRIPTION_KINDS: SubscriptionKind[] = [
  "query",
  "category",
  "author",
  "paper",
];
const PROVIDERS: SearchProviderName[] = ["arxiv", "openalex", "crossref"];
const RECOMMENDATIONS: ReadingRecommendation[] = [
  "priority",
  "deep-read",
  "skim",
  "archive",
  "manual-review",
];
const REVIEW_LEVELS: ReviewLevel[] = ["fast", "standard", "deep"];
const READING_MODES: ReadingMode[] = [
  "quick-scan",
  "guided-read",
  "deep-dive",
  "compare",
  "extract",
];
const FEEDBACK_TYPES: FeedbackType[] = [
  "quality-rating",
  "personal-value",
  "recommendation-feedback",
  "reading-completed",
  "reading-abandoned",
  "question-topic",
];

const program = new Command();

program
  .name("research-reader")
  .description("Evidence-grounded literature tracking and reading workflows")
  .version("0.1.0")
  .option(
    "-r, --root <path>",
    "Research Wiki root containing Reader and Wiki state",
    process.cwd(),
  );

program
  .command("init")
  .description("Initialize Reader configuration and state directories")
  .action(
    command(async () => {
      print(await reader().init());
    }),
  );

program
  .command("status")
  .description("Show Reader state counts and schema version")
  .action(
    command(async () => {
      print(await reader().status());
    }),
  );

program
  .command("subscription-add")
  .description("Add a literature tracking subscription")
  .argument("<name>")
  .argument("<query>")
  .option("--kind <kind>", "Subscription kind", subscriptionKind, "query")
  .option("--weight <number>", "Priority weight from 0 to 1", boundedRatio, 1)
  .option("--tags <list>", "Comma-separated tags", commaList, [])
  .option(
    "--languages <list>",
    "Comma-separated preferred languages",
    commaList,
    [],
  )
  .option("--providers <list>", "Comma-separated providers", providerList)
  .action(
    command(
      async (
        name: string,
        query: string,
        options: {
          kind: SubscriptionKind;
          weight: number;
          tags: string[];
          languages: string[];
          providers?: SearchProviderName[];
        },
      ) => {
        print(
          await reader().addSubscription({
            name,
            query,
            kind: options.kind,
            weight: options.weight,
            tags: options.tags,
            preferredLanguages: options.languages,
            ...(options.providers ? { providers: options.providers } : {}),
          }),
        );
      },
    ),
  );

program
  .command("subscription-list")
  .description("List literature tracking subscriptions")
  .action(
    command(async () => {
      print(await reader().getSubscriptions());
    }),
  );

for (const [name, enabled] of [
  ["subscription-enable", true],
  ["subscription-disable", false],
] as const) {
  program
    .command(name)
    .description(`${enabled ? "Enable" : "Disable"} a subscription`)
    .argument("<subscription-id>")
    .action(
      command(async (subscriptionId: string) => {
        print(await reader().setSubscriptionEnabled(subscriptionId, enabled));
      }),
    );
}

program
  .command("subscription-remove")
  .description("Remove a subscription")
  .argument("<subscription-id>")
  .action(
    command(async (subscriptionId: string) => {
      print(await reader().removeSubscription(subscriptionId));
    }),
  );

program
  .command("track")
  .description("Run bounded tracking for enabled subscriptions")
  .option("--approve-network", "Approve external literature provider requests")
  .option("--approve-llm", "Approve paid LLM triage")
  .option("--providers <list>", "Override providers", providerList)
  .option("--limit <number>", "Maximum results per subscription", positiveInt)
  .option("--max-llm-tokens <number>", "Bound LLM triage Tokens", positiveInt)
  .action(
    command(
      async (options: {
        approveNetwork?: boolean;
        approveLlm?: boolean;
        providers?: SearchProviderName[];
        limit?: number;
        maxLlmTokens?: number;
      }) => {
        print(
          await reader().track({
            ...(options.approveNetwork ? { approveNetwork: true } : {}),
            ...(options.approveLlm ? { approveLlm: true } : {}),
            ...(options.providers ? { providers: options.providers } : {}),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
            ...(options.maxLlmTokens === undefined
              ? {}
              : { maxLlmTokens: options.maxLlmTokens }),
          }),
        );
      },
    ),
  );

program
  .command("papers")
  .description("List Paper Passports")
  .option("--status <status>", "Filter by reading status", readingStatus)
  .action(
    command(async (options: { status?: ReadingStatus }) => {
      print(await reader().listPapers(options));
    }),
  );

program
  .command("queue")
  .description("List the derived reading queue")
  .option(
    "--recommendation <value>",
    "Filter by triage recommendation",
    recommendation,
  )
  .action(
    command(async (options: { recommendation?: ReadingRecommendation }) => {
      print(await reader().listQueue(options));
    }),
  );

program
  .command("runs")
  .description("List recent tracking runs")
  .option("--limit <number>", "Maximum records", positiveInt, 20)
  .action(
    command(async (options: { limit: number }) => {
      print(await reader().runs(options.limit));
    }),
  );

program
  .command("history")
  .description("Show recent tracking history events")
  .option("--limit <number>", "Maximum events", positiveInt, 50)
  .action(
    command(async (options: { limit: number }) => {
      print(await reader().history(options.limit));
    }),
  );

program
  .command("paper-show")
  .description("Show one Paper Passport")
  .argument("<paper-id>")
  .action(
    command(async (paperId: string) => {
      const paper = await reader().getPaper(paperId);
      if (!paper) throw new Error(`Paper not found: ${paperId}`);
      print(paper);
    }),
  );

program
  .command("paper-acquire")
  .description("Acquire approved open full text for one paper")
  .argument("<paper-id>")
  .option("--approve-network", "Approve the external full-text request")
  .option("--allow-licensed", "Allow explicitly licensed non-OA locations")
  .option("--max-mb <number>", "Maximum download size in MiB", positiveInt, 100)
  .action(
    command(
      async (
        paperId: string,
        options: {
          approveNetwork?: boolean;
          allowLicensed?: boolean;
          maxMb: number;
        },
      ) => {
        print(
          await reader().acquirePaper(paperId, {
            ...(options.approveNetwork ? { approveNetwork: true } : {}),
            oaOnly: !options.allowLicensed,
            maxFileBytes: options.maxMb * 1024 * 1024,
          }),
        );
      },
    ),
  );

program
  .command("paper-review")
  .description("Run an evidence-grounded paper review")
  .argument("<paper-id>")
  .requiredOption("--level <level>", "fast, standard, or deep", reviewLevel)
  .option("--approve-llm", "Approve the paid LLM review")
  .option("--audit-citations", "Resolve detected DOI/arXiv references")
  .option("--approve-network", "Approve citation provider requests")
  .option("--providers <list>", "Citation audit providers", providerList)
  .option("--max-llm-tokens <number>", "Bound total review Tokens", positiveInt)
  .option("--no-adversarial", "Disable the adversarial review pass")
  .action(
    command(
      async (
        paperId: string,
        options: {
          level: ReviewLevel;
          approveLlm?: boolean;
          auditCitations?: boolean;
          approveNetwork?: boolean;
          providers?: SearchProviderName[];
          maxLlmTokens?: number;
          adversarial: boolean;
        },
      ) => {
        print(
          await reader().reviewPaper(paperId, {
            level: options.level,
            ...(options.approveLlm ? { approveLlm: true } : {}),
            ...(options.auditCitations ? { auditCitations: true } : {}),
            ...(options.approveNetwork ? { approveNetwork: true } : {}),
            ...(options.providers
              ? { citationProviders: options.providers }
              : {}),
            ...(options.maxLlmTokens === undefined
              ? {}
              : { maxLlmTokens: options.maxLlmTokens }),
            adversarial: options.adversarial,
          }),
        );
      },
    ),
  );

program
  .command("paper-mark")
  .description("Update a paper reading status")
  .argument("<paper-id>")
  .requiredOption("--status <status>", "New reading status", readingStatus)
  .action(
    command(async (paperId: string, options: { status: ReadingStatus }) => {
      print(await reader().markPaper(paperId, options.status));
    }),
  );

program
  .command("read-start")
  .description("Start a progressive Reading Session")
  .argument("<paper-id>")
  .requiredOption("--mode <mode>", "Reading mode", readingMode)
  .option(
    "--intent <intent>",
    "exploratory or goal-oriented",
    readingIntent,
    "exploratory",
  )
  .action(
    command(
      async (
        paperId: string,
        options: {
          mode: ReadingMode;
          intent: "exploratory" | "goal-oriented";
        },
      ) => {
        print(
          await reader().startReading(paperId, options.mode, options.intent),
        );
      },
    ),
  );

program
  .command("read-checkpoint")
  .description("Save a Reading Session checkpoint")
  .argument("<session-id>")
  .requiredOption("--level <number>", "Checkpoint level 1-3", checkpointLevel)
  .option("--confirm", "Confirm this level")
  .option("--page <number>", "Current page", positiveInt)
  .option("--section <text>", "Current section")
  .option("--percent <number>", "Progress percent", progressPercent)
  .option("--understanding <number>", "Understanding score 0-5", understanding)
  .option(
    "--unresolved <list>",
    "Comma-separated unresolved questions",
    commaList,
  )
  .action(
    command(
      async (
        sessionId: string,
        options: {
          level: 1 | 2 | 3;
          confirm?: boolean;
          page?: number;
          section?: string;
          percent?: number;
          understanding?: number;
          unresolved?: string[];
        },
      ) => {
        print(
          await reader().checkpointReading(sessionId, {
            level: options.level,
            userConfirmed: options.confirm ?? false,
            ...(options.page === undefined ? {} : { page: options.page }),
            ...(options.section ? { section: options.section } : {}),
            ...(options.percent === undefined
              ? {}
              : { percent: options.percent }),
            ...(options.understanding === undefined
              ? {}
              : { understanding: options.understanding }),
            ...(options.unresolved
              ? { unresolvedQuestions: options.unresolved }
              : {}),
          }),
        );
      },
    ),
  );

for (const [name, action] of [
  ["read-pause", (sessionId: string) => reader().pauseReading(sessionId)],
  ["read-resume", (sessionId: string) => reader().resumeReading(sessionId)],
  ["read-complete", (sessionId: string) => reader().completeReading(sessionId)],
] as const) {
  program
    .command(name)
    .description(`${name.replace("read-", "")} a Reading Session`)
    .argument("<session-id>")
    .action(
      command(async (sessionId: string) => {
        print(await action(sessionId));
      }),
    );
}

program
  .command("note-add")
  .description("Append a timestamped Markdown note")
  .argument("<paper-id>")
  .requiredOption("--text <text>", "Note text")
  .action(
    command(async (paperId: string, options: { text: string }) => {
      print({ path: await reader().addNote(paperId, options.text) });
    }),
  );

program
  .command("note-show")
  .description("Show the Markdown note for one paper")
  .argument("<paper-id>")
  .action(
    command(async (paperId: string) => {
      process.stdout.write((await reader().readNote(paperId)) ?? "");
    }),
  );

program
  .command("paper-ask")
  .description("Answer from one acquired paper with exact citations")
  .argument("<paper-id>")
  .argument("<question>")
  .option("--session <session-id>", "Append the question to a Reading Session")
  .option("--approve-llm", "Approve the paid LLM answer")
  .option("--max-llm-tokens <number>", "Bound answer Tokens", positiveInt)
  .action(
    command(
      async (
        paperId: string,
        question: string,
        options: {
          session?: string;
          approveLlm?: boolean;
          maxLlmTokens?: number;
        },
      ) => {
        print(
          await reader().askPaper(
            paperId,
            question,
            {
              ...(options.approveLlm ? { approveLlm: true } : {}),
              ...(options.maxLlmTokens === undefined
                ? {}
                : { maxLlmTokens: options.maxLlmTokens }),
            },
            options.session,
          ),
        );
      },
    ),
  );

program
  .command("corpus-ask")
  .description("Answer from the compiled Claim Registry")
  .argument("<question>")
  .option("--approve-llm", "Approve the paid LLM answer")
  .option("--max-llm-tokens <number>", "Bound answer Tokens", positiveInt)
  .action(
    command(
      async (
        question: string,
        options: { approveLlm?: boolean; maxLlmTokens?: number },
      ) => {
        print(
          await reader().askCorpus(question, {
            ...(options.approveLlm ? { approveLlm: true } : {}),
            ...(options.maxLlmTokens === undefined
              ? {}
              : { maxLlmTokens: options.maxLlmTokens }),
          }),
        );
      },
    ),
  );

program
  .command("paper-compare")
  .description("Compare two or more acquired papers")
  .argument("<paper-ids...>")
  .option("--approve-llm", "Approve the paid LLM comparison")
  .option("--max-llm-tokens <number>", "Bound comparison Tokens", positiveInt)
  .action(
    command(
      async (
        paperIds: string[],
        options: { approveLlm?: boolean; maxLlmTokens?: number },
      ) => {
        print(
          await reader().comparePapers(paperIds, {
            ...(options.approveLlm ? { approveLlm: true } : {}),
            ...(options.maxLlmTokens === undefined
              ? {}
              : { maxLlmTokens: options.maxLlmTokens }),
          }),
        );
      },
    ),
  );

program
  .command("extract")
  .description("Compile one acquired paper into the Wiki")
  .argument("<paper-id>")
  .option("--approve-llm", "Approve Wiki compilation")
  .option("--max-llm-tokens <number>", "Bound compilation Tokens", positiveInt)
  .option("--no-recompile", "Use the existing Claim Registry")
  .action(
    command(
      async (
        paperId: string,
        options: {
          approveLlm?: boolean;
          maxLlmTokens?: number;
          recompile: boolean;
        },
      ) => {
        print(
          await reader().extractPaper(paperId, {
            ...(options.approveLlm ? { approveLlm: true } : {}),
            ...(options.maxLlmTokens === undefined
              ? {}
              : { maxLlmTokens: options.maxLlmTokens }),
            recompile: options.recompile,
          }),
        );
      },
    ),
  );

program
  .command("feedback")
  .description("Append an auditable user feedback event")
  .argument("<paper-id>")
  .requiredOption("--type <type>", "Feedback type", feedbackType)
  .option("--value <number>", "Rating from 0 to 10", rating)
  .option(
    "--accepted <boolean>",
    "Whether a recommendation was accepted",
    booleanValue,
  )
  .option("--topics <list>", "Comma-separated question topics", commaList)
  .option("--comment <text>", "Optional comment")
  .option(
    "--recommendation <value>",
    "Recommendation being evaluated",
    recommendation,
  )
  .option("--implicit", "Mark this as a low-weight implicit signal")
  .action(
    command(
      async (
        paperId: string,
        options: {
          type: FeedbackType;
          value?: number;
          accepted?: boolean;
          topics?: string[];
          comment?: string;
          recommendation?: ReadingRecommendation;
          implicit?: boolean;
        },
      ) => {
        print(
          await reader().recordFeedback({
            paperId,
            type: options.type,
            explicit: !options.implicit,
            ...(options.value === undefined ? {} : { value: options.value }),
            ...(options.accepted === undefined
              ? {}
              : { accepted: options.accepted }),
            ...(options.topics ? { topics: options.topics } : {}),
            ...(options.comment ? { comment: options.comment } : {}),
            ...(options.recommendation
              ? { recommendation: options.recommendation }
              : {}),
          }),
        );
      },
    ),
  );

program
  .command("profile-show")
  .description("Show the explicit and learned Research Profile")
  .action(
    command(async () => {
      print(await reader().getProfile());
    }),
  );

program
  .command("profile-update")
  .description("Replace explicit Research Profile fields")
  .option("--topics <list>", "Comma-separated topics", commaList)
  .option("--methods <list>", "Comma-separated methods", commaList)
  .option("--authors <list>", "Comma-separated followed authors", commaList)
  .option("--exclude <list>", "Comma-separated excluded topics", commaList)
  .option(
    "--languages <list>",
    "Comma-separated preferred languages",
    commaList,
  )
  .action(
    command(
      async (options: {
        topics?: string[];
        methods?: string[];
        authors?: string[];
        exclude?: string[];
        languages?: string[];
      }) => {
        print(
          await reader().updateProfile({
            ...(options.topics ? { topics: options.topics } : {}),
            ...(options.methods ? { methods: options.methods } : {}),
            ...(options.authors ? { followedAuthors: options.authors } : {}),
            ...(options.exclude ? { excludedTopics: options.exclude } : {}),
            ...(options.languages
              ? { preferredLanguages: options.languages }
              : {}),
          }),
        );
      },
    ),
  );

program
  .command("profile-rebuild")
  .description("Rebuild bounded learned Profile fields from feedback")
  .option("--force", "Explicitly run even when automatic learning is disabled")
  .action(
    command(async (options: { force?: boolean }) => {
      print(await reader().rebuildProfile(options.force ?? false));
    }),
  );

program
  .command("calibration-create")
  .description("Create a user-fillable calibration benchmark")
  .option("--papers <list>", "Comma-separated Paper IDs", commaList)
  .action(
    command(async (options: { papers?: string[] }) => {
      print(await reader().createCalibration(options.papers));
    }),
  );

program
  .command("calibration-run")
  .description("Evaluate objective and preference calibration")
  .action(
    command(async () => {
      print(await reader().evaluateCalibration());
    }),
  );

program
  .command("calibration-status")
  .description("Show the latest calibration artifact")
  .action(
    command(async () => {
      print((await reader().calibration()) ?? { status: "missing" });
    }),
  );

program
  .command("report-daily")
  .description("Regenerate the latest tracking daily report")
  .action(
    command(async () => {
      print(await reader().dailyReport());
    }),
  );

program
  .command("report-weekly")
  .description("Generate a deterministic weekly report")
  .action(
    command(async () => {
      print(await reader().weeklyReport());
    }),
  );

program
  .command("report-trends")
  .description("Generate deterministic topic trends")
  .action(
    command(async () => {
      print(await reader().trendReport());
    }),
  );

program
  .command("daemon")
  .description("Run bounded scheduled tracking cycles")
  .option("--approve-network", "Approve literature provider requests")
  .option("--approve-llm", "Approve LLM triage")
  .option("--providers <list>", "Override providers", providerList)
  .option("--interval <seconds>", "Seconds between cycles", positiveInt, 86_400)
  .option(
    "--max-duration <seconds>",
    "Maximum daemon duration",
    positiveInt,
    604_800,
  )
  .option("--max-cycles <number>", "Maximum cycles", positiveInt, 100)
  .option("--retry-attempts <number>", "Retry attempts", positiveInt, 3)
  .option("--retry-delay <seconds>", "Initial retry delay", positiveInt, 1)
  .action(
    command(
      async (options: {
        approveNetwork?: boolean;
        approveLlm?: boolean;
        providers?: SearchProviderName[];
        interval: number;
        maxDuration: number;
        maxCycles: number;
        retryAttempts: number;
        retryDelay: number;
      }) => {
        print(
          await reader().daemon({
            ...(options.approveNetwork ? { approveNetwork: true } : {}),
            ...(options.approveLlm ? { approveLlm: true } : {}),
            ...(options.providers ? { providers: options.providers } : {}),
            intervalMs: options.interval * 1_000,
            maxDurationMs: options.maxDuration * 1_000,
            maxCycles: options.maxCycles,
            retry: {
              maxAttempts: options.retryAttempts,
              initialDelayMs: options.retryDelay * 1_000,
              maxDelayMs: options.retryDelay * 8_000,
            },
          }),
        );
      },
    ),
  );

program
  .command("approvals")
  .description("List Reader approval requests")
  .action(
    command(async () => {
      print(await reader().approvals());
    }),
  );

program
  .command("approval-approve")
  .description("Approve one Reader request")
  .argument("<request-id>")
  .option("--by <actor>", "Decision actor", "user")
  .action(
    command(async (requestId: string, options: { by: string }) => {
      print(await reader().approve(requestId, options.by));
    }),
  );

program
  .command("approval-reject")
  .description("Reject one Reader request")
  .argument("<request-id>")
  .requiredOption("--reason <text>", "Rejection reason")
  .option("--by <actor>", "Decision actor", "user")
  .action(
    command(
      async (requestId: string, options: { reason: string; by: string }) => {
        print(await reader().reject(requestId, options.reason, options.by));
      },
    ),
  );

program
  .command("health")
  .description("Show Reader health and aggregate metrics without secrets")
  .action(
    command(async () => {
      print(await reader().health());
    }),
  );

program
  .command("navigation")
  .description("Build the Paper-Claim-Topic navigation graph")
  .action(
    command(async () => {
      print(await reader().navigation());
    }),
  );

program
  .command("reading-path")
  .description("Recommend an evidence-linked reading path for a topic")
  .argument("<topic>")
  .action(
    command(async (topic: string) => {
      print(await reader().readingPath(topic));
    }),
  );

program
  .command("analytics")
  .description("Build explicit reading analytics")
  .action(
    command(async () => {
      print(await reader().analytics());
    }),
  );

program
  .command("dialogue-health")
  .description("Evaluate auditable long-session dialogue signals")
  .action(
    command(async () => {
      print(await reader().dialogueHealth());
    }),
  );

program
  .command("patterns")
  .description("List clean-room reasoning pattern checklists")
  .action(
    command(async () => {
      print(await reader().patterns());
    }),
  );

program
  .command("retention-create")
  .description("Create an explicit self-scored retention check")
  .argument("<paper-id>")
  .requiredOption("--questions <list>", "Questions separated by |", pipeList)
  .option("--due <date>", "Due date/time", isoDate)
  .action(
    command(
      async (paperId: string, options: { questions: string[]; due?: Date }) => {
        print(
          await reader().createRetention(
            paperId,
            options.questions,
            options.due,
          ),
        );
      },
    ),
  );

program
  .command("retention-list")
  .description("List retention checks")
  .action(
    command(async () => {
      print(await reader().retentionChecks());
    }),
  );

program
  .command("retention-complete")
  .description("Complete a retention check with 0-1 self-scores")
  .argument("<check-id>")
  .requiredOption("--scores <list>", "Comma-separated 0-1 scores", scoreList)
  .action(
    command(async (checkId: string, options: { scores: number[] }) => {
      print(await reader().completeRetention(checkId, options.scores));
    }),
  );

program
  .command("survey-plan")
  .alias("review-survey-plan")
  .description("Create an evidence-grounded survey plan")
  .argument("<question>")
  .action(
    command(async (question: string) => {
      print(await reader().surveyPlan(question));
    }),
  );

program
  .command("import")
  .description("Import a local file or directory through the folder adapter")
  .argument("<source>")
  .option("--limit <number>", "Maximum imported files", positiveInt)
  .action(
    command(async (source: string, options: { limit?: number }) => {
      print(
        await reader().runAdapter("folder", source, {
          ...(options.limit === undefined ? {} : { limit: options.limit }),
        }),
      );
    }),
  );

program
  .command("adapters")
  .description("List registered literature adapters")
  .action(() => print(reader().adapters()));

program
  .command("adapter-contract")
  .description("Show the language-neutral adapter contract")
  .action(() => print(reader().adapterContract()));

program
  .command("adapter-run")
  .description("Import literature through a registered adapter")
  .argument("<adapter>")
  .argument("<source>")
  .option("--approve-network", "Approve adapter network requests")
  .option("--limit <number>", "Maximum imported items", positiveInt)
  .action(
    command(
      async (
        adapter: string,
        source: string,
        options: { approveNetwork?: boolean; limit?: number },
      ) => {
        print(
          await reader().runAdapter(adapter, source, {
            ...(options.approveNetwork ? { approveNetwork: true } : {}),
            ...(options.limit === undefined ? {} : { limit: options.limit }),
          }),
        );
      },
    ),
  );

program
  .command("notification-file")
  .description("Append a local notification artifact")
  .argument("<file>")
  .requiredOption("--title <text>")
  .requiredOption("--body <text>")
  .option("--papers <list>", "Comma-separated Paper IDs", commaList)
  .action(
    command(
      async (
        file: string,
        options: { title: string; body: string; papers?: string[] },
      ) => {
        await reader().notifyFile(file, {
          title: options.title,
          body: options.body,
          ...(options.papers ? { paperIds: options.papers } : {}),
        });
        print({ sent: true, provider: "file" });
      },
    ),
  );

program
  .command("paper-rate")
  .description("Record explicit quality and/or personal-value ratings")
  .argument("<paper-id>")
  .option("--quality <number>", "Scientific quality rating 0-10", rating)
  .option("--value <number>", "Personal value rating 0-10", rating)
  .option("--comment <text>", "Optional comment")
  .action(
    command(
      async (
        paperId: string,
        options: {
          quality?: number;
          value?: number;
          comment?: string;
        },
      ) => {
        if (options.quality === undefined && options.value === undefined) {
          throw new InvalidArgumentError(
            "paper-rate requires --quality and/or --value",
          );
        }
        const events = [];
        if (options.quality !== undefined) {
          events.push(
            await reader().recordFeedback({
              paperId,
              type: "quality-rating",
              explicit: true,
              value: options.quality,
              ...(options.comment ? { comment: options.comment } : {}),
            }),
          );
        }
        if (options.value !== undefined) {
          events.push(
            await reader().recordFeedback({
              paperId,
              type: "personal-value",
              explicit: true,
              value: options.value,
              ...(options.comment ? { comment: options.comment } : {}),
            }),
          );
        }
        print(events);
      },
    ),
  );

await program.parseAsync(process.argv);

function reader(): ResearchReader {
  const root = program.opts<{ root: string }>().root;
  return new ResearchReader({ root: path.resolve(root) });
}

function readingStatus(value: string): ReadingStatus {
  if (!READING_STATUSES.includes(value as ReadingStatus)) {
    throw new InvalidArgumentError(
      `Reading status must be one of ${READING_STATUSES.join(", ")}`,
    );
  }
  return value as ReadingStatus;
}

function subscriptionKind(value: string): SubscriptionKind {
  if (!SUBSCRIPTION_KINDS.includes(value as SubscriptionKind)) {
    throw new InvalidArgumentError(
      `Subscription kind must be one of ${SUBSCRIPTION_KINDS.join(", ")}`,
    );
  }
  return value as SubscriptionKind;
}

function recommendation(value: string): ReadingRecommendation {
  if (!RECOMMENDATIONS.includes(value as ReadingRecommendation)) {
    throw new InvalidArgumentError(
      `Recommendation must be one of ${RECOMMENDATIONS.join(", ")}`,
    );
  }
  return value as ReadingRecommendation;
}

function reviewLevel(value: string): ReviewLevel {
  if (!REVIEW_LEVELS.includes(value as ReviewLevel)) {
    throw new InvalidArgumentError(
      `Review level must be one of ${REVIEW_LEVELS.join(", ")}`,
    );
  }
  return value as ReviewLevel;
}

function readingMode(value: string): ReadingMode {
  if (!READING_MODES.includes(value as ReadingMode)) {
    throw new InvalidArgumentError(
      `Reading mode must be one of ${READING_MODES.join(", ")}`,
    );
  }
  return value as ReadingMode;
}

function readingIntent(value: string): "exploratory" | "goal-oriented" {
  if (value !== "exploratory" && value !== "goal-oriented") {
    throw new InvalidArgumentError(
      "Reading intent must be exploratory or goal-oriented",
    );
  }
  return value;
}

function checkpointLevel(value: string): 1 | 2 | 3 {
  const result = Number(value);
  if (result !== 1 && result !== 2 && result !== 3) {
    throw new InvalidArgumentError("Checkpoint level must be 1, 2, or 3");
  }
  return result;
}

function progressPercent(value: string): number {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || result > 100) {
    throw new InvalidArgumentError("Progress percent must be from 0 to 100");
  }
  return result;
}

function understanding(value: string): number {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || result > 5) {
    throw new InvalidArgumentError("Understanding must be from 0 to 5");
  }
  return result;
}

function feedbackType(value: string): FeedbackType {
  if (!FEEDBACK_TYPES.includes(value as FeedbackType)) {
    throw new InvalidArgumentError(
      `Feedback type must be one of ${FEEDBACK_TYPES.join(", ")}`,
    );
  }
  return value as FeedbackType;
}

function rating(value: string): number {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || result > 10) {
    throw new InvalidArgumentError("Rating must be from 0 to 10");
  }
  return result;
}

function booleanValue(value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new InvalidArgumentError("Boolean value must be true or false");
}

function pipeList(value: string): string[] {
  const items = value
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!items.length) {
    throw new InvalidArgumentError("At least one item is required");
  }
  return items;
}

function scoreList(value: string): number[] {
  const scores = value.split(",").map(Number);
  if (
    !scores.length ||
    scores.some((score) => !Number.isFinite(score) || score < 0 || score > 1)
  ) {
    throw new InvalidArgumentError(
      "Scores must be comma-separated values from 0 to 1",
    );
  }
  return scores;
}

function isoDate(value: string): Date {
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) {
    throw new InvalidArgumentError("Date must be a valid ISO date/time");
  }
  return result;
}

function providerList(value: string): SearchProviderName[] {
  const providers = commaList(value);
  if (
    providers.length === 0 ||
    providers.some(
      (provider) => !PROVIDERS.includes(provider as SearchProviderName),
    )
  ) {
    throw new InvalidArgumentError(
      `Providers must be a comma-separated subset of ${PROVIDERS.join(", ")}`,
    );
  }
  return providers as SearchProviderName[];
}

function commaList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function boundedRatio(value: string): number {
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || result > 1) {
    throw new InvalidArgumentError("Value must be from 0 to 1");
  }
  return result;
}

function positiveInt(value: string): number {
  const result = Number(value);
  if (!Number.isInteger(result) || result < 1) {
    throw new InvalidArgumentError("Value must be a positive integer");
  }
  return result;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function command<Arguments extends unknown[]>(
  action: (...args: Arguments) => Promise<void>,
): (...args: Arguments) => Promise<void> {
  return async (...args) => {
    try {
      await action(...args);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Error: ${message}\n`);
      process.exitCode = 1;
    }
  };
}
