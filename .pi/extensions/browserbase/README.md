# Browserbase extension for Pi

Project-local Pi extension for a single lazy Browserbase session per Pi session. It connects with `chromium.connectOverCDP(session.connectUrl)`, uses Browserbase's default context/page, and keeps CDP connection URLs out of tool results and manifests.

## Installation

From the repository root:

```bash
cd .pi/extensions/browserbase
npm install
npm run check
npm test
```

Pi discovers `.pi/extensions/*/index.ts` after the project is trusted. Start Pi from the repository root, or load it explicitly for a quick check:

```bash
pi -e ./.pi/extensions/browserbase/index.ts
```

After changing the extension, use `/reload`. Reload/shutdown closes the Playwright connection and requests Browserbase session release.

## Configuration

Set the key in the process environment (never commit it):

```bash
export BROWSERBASE_API_KEY='bb_live_your_key_here'
# Optional: export BROWSERBASE_PROJECT_ID='your-project-id'
```

`.env.example` documents safe placeholders. The extension does not read or create a `.env` file; use your shell, a secret manager, or Pi's existing environment-loading workflow.

Optional variables:

| Variable                      | Default             | Notes                                                         |
| ----------------------------- | ------------------- | ------------------------------------------------------------- |
| `BROWSERBASE_TIMEOUT_SECONDS` | `900`               | Session lifetime; 60–21600 seconds                            |
| `BROWSERBASE_REGION`          | Browserbase default | `us-west-2`, `us-east-1`, `eu-central-1`, or `ap-southeast-1` |
| `BROWSERBASE_USE_PROXY`       | Browserbase default | `true`/`false`                                                |
| `BROWSERBASE_KEEP_ALIVE`      | `false`             | Keep-alive sessions are explicitly released on close          |
| `BROWSERBASE_VIEWPORT_WIDTH`  | `1440`              | 320–3840                                                      |
| `BROWSERBASE_VIEWPORT_HEIGHT` | `1000`              | 240–2160                                                      |

If the key is absent, tools return a concise setup error and no Browserbase session is created.

## Tools

- `browser_session`: `start`, `status`, or `stop`; reports session ID, Live View, inspector, run directory, and manifest.
- `browser_navigate`: validates credential-free HTTP(S) URLs, reports redirects/status/title/summary, and captures a navigation screenshot by default. Set `captureScreenshot: false` to opt out.
- `browser_snapshot`: compact URL/title/headings/text/ARIA/controls view with stable `[eN]` references. Supports CSS scope, `interactiveOnly`, and truncation.
- `browser_act`: click, fill, type, press, select, check, uncheck, hover, scroll, wait, focus, clear, tab switching, and tab closing. It rejects ambiguous matches and captures before/after evidence for significant actions by default.
- `browser_screenshot`: viewport, full-page, or uniquely targeted element PNG with optional CSS masks. Returns a Pi image block when supported, plus paths and manifest metadata.
- `browser_assert`: URL/title/text, visibility, enabled state, checked state, field value, element text, and count assertions. Failed assertions capture evidence and return a bounded snapshot/diagnostic context.
- `browser_diagnostics`: bounded redacted console, page error, failed request, HTTP error, navigation, tab, and screenshot information.

Locator priority is snapshot reference, role/name, label, test ID, placeholder, visible text, then CSS. Inspect first, then act:

```text
Use browser_session start, then browser_navigate to https://example.com.
Call browser_snapshot before interacting. Use browser_act with its [eN] reference.
Use browser_assert for the expected outcome and browser_diagnostics if anything is unexpected.
Stop with browser_session action=stop when finished.
```

## Slash commands

- `/browser-open [url]` starts a session and optionally navigates.
- `/browser-status` reports active page, Live View, and screenshot count.
- `/browser-screenshot [label]` saves an important evidence screenshot.
- `/browser-close` closes Playwright resources, releases the Browserbase session, and reports saved screenshots.

`/reload` is Pi's built-in extension reload command.

## Screenshots and manifests

