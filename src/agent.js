import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import puppeteer from "puppeteer";

import { buildReplayScript } from "./replayTemplate.js";

const DEFAULT_STEP_TIMEOUT_MS = 10_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_VISIBLE_ELEMENTS = 250;

function slugify(value) {
  return String(value || "run")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function runTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isXpathSelector(selector) {
  return typeof selector === "string" && selector.startsWith("xpath=");
}

function toSerializableError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    stack: error?.stack || "",
  };
}

function readPathFromObject(input, keyPath) {
  const pathParts = keyPath.split(".");
  let cursor = input;
  for (const part of pathParts) {
    if (cursor == null || !(part in cursor)) {
      return "";
    }
    cursor = cursor[part];
  }
  return cursor == null ? "" : cursor;
}

function resolveTemplates(value, inputs) {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_, keyPath) => {
      const resolvedValue = readPathFromObject(inputs, keyPath);
      return resolvedValue == null ? "" : String(resolvedValue);
    });
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplates(item, inputs));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, resolveTemplates(nested, inputs)]),
    );
  }

  return value;
}

function inferSelectorStability(selector) {
  if (!selector) {
    return { level: "unknown", notes: "No selector was recorded." };
  }

  if (selector.startsWith("xpath=")) {
    return {
      level: "low",
      notes: "XPath fallback works but can become brittle when layout changes.",
    };
  }

  if (
    selector.includes("[data-testid") ||
    selector.includes("[data-test") ||
    selector.includes("[data-qa") ||
    selector.includes("[aria-label") ||
    selector.includes("[name=") ||
    selector.includes("#")
  ) {
    return {
      level: "high",
      notes: "Attribute-driven selector, usually stable across visual changes.",
    };
  }

  if (selector.includes(":nth-child") || selector.includes(">")) {
    return {
      level: "low",
      notes: "Structural selector may break if sibling ordering changes.",
    };
  }

  return {
    level: "medium",
    notes: "Class/tag selector is reusable but sensitive to CSS refactors.",
  };
}

function actionToCommand(action, selectorUsed) {
  const selector = selectorUsed || action.selector || "";
  switch (action.action) {
    case "waitForSelector":
      return `await page.waitForSelector("${selector}", { visible: true });`;
    case "click":
      return `await page.click("${selector}");`;
    case "type":
      return `await page.type("${selector}", "<value>");`;
    case "select":
      return `await page.select("${selector}", "<option>");`;
    case "waitForNavigation":
      return `await page.waitForNavigation({ waitUntil: "domcontentloaded" });`;
    case "press":
      return action.selector
        ? `await page.focus("${selector}"); await page.keyboard.press("${action.key || "Enter"}");`
        : `await page.keyboard.press("${action.key || "Enter"}");`;
    case "scroll":
      return action.selector
        ? `await page.$eval("${selector}", (el) => el.scrollIntoView({ block: "center" }));`
        : `await page.evaluate(() => window.scrollBy(0, 600));`;
    case "extract":
      return `const data = await page.$$eval("${selector}", (nodes) => nodes.map((n) => n.textContent?.trim()));`;
    case "navigate":
      return `await page.goto("${action.url || "<url>"}", { waitUntil: "domcontentloaded" });`;
    case "finish":
      return "// Flow complete.";
    default:
      return `// Unsupported action: ${action.action}`;
  }
}

function normalizeCandidateSelectors(action) {
  const selectors = [action.selector, ...(action.fallbackSelectors || [])].filter(Boolean);
  return [...new Set(selectors)];
}

async function waitForSelectorLike(page, selector, timeoutMs) {
  if (isXpathSelector(selector)) {
    const xpath = selector.slice("xpath=".length);
    await page.waitForFunction(
      (expression) => {
        const node = document.evaluate(
          expression,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null,
        ).singleNodeValue;
        if (!node) {
          return false;
        }
        const rect = node.getBoundingClientRect();
        const style = window.getComputedStyle(node);
        return (
          rect.width > 0 &&
          rect.height > 0 &&
          style.visibility !== "hidden" &&
          style.display !== "none"
        );
      },
      { timeout: timeoutMs },
      xpath,
    );

    const handle = await page.evaluateHandle((expression) => {
      return document.evaluate(
        expression,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null,
      ).singleNodeValue;
    }, xpath);
    const element = handle.asElement();
    if (!element) {
      throw new Error(`XPath did not resolve to a DOM element: ${selector}`);
    }
    return element;
  }

  const element = await page.waitForSelector(selector, {
    visible: true,
    timeout: timeoutMs,
  });
  if (!element) {
    throw new Error(`Selector did not resolve to an element: ${selector}`);
  }
  return element;
}

