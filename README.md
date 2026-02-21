# VLM-Driven Web Automation & Scraping Agent

Deterministic Puppeteer runner for VLM-style web automation:

- Observe (screenshot + visible DOM snapshot)
- Reason (flow step selection with selector fallback)
- Act (click/type/select/scroll/wait/extract)
- Verify (URL and DOM digest change checks)

Every run generates replayable automation artifacts so the flow can be executed again without manual intervention.

## What this project outputs

Each run writes the following files into `runs/<goal>-<timestamp>/`:

1. `step-by-step-flow.md`  
   Ordered action log with purpose, selector, command, and verification result.
2. `replay-script.js`  
   Standalone Puppeteer script generated from the scenario.
3. `selector-map.md`  
   Human-readable UI element -> selector mapping with stability notes.
4. `failure-modes.md`  
   Common breakpoints and recovery strategies, plus observed runtime failures.
5. `run-report.json`  
   Machine-readable full log, extracted data, and step diagnostics.

## Setup

```bash
npm install
```

## Run examples

Extract top stories from Hacker News:

```bash
npm run run:example
```

Submit a demo form and extract response:

```bash
node src/cli.js --scenario examples/httpbin-form-submit.json
```

Override runtime values:

```bash
node src/cli.js \
  --scenario examples/httpbin-form-submit.json \
  --inputs '{"customer":{"name":"Jordan","phone":"555-0188","email":"jordan@example.com","notes":"hello"}}' \
  --headless true
```

## Scenario format

Scenario files are JSON and define the deterministic flow:

```json
{
  "targetUrl": "https://example.com",
  "goal": "Human-readable objective",
  "inputs": {
    "email": "user@example.com"
  },
  "selectorMap": {
    "Email field": "input[name=\"email\"]"
  },
  "flow": [
    {
      "purpose": "Wait for login form",
      "action": "waitForSelector",
      "selector": "form[data-testid=\"login\"]"
    },
    {
      "purpose": "Type email",
      "action": "type",
      "selector": "input[name=\"email\"]",
      "value": "{{email}}"
    },
    {
      "purpose": "Stop flow",
      "action": "finish"
    }
  ]
}
```

Supported actions:

- `navigate`
- `waitForSelector`
- `click`
- `type`
- `select`
- `press`
- `waitForNavigation`
- `scroll`
- `extract`
- `finish`

Selector precedence:

1. Stable attributes (`id`, `name`, `aria-label`, `data-*`)
2. Class/tag CSS selectors
3. XPath fallback (`xpath=...`) only when no stable CSS selector is available

## CLI options

- `--scenario <path>` (required)
- `--inputs '<json>'`
- `--goal "<text>"`
- `--url <target-url>`
- `--maxSteps <number>`
- `--headless <true|false>`
- `--outputDir <path>`
- `--outputRoot <path>`
- `--stepTimeoutMs <number>`
- `--navigationTimeoutMs <number>`

## Notes

- No coordinate-based clicking is used unless explicitly encoded in the flow.
- Every action is logged with the exact selector used.
- Template variables in actions use `{{path.to.value}}` syntax.
