function escapeForSingleQuotedString(value) {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\\'")
    .replace(/\n/g, "\\n");
}

export function buildReplayScript({ scenario }) {
  const serializedScenario = JSON.stringify(scenario, null, 2);

  return `#!/usr/bin/env node
import puppeteer from "puppeteer";

const scenario = ${serializedScenario};

function resolveTemplate(value, inputs) {
  if (typeof value === "string") {
    return value.replace(/\\{\\{\\s*([\\w.-]+)\\s*\\}\\}/g, (_, key) => {
      const parts = key.split(".");
      let cursor = inputs;
      for (const part of parts) {
        if (cursor == null || !(part in cursor)) {
          return "";
        }
        cursor = cursor[part];
      }
      return cursor == null ? "" : String(cursor);
    });
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveTemplate(item, inputs));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [
        key,
        resolveTemplate(nestedValue, inputs),
      ]),
    );
  }

  return value;
}

function isXpathSelector(selector) {
  return typeof selector === "string" && selector.startsWith("xpath=");
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
      throw new Error(\`XPath did not resolve to an element: \${selector}\`);
    }
    return element;
  }

  const element = await page.waitForSelector(selector, {
    visible: true,
    timeout: timeoutMs,
  });
  if (!element) {
    throw new Error(\`Selector not found: \${selector}\`);
  }
  return element;
}

async function chooseSelector(page, action, timeoutMs) {
  const candidates = [action.selector, ...(action.fallbackSelectors || [])].filter(
    Boolean,
  );
  if (candidates.length === 0) {
    throw new Error(\`Action "\${action.action}" requires a selector.\`);
  }

  for (const selector of candidates) {
    try {
      const handle = await waitForSelectorLike(page, selector, timeoutMs);
      await handle.dispose();
      return selector;
    } catch {
      // Try the next candidate selector.
    }
  }

  throw new Error(
    \`Unable to resolve any selector for action "\${action.action}": \${candidates.join(
      ", ",
    )}\`,
  );
}

async function runAction(page, action, timeoutMs) {
  const resolved = { ...action };

  switch (resolved.action) {
    case "waitForSelector": {
      const selector = await chooseSelector(page, resolved, timeoutMs);
      const handle = await waitForSelectorLike(page, selector, timeoutMs);
      await handle.dispose();
      return;
    }
    case "click": {
      const selector = await chooseSelector(page, resolved, timeoutMs);
      const handle = await waitForSelectorLike(page, selector, timeoutMs);
      await handle.evaluate((node) =>
        node.scrollIntoView({ block: "center", inline: "center" }),
      );
      if (resolved.waitForNavigation) {
        await Promise.all([
          page.waitForNavigation({
            timeout: timeoutMs * 3,
            waitUntil: resolved.waitUntil || "domcontentloaded",
          }),
          handle.click(),
        ]);
      } else {
        await handle.click();
      }
      await handle.dispose();
      return;
    }
    case "type": {
      const selector = await chooseSelector(page, resolved, timeoutMs);
      const handle = await waitForSelectorLike(page, selector, timeoutMs);
      await handle.click({ clickCount: 3 });
      await page.keyboard.press("Backspace");
      await page.keyboard.type(String(resolved.value || ""), {
        delay: Number(resolved.typeDelayMs || 0),
      });
      await handle.dispose();
      return;
    }
    case "select": {
      const selector = await chooseSelector(page, resolved, timeoutMs);
      const handle = await waitForSelectorLike(page, selector, timeoutMs);
      if (isXpathSelector(selector)) {
        await handle.evaluate((node, value) => {
          node.value = value;
          node.dispatchEvent(new Event("input", { bubbles: true }));
          node.dispatchEvent(new Event("change", { bubbles: true }));
        }, String(resolved.value || ""));
      } else {
        await page.select(selector, String(resolved.value || ""));
      }
      await handle.dispose();
      return;
    }
    case "press": {
      if (resolved.selector) {
        const selector = await chooseSelector(page, resolved, timeoutMs);
        const handle = await waitForSelectorLike(page, selector, timeoutMs);
        await handle.focus();
        await page.keyboard.press(String(resolved.key || "Enter"));
        await handle.dispose();
      } else {
        await page.keyboard.press(String(resolved.key || "Enter"));
      }
      return;
    }
    case "waitForNavigation": {
      await page.waitForNavigation({
        timeout: timeoutMs * 3,
        waitUntil: resolved.waitUntil || "domcontentloaded",
      });
      return;
    }
    case "scroll": {
      if (resolved.selector) {
        const selector = await chooseSelector(page, resolved, timeoutMs);
        const handle = await waitForSelectorLike(page, selector, timeoutMs);
        await handle.evaluate((node) =>
          node.scrollIntoView({ block: "center", inline: "center" }),
        );
        await handle.dispose();
      } else {
        const x = Number(resolved.x || 0);
        const y = Number(resolved.y || 600);
        await page.evaluate(
          ({ xOffset, yOffset }) => window.scrollBy(xOffset, yOffset),
          { xOffset: x, yOffset: y },
        );
      }
      return;
    }
    case "extract": {
      const selector = await chooseSelector(page, resolved, timeoutMs);
      const extraction = await page.evaluate(
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

          const selected = Number.isFinite(limit)
            ? nodes.slice(0, limit)
            : nodes;

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
            if (typeof descriptor === "string" && descriptor.startsWith("attribute:")) {
              const attributeName = descriptor.slice("attribute:".length);
              return node.getAttribute(attributeName);
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
          multiple: Boolean(resolved.multiple),
          limit: Number.isFinite(Number(resolved.limit))
            ? Number(resolved.limit)
            : null,
          fields: resolved.fields || null,
          attribute: resolved.attribute || null,
        },
      );
      if (resolved.name) {
        console.log(\`[extract] \${resolved.name}: \${JSON.stringify(extraction)}\`);
      } else {
        console.log(\`[extract] \${JSON.stringify(extraction)}\`);
      }
      return;
    }
    case "finish":
      return;
    default:
      throw new Error(\`Unsupported action: \${resolved.action}\`);
  }
}

async function run(inputs = {}) {
  const mergedInputs = { ...(scenario.inputs || {}), ...(inputs || {}) };
  const resolvedFlow = (scenario.flow || []).map((step) =>
    resolveTemplate(step, mergedInputs),
  );

  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    const timeoutMs = Number(scenario.stepTimeoutMs || 10000);
    page.setDefaultTimeout(timeoutMs);
    page.setDefaultNavigationTimeout(timeoutMs * 3);

    await page.goto(scenario.targetUrl, { waitUntil: "domcontentloaded" });

    for (let i = 0; i < resolvedFlow.length; i += 1) {
      const action = resolvedFlow[i];
      await runAction(page, action, timeoutMs);
      if (action.action === "finish") {
        break;
      }
    }

    console.log("Replay completed successfully.");
  } finally {
    await browser.close();
  }
}

if (import.meta.url === \`file://\${process.argv[1]}\`) {
  const envInputs = process.env.AGENT_INPUTS
    ? JSON.parse(process.env.AGENT_INPUTS)
    : {};
  const cliInputs = process.argv[2] ? JSON.parse(process.argv[2]) : {};
  run({ ...envInputs, ...cliInputs }).catch((error) => {
    console.error("Replay failed:", error);
    process.exitCode = 1;
  });
}
`;
}

export function quoteReplayPath(pathValue) {
  return `'${escapeForSingleQuotedString(pathValue)}'`;
}
