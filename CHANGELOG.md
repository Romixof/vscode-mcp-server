# Change Log

All notable changes to the "vscode-mcp-server" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.11.0]

### Fixed

- Shell execution hardening. Terminal detection now matches shell names on word boundaries ("MCP Shell Commands" no longer reads as `sh`, which used to push POSIX syntax into PowerShell). The exit-code marker sits on its own line, so a command ending in a `#` comment can no longer swallow it and report failures as success; in PowerShell the whole template runs inside a script block with braces on their own lines — the same trailing comment can no longer eat the guard around the command either, and the helper variables stay scoped to the run instead of leaking into the session. A failed `Set-Location` skips the command instead of running it in whatever directory the terminal happened to sit in, `$LASTEXITCODE` is reset before each run so cmdlet-only commands report their real status, and working directories are single-quoted so spaces, quotes and backticks survive.
- `rename_file_code` and `move_file_code` refuse root-denoting paths like `.` instead of relocating (or trying to relocate) the workspace folder itself; the comparison folds case where the platform does (Windows, macOS).
- Scanner tools given an explicit path that does not exist (`find_secrets_code`, `security_scan_code`, `find_dead_code_code`) now fail loudly instead of scanning nothing and reporting a clean result. Targets outside every open folder are scanned and reported under their absolute path instead of being silently mangled into a wrong relative location.
- `check_env_vars_code` scans code usage inside the selected folder only — previously variables from other open folders showed up as missing or unused.
- Nested workspace folders resolve to the innermost open root for display and ownership, matching VS Code's own `getWorkspaceFolder` behavior.
- The `.vscode/extensions.json` recommendations file is size-capped on the buffer actually parsed, closing a stat/read race on the cap.

### Added

- Multi-root workspace support. Every tool that takes a path or working directory accepts an optional `workspace` parameter: an open folder's name (case-insensitive) or its 1-based position. Relative paths resolve against that folder; omitting the parameter keeps using the first folder, so single-folder setups are unchanged. Folder names win over indexes, so a folder named "1" or "2" stays reachable by name. `list_workspace_folders_code` prints the numbering. With several folders open, results referencing files — listings, diagnostics, symbol locations, scanner reports — carry the owning folder's name as a prefix, and those `FolderName/path` forms plus absolute paths are accepted back as inputs by every path-based tool — including `cwd` of shell commands and the git-backed tools (`git_blame_code`, `get_file_history_code`, `get_git_diff_code`, `format_file_code`). Files outside every open root keep absolute paths in results so they still round-trip.
- Advanced tools (2): `get_server_info_code` reports the endpoint, extension/VS Code/Node versions, platform, uptime, open folders and per-tool call counts since activation — counters kept in memory only, nothing leaves the machine — plus whether VS Code runs inside a devcontainer, WSL or SSH remote; `list_extensions_code` lists installed extensions with versions and descriptions, optionally including built-ins, or with `missingOnly` shows the `.vscode/extensions.json` recommendations that are not installed yet.
- New `vscode-mcp-server.enabledTools.advanced` setting, enabled by default.
- Remote environments are surfaced where they matter: the status bar tooltip and the toggle notification point out when VS Code runs inside a devcontainer, WSL or SSH remote and the server is only reachable from within it.

## [0.10.0]

### Added

- Refactoring tools (4): `rename_symbol_code` (word-boundary rename across the workspace with dry-run), `extract_function_code` (line range into a new function plus call site), `find_duplicate_code_code` (normalised sliding-window duplicate blocks with all locations), `suggest_refactoring_code` (body length, parameter count, complexity estimate and nesting per function).
- Frontend tools (4): `audit_accessibility_code` (missing alt/labels, positive tabindex, clickable div/span, empty links, html lang), `analyze_css_code` (duplicate selectors, repeated properties, empty rules, !important overuse), `inspect_element_code` (markup usages plus CSS rules for a selector), `find_unused_css_code` (selectors never referenced in markup or scripts).
- Workflow tools (4): `run_task_code` (lists/runs package.json, composer.json and Makefile tasks through their own runner, with source prefixes like `make:build` when a name is shared), `build_project_code` (detects the build command, overridable, timed), `list_snippets_code` (snippets from `.vscode/snippets` and `.vscode/*.code-snippets`, JSONC tolerated), `run_alias_code` (shared shortcuts from `.mcp-aliases.json` at the workspace root).
- New `vscode-mcp-server.enabledTools.refactoring`, `enabledTools.frontend` and `enabledTools.workflow` settings, enabled by default.

### Fixed

- One hung tool call no longer takes down every other request: each MCP request now gets its own stateless session (transport + tool registry) instead of queueing behind a single shared transport. Previously a shell command exceeding the client timeout starved all later requests until clients reported "Not connected".
- `read_file_code` no longer refuses oversized files: text above `maxCharacters` comes back truncated with a note giving the full size, and `startLine`/`endLine` ranges are applied before the size cap so a narrow slice of a huge file reads fine. `maxCharacters: 0` disables the limit.
- Shell commands that exceed their time limit now return the output captured so far with exit code 124 and a note, instead of failing the whole call. The reader loop still stops consuming on timeout and the terminal queue accepts the next command immediately.
- Shell integration wait raised from 1s to 5s, avoiding spurious "Shell integration not available" errors on slow terminals.

## [0.9.0]

### Added