async function pickWorkingSelector(page, action, timeoutMs) {
  const candidates = normalizeCandidateSelectors(action);
  if (candidates.length === 0) {
    throw new Error(`Action "${action.action}" requires selector candidates.`);
  }

  for (const selector of candidates) {
    try {
      const handle = await waitForSelectorLike(page, selector, timeoutMs);
      await handle.dispose();
      return selector;
    } catch {
      // Try the next selector candidate.
    }
  }

  throw new Error(
    `None of the selector candidates resolved for "${action.action}": ${candidates.join(", ")}`,
  );
}

async function collectVisibleDomSnapshot(page, maxElements) {
  return page.evaluate((maxCount) => {
    const isVisible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = window.getComputedStyle(node);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      );
    };

    const cssPath = (node) => {
      if (node.id) {
        return `#${node.id}`;
      }
      const parts = [];
      let current = node;
      while (current && current.nodeType === Node.ELEMENT_NODE && parts.length < 4) {
        let part = current.tagName.toLowerCase();
        if (current.classList.length > 0) {
          part += `.${Array.from(current.classList).slice(0, 2).join(".")}`;
        }
        parts.unshift(part);
        current = current.parentElement;
      }
      return parts.join(" > ");
    };

    const nodes = Array.from(
      document.querySelectorAll(
        "a, button, input, select, textarea, [role='button'], [aria-label], [data-testid], [data-test], [data-qa]",
      ),
    )
      .filter((node) => isVisible(node))
      .slice(0, maxCount);

    const elements = nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        tag: node.tagName.toLowerCase(),
        text: (node.innerText || node.textContent || "").trim().slice(0, 120),
        id: node.id || null,
        name: node.getAttribute("name"),
        role: node.getAttribute("role"),
        ariaLabel: node.getAttribute("aria-label"),
        placeholder: node.getAttribute("placeholder"),
        dataTestId: node.getAttribute("data-testid"),
        href: node.getAttribute("href"),
        type: node.getAttribute("type"),
        selectorHint: cssPath(node),
        rect: {
          x: Number(rect.x.toFixed(2)),
          y: Number(rect.y.toFixed(2)),
          width: Number(rect.width.toFixed(2)),
          height: Number(rect.height.toFixed(2)),
        },
      };
    });

    return {
      title: document.title,
      location: window.location.href,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
      },
      visibleElements: elements,
    };
  }, maxElements);
}

async function captureObservation({ page, outputDir, stepIndex, phase, maxVisibleElements }) {
  const basename = `step-${String(stepIndex).padStart(3, "0")}-${phase}`;
  const screenshotPath = path.join(outputDir, `${basename}.png`);
  const domSnapshotPath = path.join(outputDir, `${basename}-dom.json`);

  await page.screenshot({ path: screenshotPath, fullPage: false });
  const domSnapshot = await collectVisibleDomSnapshot(page, maxVisibleElements);
  await fs.writeFile(domSnapshotPath, `${JSON.stringify(domSnapshot, null, 2)}\n`, "utf8");

  const domDigest = digest(JSON.stringify(domSnapshot.visibleElements));

  return {
    phase,
    screenshotPath,
    domSnapshotPath,
    domDigest,
    url: domSnapshot.location,
    title: domSnapshot.title,
    visibleElementCount: domSnapshot.visibleElements.length,
    capturedAt: new Date().toISOString(),
  };
}

