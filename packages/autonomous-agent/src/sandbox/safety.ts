/**
 * Static safety checks applied before experiment execution.
 *
 * These checks are deliberately conservative and complement, rather than
 * replace, process/container isolation.
 */

import type { AgentConfig } from "../types/config.js";
import type { Experiment } from "../types/experiment.js";
import type { Mission } from "../types/mission.js";

export interface SafetyAssessment {
  safe: boolean;
  violations: string[];
  warnings: string[];
  requiresApproval: boolean;
}

const COMMON_DENY_PATTERNS: Array<[RegExp, string]> = [
  [/\beval\s*\(/, "Dynamic eval is not allowed"],
  [/\bnew\s+Function\s*\(/, "Dynamic Function construction is not allowed"],
  [/\bprocess\.(?:kill|exit)\s*\(/, "Process termination APIs are not allowed"],
  [/(?:^|[\\/])\.\.(?:[\\/]|$)/m, "Parent-directory traversal is not allowed"],
];

const JAVASCRIPT_DENY_PATTERNS: Array<[RegExp, string]> = [
  [
    /(?:node:)?child_process|\b(?:exec|spawn|fork)\s*\(/,
    "Child-process execution is not allowed",
  ],
  [
    /(?:from\s+|require\s*\(\s*)["'](?:node:)?(?:net|tls|dgram|http|https)["']|\bfetch\s*\(/,
    "Network access is not allowed in generated experiments",
  ],
  [
    /\bprocess\.chdir\s*\(/,
    "Changing the process working directory is not allowed",
  ],
];

const PYTHON_DENY_PATTERNS: Array<[RegExp, string]> = [
  [
    /\b(?:subprocess|socket|requests|urllib|httpx)\b/,
    "Subprocess and network modules are not allowed",
  ],
  [
    /\bos\.(?:system|popen|chdir|remove|unlink|rmdir)\s*\(/,
    "Unsafe operating-system calls are not allowed",
  ],
];

const BASH_DENY_PATTERNS: Array<[RegExp, string]> = [
  [
    /\b(?:curl|wget|nc|ncat|netcat|ssh|scp|ftp)\b|\/dev\/tcp\//,
    "Network and remote-shell commands are not allowed",
  ],
  [
    /\b(?:rm|rmdir|mv|chmod|chown|mount|umount)\b/,
    "Destructive filesystem commands are not allowed",
  ],
  [
    /\b(?:bash|sh|zsh|pwsh|powershell|cmd)\s+-c\b/,
    "Nested shell execution is not allowed",
  ],
];

export function assessExperimentSafety(
  experiment: Experiment,
  mission: Mission,
  config: AgentConfig,
): SafetyAssessment {
  const code = experiment.design.code ?? "";
  const violations: string[] = [];
  const warnings: string[] = [];

  if (!code.trim()) {
    violations.push("Experiment has no executable code");
  }
  if (Buffer.byteLength(code, "utf8") > 100_000) {
    violations.push("Experiment code exceeds the 100KB safety limit");
  }

  for (const [pattern, message] of COMMON_DENY_PATTERNS) {
    if (pattern.test(code)) {
      violations.push(message);
    }
  }

  const languagePatterns =
    experiment.design.codeLanguage === "python"
      ? PYTHON_DENY_PATTERNS
      : experiment.design.codeLanguage === "bash"
        ? BASH_DENY_PATTERNS
        : experiment.design.codeLanguage === "javascript" ||
            experiment.design.codeLanguage === "typescript" ||
            experiment.design.codeLanguage === undefined
          ? JAVASCRIPT_DENY_PATTERNS
          : [];

  for (const [pattern, message] of languagePatterns) {
    if (pattern.test(code)) {
      violations.push(message);
    }
  }

  if (config.sandbox.type === "local") {
    warnings.push(
      "Local execution is process-limited but not equivalent to container isolation",
    );
  }

  const exceedsAutoApproval =
    parseDurationHours(experiment.design.expectedDuration) >
    config.budget.autoApprove.maxComputeHoursPerExperiment;
  const requiresApproval =
    config.sandbox.type === "local" ||
    mission.budget.approvalRequired ||
    !config.budget.autoApprove.enabled ||
    exceedsAutoApproval;

  return {
    safe: violations.length === 0,
    violations: [...new Set(violations)],
    warnings,
    requiresApproval,
  };
}

function parseDurationHours(value: string): number {
  const minuteMatch = value.match(/([\d.]+)\s*minutes?/i);
  if (minuteMatch) {
    return Number(minuteMatch[1]) / 60;
  }
  const hourMatch = value.match(/([\d.]+)\s*hours?/i);
  if (hourMatch) {
    return Number(hourMatch[1]);
  }
  const secondMatch = value.match(/([\d.]+)\s*seconds?/i);
  if (secondMatch) {
    return Number(secondMatch[1]) / 3600;
  }
  return Number.POSITIVE_INFINITY;
}