- Security tools (3): `find_secrets_code` (AWS/GitHub/Slack/Google/Stripe keys, private key blocks, JWTs and generic credential assignments — values masked, placeholders ignored), `security_scan_code` (risky constructs: eval, innerHTML sinks, shell-injection exec, disabled TLS verification, unsafe yaml/pickle/subprocess, SQL string concatenation), `check_dependencies_vulnerabilities_code` (npm audit with per-package advisories and patched versions).
- Performance tools (3): `analyze_bundle_code` (build output sizes with largest files and their share), `get_performance_report_code` (server uptime/memory, workspace weight, heaviest npm packages), `profile_command_code` (wall-clock timing of shell commands over repeated runs).
- New `vscode-mcp-server.enabledTools.security` and `enabledTools.performance` settings, enabled by default.

## [0.8.0]

### Added

- AI productivity tools (4): `find_dead_code_code` (exported symbols never referenced elsewhere), `snapshot_workspace_code` (SHA-256 snapshots with before/after compare), `regex_tester_code` (pattern testing with groups and replace preview), `convert_encoding_code` (utf-8 / utf-8-bom / utf-16le / latin1 detect and convert).
- New `vscode-mcp-server.enabledTools.productivity` setting, enabled by default.
- Branding: new extension logo, publisher and repository now point at Romixo's GitHub, display name "VSCodium MCP Server".

## [0.7.0] - 2026-08-22

### Added

- Persistent memory tools (4): `memory_load_code`, `memory_save_code`, `memory_search_code`, `memory_clear_code` — global memory in `~/Mammouth/MEMORY.md`, per-project memory as `{workspaceName}_MEMORY.md` in the workspace root, with dated entries organized under markdown sections.
- Testing tools (5): `run_tests_code` (auto-detects vitest/jest/pytest/mocha/playwright/cypress), `get_test_coverage_code` (coverage reports for vitest/jest/pytest), `format_document_code` (prettier/black/ruff/rustfmt/gofmt with check-only mode), `lint_and_fix_code` (eslint/ruff/flake8/pylint auto-fix), `get_git_diff_code` (staged/unstaged diffs).
- Git workflow tools (5): `commit_changes_code` (auto-generated conventional commit messages), `create_branch_code` (create/switch/list branches), `get_blame_code` (line-by-line authorship), `list_conflicts_code` (merge conflict markers), `stash_changes_code` (push/pop/list/drop/apply/show).
- Documentation tools (5): `get_package_dependencies_code` (npm/pip/cargo/go/composer/bundler), `get_file_history_code` (per-file git history with stats), `generate_docstring_code` (JSDoc/docstring/PHPDoc/GoDoc/Rustdoc generation), `get_project_context_code` (stack, structure, entry points, scripts, test setup), `find_todo_code` (TODO/FIXME scanning with severity classification).
- Developer productivity / database tools (5): `run_sql_query_code`, `test_api_endpoint_code`, `check_env_vars_code`, `get_open_ports_code`, `restart_dev_server_code`.
- New `vscode-mcp-server.enabledTools` settings for each tool group (`memory`, `test`, `git`, `documentation`, `database`), all enabled by default. The server restarts automatically when the configuration changes.

### Changed

- Total tool count grows from 5 to 29.
- TypeScript source recovered for the tool groups that previously only shipped as compiled JavaScript.

### Fixed

- Server stability on Windows: concurrent MCP requests no longer corrupt the shared stateless transport (requests are now serialized server-side), which was causing `MCP error -32000: Connection closed` / `Not connected` after a long-running command.
- `GET`/`DELETE /mcp` now answer with a spec-compliant bare `405` (+ `Allow: POST`) instead of a JSON-RPC error body that clients misread as a dropped connection.
- Shell execution is PowerShell-compatible: the working-directory prefix no longer uses bash-only `&&`, commands run through VS Code shell integration with per-terminal serialization, timeouts are enforced correctly, and the real exit code is captured via an end-of-output marker instead of always reporting success.
- On Windows the extension terminal now prefers Git Bash when installed, so bash syntax (`&&`, heredocs, forward-slash paths) works out of the box; PowerShell fallback stays fully supported.
- Git tools: exit codes are detected properly (failed commands are no longer reported as success), commit/stash messages and branch sources are safely quoted, empty branch-name slugs are rejected, blame line numbers parse from the correct field, and merge-conflict detection runs `git diff --name-only --diff-filter=U` first so clean merges report "no conflicts".
- Memory tools: clearing one entry keeps its section, clearing a whole section removes only that section, and search results attribute matches to the right scope/section.
- Database tools: environment-variable scan uses glob excludes (no regex crash), MySQL connection strings parse into proper host/port/user flags, PostgreSQL JSON output wraps arbitrary queries safely, port listing filters established connections, and every tool falls back cleanly when no terminal is available.
- Test tools: pytest detection no longer depends on requirements.txt being readable, formatter/linter detection checks the file extension before probing configs, test patterns are always quoted, coverage flags match each framework (c8 for mocha, `--coverage.include` for vitest, `--collectCoverageFrom` for jest), and formatting excerpts are capped at 100 lines.
- Documentation tools: `find_todo_code` no longer silently skips every file (a global-regex capture-group bug) and honors include/exclude globs correctly; cargo/poetry/Pipfile section parsing no longer truncates at inline arrays like `features = ["derive"]`; dependency ecosystem filters map npm/pypi/cargo aliases to their data keys; docstring replacement handles single-line existing docstrings.

## [0.4.0]

- Initial release