async function performExtraction(page, action, selector) {
  return page.evaluate(
    ({ selectorExpression, multiple, limit, fields, attribute }) => {
      const nodes = selectorExpression.startsWith("xpath=")
        ? (() => {
            const expression = selectorExpression.slice("xpath=".length);
            const snapshot = document.evaluate(
              expression,
              document,
              null,
              XPathResult.ORDERED_NODE_SNAPSHOT_TYPE,
              null,
            );
            const output = [];
            for (let i = 0; i < snapshot.snapshotLength; i += 1) {
              output.push(snapshot.snapshotItem(i));
            }
            return output;
          })()
        : Array.from(document.querySelectorAll(selectorExpression));

      const selected = Number.isFinite(limit) ? nodes.slice(0, limit) : nodes;

      const readField = (node, descriptor) => {
        if (descriptor === "textContent") {
          return (node.textContent || "").trim();
        }
        if (descriptor === "innerText") {
          return (node.innerText || "").trim();
        }
        if (descriptor === "href") {
          return node.href || node.getAttribute("href");
        }
        if (descriptor === "value") {
          return node.value;
        }
        if (descriptor === "html") {
          return node.innerHTML;
        }
        if (typeof descriptor === "string" && descriptor.startsWith("attribute:")) {
          return node.getAttribute(descriptor.slice("attribute:".length));
        }
        return node.getAttribute(descriptor);
      };

      const toRecord = (node) => {
        if (fields && Object.keys(fields).length > 0) {
          const record = {};
          for (const [key, descriptor] of Object.entries(fields)) {
            record[key] = readField(node, descriptor);
          }
          return record;
        }
        if (attribute) {
          return node.getAttribute(attribute);
        }
        return (node.textContent || "").trim();
      };

      if (!multiple) {
        if (selected.length === 0) {
          return null;
        }
        return toRecord(selected[0]);
      }

      return selected.map((node) => toRecord(node));
    },
    {
      selectorExpression: selector,
      multiple: Boolean(action.multiple),
      limit: Number.isFinite(Number(action.limit)) ? Number(action.limit) : null,
      fields: action.fields || null,
      attribute: action.attribute || null,
    },
  );
}

async function executeAction({ page, action, timeoutMs }) {
  const resolvedAction = { ...action };
  const result = {
    selectorUsed: null,
    command: "",
    extraction: undefined,
  };

  switch (resolvedAction.action) {
    case "navigate": {
      if (!resolvedAction.url) {
        throw new Error("navigate action requires a url.");
      }
      await page.goto(String(resolvedAction.url), { waitUntil: "domcontentloaded" });
      result.command = `await page.goto("${resolvedAction.url}", { waitUntil: "domcontentloaded" });`;
      return result;
    }

    case "waitForSelector": {
      const selector = await pickWorkingSelector(page, resolvedAction, timeoutMs);
      const handle = await waitForSelectorLike(page, selector, timeoutMs);
      await handle.dispose();
      result.selectorUsed = selector;
      result.command = actionToCommand(resolvedAction, selector);
      return result;
    }

    case "click": {
      const selector = await pickWorkingSelector(page, resolvedAction, timeoutMs);
      const handle = await waitForSelectorLike(page, selector, timeoutMs);
      await handle.evaluate((node) =>
        node.scrollIntoView({ behavior: "auto", block: "center", inline: "center" }),
      );

      if (resolvedAction.waitForNavigation) {
        await Promise.all([
          page.waitForNavigation({
            timeout: timeoutMs * 3,
            waitUntil: resolvedAction.waitUntil || "domcontentloaded",
          }),
          handle.click(),
        ]);
      } else {
        await handle.click();
      }
      await handle.dispose();

      result.selectorUsed = selector;
      result.command = actionToCommand(resolvedAction, selector);
      return result;
    }

    case "type": {
      const selector = await pickWorkingSelector(page, resolvedAction, timeoutMs);
      const handle = await waitForSelectorLike(page, selector, timeoutMs);
      await handle.click({ clickCount: 3 });
      await page.keyboard.press("Backspace");
      await page.keyboard.type(String(resolvedAction.value || ""), {
        delay: Number(resolvedAction.typeDelayMs || 0),
      });
      await handle.dispose();

      result.selectorUsed = selector;
      result.command = actionToCommand(resolvedAction, selector);
      return result;
    }

    case "select": {
      const selector = await pickWorkingSelector(page, resolvedAction, timeoutMs);
      const handle = await waitForSelectorLike(page, selector, timeoutMs);
      if (isXpathSelector(selector)) {
        await handle.evaluate((node, value) => {
          node.value = value;
          node.dispatchEvent(new Event("input", { bubbles: true }));
          node.dispatchEvent(new Event("change", { bubbles: true }));
        }, String(resolvedAction.value || ""));
      } else {
        await page.select(selector, String(resolvedAction.value || ""));
      }
      await handle.dispose();

      result.selectorUsed = selector;
      result.command = actionToCommand(resolvedAction, selector);
      return result;
    }

    case "press": {
      if (resolvedAction.selector) {
        const selector = await pickWorkingSelector(page, resolvedAction, timeoutMs);
        const handle = await waitForSelectorLike(page, selector, timeoutMs);
        await handle.focus();
        await page.keyboard.press(String(resolvedAction.key || "Enter"));
        await handle.dispose();
        result.selectorUsed = selector;
      } else {
        await page.keyboard.press(String(resolvedAction.key || "Enter"));
      }
      result.command = actionToCommand(resolvedAction, result.selectorUsed);
      return result;
    }

    case "waitForNavigation": {
      await page.waitForNavigation({
        timeout: timeoutMs * 3,
        waitUntil: resolvedAction.waitUntil || "domcontentloaded",
      });
      result.command = actionToCommand(resolvedAction);
      return result;
    }

    case "scroll": {
      if (resolvedAction.selector) {
        const selector = await pickWorkingSelector(page, resolvedAction, timeoutMs);
        const handle = await waitForSelectorLike(page, selector, timeoutMs);
        await handle.evaluate((node) =>
          node.scrollIntoView({ behavior: "auto", block: "center", inline: "center" }),
        );
        await handle.dispose();
        result.selectorUsed = selector;
      } else {
        const x = Number(resolvedAction.x || 0);
        const y = Number(resolvedAction.y || 600);
        await page.evaluate(
          ({ xOffset, yOffset }) => window.scrollBy(xOffset, yOffset),
          { xOffset: x, yOffset: y },
        );
      }
      result.command = actionToCommand(resolvedAction, result.selectorUsed);
      return result;
    }

    case "extract": {
      const selector = await pickWorkingSelector(page, resolvedAction, timeoutMs);
      result.extraction = await performExtraction(page, resolvedAction, selector);
      result.selectorUsed = selector;
      result.command = actionToCommand(resolvedAction, selector);
      return result;
    }

    case "finish":
      result.command = actionToCommand(resolvedAction);
      return result;

    default:
      throw new Error(`Unsupported action type: ${resolvedAction.action}`);
  }
}

