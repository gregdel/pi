# Development

- Run `bun run test`; the script deliberately uses Node's test runner, not Bun's test runner (the tests use Node mock timers).
- Pi host modules belong in `peerDependencies` with `"*"` ranges, not runtime `dependencies`. Keep development versions pinned together; the test loader maps `pi-ai` to its `compat` entrypoint, matching Pi's extension loader.
- Tests can use an existing Pi installation via `PI_PACKAGE_DIR=/path/to/@earendil-works/pi-coding-agent`. This supplies test modules, not the package's runtime dependencies.
- The optional browser smoke test needs an existing Playwright CLI and browser. Do not install these or disable browser sandboxing to make a test pass.
