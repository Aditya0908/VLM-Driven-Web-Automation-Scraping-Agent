#!/usr/bin/env node
import path from "node:path";

import { VlmWebAutomationAgent, loadScenarioFromPath } from "./agent.js";

function parseArgs(argv) {
  const args = {};

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = value;
    i += 1;
  }

  return args;
}

function parseBoolean(value, fallbackValue) {
  if (value === undefined) {
    return fallbackValue;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value).toLowerCase();
  if (["1", "true", "yes", "y"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n"].includes(normalized)) {
    return false;
  }
  return fallbackValue;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.scenario) {
    throw new Error(
      "Missing required --scenario path.\nExample: node src/cli.js --scenario examples/hackernews-top-stories.json",
    );
  }

  const scenarioPath = path.resolve(args.scenario);
  const scenario = await loadScenarioFromPath(scenarioPath);

  if (args.url) {
    scenario.targetUrl = args.url;
  }
  if (args.goal) {
    scenario.goal = args.goal;
  }
  if (args.maxSteps) {
    scenario.maxSteps = Number(args.maxSteps);
  }
  if (args.inputs) {
    const parsedInputs = JSON.parse(args.inputs);
    scenario.inputs = {
      ...(scenario.inputs || {}),
      ...parsedInputs,
    };
  }
  if (args.outputDir) {
    scenario.outputDir = path.resolve(args.outputDir);
  }

  const agent = new VlmWebAutomationAgent({
    headless: parseBoolean(args.headless, true),
    outputRoot: args.outputRoot ? path.resolve(args.outputRoot) : undefined,
    stepTimeoutMs: args.stepTimeoutMs ? Number(args.stepTimeoutMs) : undefined,
    navigationTimeoutMs: args.navigationTimeoutMs
      ? Number(args.navigationTimeoutMs)
      : undefined,
  });

  const result = await agent.run(scenario);

  console.log(
    JSON.stringify(
      {
        success: result.success,
        outputDir: result.outputDir,
        artifacts: result.artifactPaths,
        extracted: result.extracted,
        stepCount: result.stepLogs.length,
        fatalError: result.fatalError,
      },
      null,
      2,
    ),
  );

  if (!result.success) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error("Automation run failed:", error);
  process.exitCode = 1;
});
