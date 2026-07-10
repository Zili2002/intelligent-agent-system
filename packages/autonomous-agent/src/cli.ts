#!/usr/bin/env node
/**
 * CLI entry point for the autonomous agent system.
 */

import { Command } from "commander";
import { loadMission, saveMissionState, calculateProgress } from "./mission/manager.js";
import { orientAnalysis } from "./exploration/orient.js";
import { generateHypotheses } from "./exploration/hypothesize.js";
import { designExperiment } from "./exploration/design.js";
import { writeFile, mkdir } from "fs/promises";
import path from "path";

const program = new Command();

program
  .name("autonomous-agent")
  .description("Mission-driven autonomous exploration system")
  .version("0.1.0");

program
  .command("mission-start")
  .description("Start a new mission")
  .argument("<file>", "Mission markdown file")
  .action(async (file: string) => {
    try {
      console.log(`📋 Loading mission: ${file}`);
      const mission = await loadMission(file);

      mission.status = "active";
      mission.startedAt = new Date().toISOString();

      await saveMissionState(mission);

      console.log(`✅ Mission started: ${mission.name}`);
      console.log(`   ID: ${mission.id}`);
      console.log(`   Objective: ${mission.objective}`);
      console.log(`   Metrics: ${mission.successMetrics.length}`);
      console.log(`   Budget: ${mission.budget.llmTokens.toLocaleString()} tokens`);
    } catch (error) {
      console.error(`❌ Error: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("mission-status")
  .description("Show active mission status")
  .argument("<mission-id>", "Mission ID")
  .action(async (missionId: string) => {
    try {
      const mission = await loadMission(`${missionId}.state.json`);
      const progress = calculateProgress(mission);

      console.log(`\n📊 Mission Status: ${mission.name}`);
      console.log(`   Status: ${mission.status}`);
      console.log(`   Progress: ${progress.metricsAchieved}/${progress.metricsTotal} metrics achieved`);
      console.log(`   Checkpoints: ${progress.checkpointsCompleted}/${progress.checkpointsTotal} completed`);
      console.log(`   Budget: ${progress.budgetUsedPercent.toFixed(1)}% used`);
      console.log(`   Experiments: ${progress.experimentsCompleted}`);
      console.log(`   Days elapsed: ${progress.daysElapsed}`);
    } catch (error) {
      console.error(`❌ Error: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("orient")
  .description("Run Orient analysis on active mission")
  .argument("<mission-id>", "Mission ID")
  .action(async (missionId: string) => {
    try {
      console.log(`🧭 Running Orient analysis...`);
      const mission = await loadMission(`${missionId}.state.json`);
      const situation = await orientAnalysis(mission);

      console.log(`\n📍 Current State:`);
      console.log(`   Progress: ${(situation.currentState.progress * 100).toFixed(1)}%`);
      console.log(`   Experiments: ${situation.currentState.experimentsCompleted}`);
      console.log(`   Knowledge gaps: ${situation.currentState.knowledgeGaps.length}`);

      console.log(`\n🎯 Opportunities (${situation.opportunities.length}):`);
      for (const opp of situation.opportunities) {
        console.log(`   [${opp.priority}] ${opp.description}`);
      }

      console.log(`\n⚠️  Risks (${situation.risks.length}):`);
      for (const risk of situation.risks) {
        console.log(`   [${risk.severity}] ${risk.description}`);
      }

      console.log(`\n💡 Recommendations:`);
      for (const rec of situation.recommendations) {
        console.log(`   • ${rec}`);
      }
    } catch (error) {
      console.error(`❌ Error: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("explore")
  .description("Run full exploration cycle")
  .argument("<mission-id>", "Mission ID")
  .action(async (missionId: string) => {
    try {
      console.log(`🚀 Starting exploration cycle...\n`);

      console.log(`[1/3] 🧭 Orient: Analyzing current situation...`);
      const mission = await loadMission(`${missionId}.state.json`);
      const situation = await orientAnalysis(mission);
      console.log(`      Found ${situation.opportunities.length} opportunities, ${situation.risks.length} risks`);

      console.log(`\n[2/3] 💭 Hypothesize: Generating hypotheses...`);
      const hypotheses = generateHypotheses(mission, situation);
      console.log(`      Generated ${hypotheses.length} hypotheses`);

      for (let i = 0; i < hypotheses.length && i < 3; i++) {
        const h = hypotheses[i];
        console.log(`      ${i + 1}. ${h.statement} (confidence: ${(h.confidence * 100).toFixed(0)}%)`);
      }

      if (hypotheses.length > 0) {
        console.log(`\n[3/3] 🔬 Design: Creating experiment for top hypothesis...`);
        const experiment = designExperiment(mission, hypotheses[0]);

        const expDir = path.join(process.cwd(), "experiments", experiment.id);
        await mkdir(expDir, { recursive: true });

        const expFile = path.join(expDir, "experiment.json");
        await writeFile(expFile, JSON.stringify(experiment, null, 2));

        if (experiment.design.code) {
          const codeFile = path.join(expDir, "experiment.py");
          await writeFile(codeFile, experiment.design.code);
        }

        console.log(`      ✅ Experiment designed: ${experiment.id}`);
        console.log(`      📁 Saved to: ${expDir}`);
        console.log(`\n📝 Experiment Steps:`);
        for (let i = 0; i < experiment.design.steps.length; i++) {
          console.log(`   ${i + 1}. ${experiment.design.steps[i]}`);
        }

        console.log(`\n▶️  To execute: cd ${expDir} && python experiment.py`);
      } else {
        console.log(`\n⚠️  No hypotheses generated`);
      }
    } catch (error) {
      console.error(`❌ Error: ${(error as Error).message}`);
      process.exit(1);
    }
  });

program.parse();
