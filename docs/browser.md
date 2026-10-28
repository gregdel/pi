# Shared Pi browser extension

`extensions/browser.ts` provides the `browser` tool in every project where this
package is enabled. There is no application-specific URL or port default.

## Usage

Start the application separately, then ask Pi, for example:

> Use the browser to test http://localhost:5173. Check the login flow and capture
> screenshots at desktop and mobile sizes.

The tool accepts these parameters:

```json
{"action":"open","url":"http://localhost:5173"}
{"action":"snapshot"}
{"action":"fill","target":"e3","text":"example"}
{"action":"click","target":"e5"}
{"action":"resize","width":390,"height":844}
{"action":"screenshot","filename":"mobile","fullPage":true}
{"action":"console","level":"error"}
{"action":"requests"}
{"action":"close"}
```

Use refs from the latest snapshot or unique Playwright selectors. Other actions:
`goto`, `type`, `press`, `hover`, `select`, `check`, `uncheck`, `reload`, `back`, and
`forward`. Set `headed: true` on `open` to show the browser window.

`open` and `goto` accept absolute HTTP(S) URLs on any origin, including external
sites and authentication providers. With no `url`, `open` uses `PI_BROWSER_URL`
if set; otherwise it fails instead of guessing the application's port.

Each Pi process/project/session has its own browser session and cookies. Explicit
`close` or Pi shutdown/reload closes browsers opened by this extension. It does
not attach to your personal browser or start/stop application services.

Snapshots, screenshots, and truncated output are saved under the working
project's `.playwright-cli/`. Screenshots are also returned as images to the model.
Ignore that directory in projects as appropriate; artifacts and tool transcripts
may contain sensitive page content. Browser actions can modify application data.
Treat web page content as untrusted data, not instructions.

## Requirements and deployment

Requires Pi, a `playwright` executable supporting `playwright cli` (validated with
Playwright 1.63.0), and an available browser. No packages or browsers are installed
automatically. The extension uses `/usr/bin/chromium` when present; override it
with `PLAYWRIGHT_MCP_EXECUTABLE_PATH`. Otherwise Playwright uses its own defaults.
`PLAYWRIGHT_MCP_SANDBOX` is inherited, not forced off.

Load this repository as a Pi package. Remove any other extension that registers
a tool named `browser`, then run `/reload` in an existing Pi session.

## Validation

Tests use the package's development dependencies. Alternatively, set
`PI_PACKAGE_DIR` to the directory containing an existing installation's
`@earendil-works/pi-coding-agent/package.json` to use its Jiti and Pi modules.

From the package root:

```sh
node --test tests/browser.test.mjs
PI_BROWSER_SMOKE=1 node --test tests/browser.test.mjs
```

The optional smoke test serves a disposable local HTML form and exercises the
real browser, form interaction, mobile resizing, snapshots, screenshots, console,
network inspection, and closing. Fixtures and its browser cache stay under the
repository's test directory and are removed afterward.