function ensureScenario(scenario) {
  if (!scenario || typeof scenario !== "object") {
    throw new Error("Scenario must be an object.");
  }
  if (!scenario.targetUrl || typeof scenario.targetUrl !== "string") {
    throw new Error("Scenario must include targetUrl.");
  }
  if (!Array.isArray(scenario.flow)) {
    throw new Error("Scenario must include flow as an array.");
  }
}

async function writeStepByStepFlow({ outputDir, goal, stepLogs }) {
  const lines = [
    "# Step-by-Step Flow",
    "",
    `Goal: ${goal || "Not provided"}`,
    "",
    "| Step | Purpose | Selector Used | Puppeteer Command | Verification |",
    "| --- | --- | --- | --- | --- |",
  ];

  for (const log of stepLogs) {
    const verification = `${log.verification.urlChanged ? "URL changed" : "URL same"}, ${
      log.verification.domChanged ? "DOM changed" : "DOM same"
    }`;
    lines.push(
      `| ${log.step} | ${log.purpose || "-"} | \`${log.selectorUsed || "-"}\` | \`${log.command}\` | ${verification} |`,
    );
  }

  const filePath = path.join(outputDir, "step-by-step-flow.md");
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
  return filePath;
}

async function writeSelectorMap({ outputDir, scenarioSelectorMap, stepLogs }) {
  const records = [];
  const seen = new Set();

  for (const [label, selector] of Object.entries(scenarioSelectorMap || {})) {
    const key = `${label}::${selector}`;
    if (!seen.has(key)) {
      seen.add(key);
      records.push({ element: label, selector, source: "scenario" });
    }
  }

  for (const log of stepLogs) {
    if (!log.selectorUsed) {
      continue;
    }
    const label = log.purpose || `Step ${log.step}`;
    const key = `${label}::${log.selectorUsed}`;
    if (!seen.has(key)) {
      seen.add(key);
      records.push({ element: label, selector: log.selectorUsed, source: "execution" });
    }
  }

  const lines = [
    "# Selector Map",
    "",
    "| UI Element | Selector | Stability | Notes | Source |",
    "| --- | --- | --- | --- | --- |",
  ];

  for (const record of records) {
    const stability = inferSelectorStability(record.selector);
    lines.push(
      `| ${record.element} | \`${record.selector}\` | ${stability.level} | ${stability.notes} | ${record.source} |`,
    );
  }

  const filePath = path.join(outputDir, "selector-map.md");
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
  return filePath;
}

