# Development

- Run `bun run test`; the script deliberately uses Node's test runner, not Bun's test runner (the tests use Node mock timers).
- Color assertions must select and restore terminal capabilities, initializing themes after selection. Distinct RGB shades can share a 256-color ANSI code; a palette index cannot identify the original shade.
- Type checking skips dependency declarations because Pi 1.4.0 ships declarations with missing NodeNext JSON import attributes and an obsolete `path.PlatformPath` reference.
- Pi host modules belong in `peerDependencies` with `"*"` ranges, not runtime `dependencies`. Keep development versions pinned together; the test loader maps `pi-ai` to its `compat` entrypoint, matching Pi's extension loader.
- Tests can use an existing Pi installation via `PI_PACKAGE_DIR=/path/to/@earendil-works/pi-coding-agent`.
- The optional browser smoke test needs an existing Playwright CLI and browser. Do not install these or disable browser sandboxing to make a test pass.
- Pi can report idle while awaiting `agent_settled` handlers; the owning `prompt()` promise is the settlement barrier. Submitting during those handlers defers execution but resolves the new `prompt()` promise immediately.
- Pi 1.4.0 also has a settlement race: input processing begun while streaming can finish during the previous run's `agent_settled` handlers and start an overlapping run, misattributing or suppressing subagent results. Treat this as an upstream limitation; retain steering rather than serializing all guidance as a workaround.