Each run creates:

```text
screenshots/browserbase/run-YYYYMMDDHHMMSS-xxxxx/
├── 01-navigation-YYYYMMDDHHMMSS.png
├── 02-before-click-YYYYMMDDHHMMSS.png
├── 03-after-click-YYYYMMDDHHMMSS.png
└── manifest.json
```

Generated runs are ignored by Git. The manifest records sequence, filename, repository-relative and absolute paths, capture time, sanitized URL/title, viewport, reason, related action, status, Browserbase session ID, inspector URL, and dimensions when available. It never records the CDP connect URL, cookies, headers, credentials, or entered form values. Tool output includes the descriptive name, purpose, absolute path, repository path, status, and manifest path. Include those paths and Markdown links in final task responses.

## Live View and cleanup

`browser_session` returns Browserbase's debugger Live View URL and the Session Inspector URL. Open Live View to watch or take control when the URL is valid. URLs are obtained from the SDK and are not persisted in the manifest. Browser minutes continue while a session remains alive, especially with keep-alive enabled, so stop sessions promptly. `/browser-close`, `browser_session stop`, `/reload`, and `session_shutdown` all attempt cleanup; repeated cleanup is harmless.

## Safety and limitations

- No arbitrary JavaScript evaluation tool is exposed.
- The extension does not bypass CAPTCHAs/access controls or submit purchases, destructive changes, or irreversible actions automatically.
- Navigate only to URLs requested by the user or required by the requested UI flow.
- Credentials, tokens, signed URLs, authorization headers, cookies, and sensitive form values are redacted from diagnostics and snapshots. Password values are never returned.
- Browserbase cloud browsers generally cannot reach a developer's `localhost`, `127.0.0.1`, or `::1`. Use a supported Browserbase tunnel or a publicly reachable preview URL.
- URL query strings and fragments are omitted from displayed diagnostics to avoid leaking tokens; assertions still compare the real URL internally.

## Example requests

- “Open this URL, inspect the page, and show me a screenshot.”
- “Test the login form and save screenshots of each important state; do not expose credentials.”
- “Check the mobile layout at 390×844 and reference the screenshots in your response.”
- “Run this checkout flow until the final confirmation step, but do not submit payment.”
- “Diagnose this UI failure and include console errors and screenshot evidence.”

Example test flow:

```text
Start a Browserbase session with viewport 390x844. Navigate to https://example.com.
Take an initial screenshot named mobile-initial. Snapshot the page.
Assert that the title contains “Example Domain”.
If anything fails, use browser_diagnostics and keep the evidence screenshot path.
Stop the session and report the screenshot run directory and manifest.
```

## Troubleshooting

- **Missing API key:** export `BROWSERBASE_API_KEY` in the same environment that launches Pi, then `/reload`.
- **Project error:** omit `BROWSERBASE_PROJECT_ID` to let Browserbase infer it, or set the project ID from Browserbase settings.
- **Connection/session limit:** stop stale sessions in Browserbase, lower concurrency, and check the project plan.
- **Navigation timeout:** verify the URL is publicly reachable, increase the tool timeout, or inspect `browser_diagnostics`.
- **No matching element:** call `browser_snapshot`; use its stable ref or a role/name, label, test ID, or placeholder. Ambiguous matches are intentionally rejected.
- **Screenshot failure:** confirm the repository is writable and inspect the manifest directory. Element screenshots require exactly one matching element.
- **Local app unavailable:** configure a Browserbase-compatible tunnel or deploy a reachable preview; cloud browsers cannot ordinarily access local machine addresses.
- **Extension not visible:** trust the project, confirm the path is `.pi/extensions/browserbase/index.ts`, run `/reload`, and run `npm run check` in this directory.

Optional paid smoke test (run once, only when safe):

```bash
BROWSERBASE_API_KEY='…' npm run test:integration
```

It opens `https://example.com`, checks the title, writes success evidence and a manifest under `screenshots/browserbase/`, and releases the session. It is skipped when the key is absent.