async function writeFailureModes({ outputDir, stepLogs, fatalError }) {
  const observedFailures = stepLogs.filter((log) => !log.success);
  const lines = [
    "# Failure Modes and Recovery Strategies",
    "",
    "## Common Breakpoints",
    "- Dynamic IDs or randomized class names can invalidate selectors. Recovery: prefer id/name/aria/data attributes and add fallback selectors.",
    "- Cookie banners or modal overlays can intercept clicks. Recovery: detect and dismiss overlays before core actions.",
    "- Lazy loading can hide targets until scroll. Recovery: use `scroll` + `waitForSelector` before interaction.",
    "- Navigation races after click can break timing. Recovery: use click with `waitForNavigation` when transition is expected.",
    "- Detached elements after re-rendering can fail handles. Recovery: reacquire selectors immediately before each action.",
    "- CAPTCHAs or bot defenses can block automation. Recovery: detect challenge pages and fail fast with explicit diagnostics.",
    "",
    "## Observed During Latest Run",
  ];

  if (observedFailures.length === 0 && !fatalError) {
    lines.push("- No runtime failures detected.");
  } else {
    for (const failure of observedFailures) {
      lines.push(
        `- Step ${failure.step}: ${failure.error.message}. Recovery: verify selector map and add alternate selector candidates.`,
      );
    }
    if (fatalError) {
      lines.push(
        `- Fatal run error: ${fatalError.message}. Recovery: check network accessibility and scenario completeness.`,
      );
    }
  }

  const filePath = path.join(outputDir, "failure-modes.md");
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
  return filePath;
}

async function writeRunReport({ outputDir, goal, scenario, stepLogs, extracted, fatalError, success }) {
  const report = {
    goal,
    targetUrl: scenario.targetUrl,
    startedAt: scenario.startedAt,
    completedAt: new Date().toISOString(),
    success,
    fatalError,
    extracted,
    stepLogs,
  };

  const reportPath = path.join(outputDir, "run-report.json");
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return reportPath;
}

async function writeReplayScript({ outputDir, scenario }) {
  const replayScript = buildReplayScript({ scenario });
  const replayPath = path.join(outputDir, "replay-script.js");
  await fs.writeFile(replayPath, replayScript, "utf8");
  return replayPath;
}

export class VlmWebAutomationAgent {
  constructor(options = {}) {
    this.headless = options.headless ?? true;
    this.outputRoot = options.outputRoot ? path.resolve(options.outputRoot) : path.resolve("runs");
    this.stepTimeoutMs = Number(options.stepTimeoutMs || DEFAULT_STEP_TIMEOUT_MS);
    this.navigationTimeoutMs = Number(
      options.navigationTimeoutMs || DEFAULT_NAVIGATION_TIMEOUT_MS,
    );
    this.maxVisibleElements = Number(
      options.maxVisibleElements || DEFAULT_MAX_VISIBLE_ELEMENTS,
    );
  }

  async run(rawScenario) {
    ensureScenario(rawScenario);
    const scenario = resolveTemplates(rawScenario, rawScenario.inputs || {});
    scenario.startedAt = new Date().toISOString();

    const runLabel = `${slugify(scenario.goal || "automation")}-${runTimestamp()}`;
    const outputDir = scenario.outputDir
      ? path.resolve(scenario.outputDir)
      : path.join(this.outputRoot, runLabel);
    await fs.mkdir(outputDir, { recursive: true });

    const browser = await puppeteer.launch({
      headless: this.headless,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    page.setDefaultTimeout(this.stepTimeoutMs);
    page.setDefaultNavigationTimeout(this.navigationTimeoutMs);

    const stepLogs = [];
    const extracted = {};
    let fatalError = null;
    let success = true;

    try {
      await page.goto(scenario.targetUrl, { waitUntil: "domcontentloaded" });

      const maxSteps = Number.isFinite(Number(scenario.maxSteps))
        ? Math.min(Number(scenario.maxSteps), scenario.flow.length)
        : scenario.flow.length;

      for (let index = 0; index < maxSteps; index += 1) {
        const action = scenario.flow[index];
        const stepNumber = index + 1;
        const startedAt = Date.now();

        const beforeObservation = await captureObservation({
          page,
          outputDir,
          stepIndex: stepNumber,
          phase: "before",
          maxVisibleElements: this.maxVisibleElements,
        });

        let selectorUsed = null;
        let command = actionToCommand(action);
        let extraction = undefined;
        let error = null;
        let stepSuccess = true;

        try {
          const actionResult = await executeAction({
            page,
            action,
            timeoutMs: this.stepTimeoutMs,
          });
          selectorUsed = actionResult.selectorUsed;
          command = actionResult.command;
          extraction = actionResult.extraction;
          if (action.action === "extract" && action.name) {
            extracted[action.name] = extraction;
          }
        } catch (stepError) {
          stepSuccess = false;
          success = false;
          error = toSerializableError(stepError);
        }

        const afterObservation = await captureObservation({
          page,
          outputDir,
          stepIndex: stepNumber,
          phase: stepSuccess ? "after" : "error",
          maxVisibleElements: this.maxVisibleElements,
        });

        const verification = {
          urlChanged: beforeObservation.url !== afterObservation.url,
          domChanged: beforeObservation.domDigest !== afterObservation.domDigest,
          beforeUrl: beforeObservation.url,
          afterUrl: afterObservation.url,
        };

        if (stepSuccess && action.expectStateChange && !verification.urlChanged && !verification.domChanged) {
          stepSuccess = false;
          success = false;
          error = {
            name: "VerificationError",
            message: "Expected a state change but none was detected.",
            stack: "",
          };
        }

        const stepLog = {
          step: stepNumber,
          purpose: action.purpose || "",
          action: action.action,
          selectorRequested: action.selector || null,
          selectorUsed,
          fallbackSelectors: action.fallbackSelectors || [],
          command,
          success: stepSuccess,
          error,
          extraction,
          startedAt: new Date(startedAt).toISOString(),
          durationMs: Date.now() - startedAt,
          verification,
          observeBefore: beforeObservation,
          observeAfter: afterObservation,
        };
        stepLogs.push(stepLog);

        if (!stepSuccess && !action.continueOnError) {
          break;
        }
        if (action.action === "finish") {
          break;
        }
      }
    } catch (runError) {
      success = false;
      fatalError = toSerializableError(runError);
    } finally {
      await page.close().catch(() => {});
      await browser.close().catch(() => {});
    }

    const artifactPaths = {
      flow: await writeStepByStepFlow({
        outputDir,
        goal: scenario.goal,
        stepLogs,
      }),
      selectorMap: await writeSelectorMap({
        outputDir,
        scenarioSelectorMap: scenario.selectorMap || {},
        stepLogs,
      }),
      failureModes: await writeFailureModes({
        outputDir,
        stepLogs,
        fatalError,
      }),
      replayScript: await writeReplayScript({
        outputDir,
        scenario: {
          targetUrl: scenario.targetUrl,
          goal: scenario.goal,
          inputs: scenario.inputs || {},
          flow: scenario.flow,
          stepTimeoutMs: this.stepTimeoutMs,
        },
      }),
      report: await writeRunReport({
        outputDir,
        goal: scenario.goal,
        scenario,
        stepLogs,
        extracted,
        fatalError,
        success,
      }),
    };

    return {
      success,
      outputDir,
      artifactPaths,
      extracted,
      stepLogs,
      fatalError,
    };
  }
}

export async function loadScenarioFromPath(scenarioPath) {
  const absolutePath = path.resolve(scenarioPath);
  const raw = await fs.readFile(absolutePath, "utf8");
  return JSON.parse(raw);
}

export function currentModuleDirectory() {
  return path.dirname(fileURLToPath(import.meta.url));
}
