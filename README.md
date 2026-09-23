# VSCodium MCP Server

Turn VS Code into a local MCP server: 88 tools that let AI coding assistants explore and edit your workspace, run terminal commands, work with git, read scanned PDFs, test APIs and databases, audit frontend code, and remember context between sessions. Everything runs on localhost over the streamable HTTP API.

This project began as a fork of [juehang/vscode-mcp-server](https://github.com/juehang/vscode-mcp-server) by Juehang Qin, built on his 0.4.0 codebase with his git history intact. His original 12 tools are still here; the other 73 came later. Credit for the core idea and the first implementation belongs to him.

## Demo

https://github.com/user-attachments/assets/f60da97b-a5a9-45cb-8379-3bf91c9bbad0

## Quick start

1. Install the extension from a `.vsix` (Extensions view → `⋯` → *Install from VSIX*), or build it yourself with `npm install && npm run compile`.
2. Click the status bar item to start the server.
3. Point your MCP client at `http://localhost:3400/mcp`.

### Claude Desktop

```json
{
  "mcpServers": {
    "vscode-mcp-server": {
        "command": "npx",
        "args": ["mcp-remote@next", "http://localhost:3400/mcp"]
    }
  }
}
```

Clients that speak streamable HTTP directly can skip `mcp-remote` and use the URL as-is.

### The agent guide

Tell your agent to call `session_bootstrap_code` once at the start of every conversation. The tool is read-only and auto-approved, and ONE call returns everything needed to work: persistent memory, the workspace layout, the skills list and the full agent guide — all 88 tools with their key parameters, grouped by task, tagged `[RO]`/`[MUT]`/`[DST]` to match the approval behavior, plus workflow rules (tool-budget discipline, diagnostics after every edit batch, secret scan before commits) and recipes for common jobs. An agent that loads it stops discovering tools by trial and error, which is where most wasted tool calls go.

Paste this into the agent's instructions (project instructions in Claude, `CLAUDE.md`, or your agent's persistent memory):

```
At the start of every conversation, call get_agent_instructions_code (read-only,
auto-approved). It returns the complete tool catalog with parameters; follow it.
If memory tools are available, call memory_load_code right after.
```

You can replace the built-in guide with your own text through the `vscode-mcp-server.agentInstructions` setting, or copy it with the **MCP Server: Copy Agent Instructions** command if your client cannot call tools at all.

## What the tools do

Every group in the table maps to a key in the `vscode-mcp-server.enabledTools` setting and can be turned off individually. Useful when your coding agent already has some of these abilities: disable file/edit and keep only symbol tools, for example. Five tools are always on regardless of the setting: `session_bootstrap_code`, `search_workspace_code`, `retrieve_output_code`, `get_agent_instructions_code` and a coffee easter egg.

### Read-only tools run without approval

51 of the 88 tools carry the MCP `readOnlyHint` annotation: file reads, search, symbol lookup, diagnostics, git blame/diff/history, secret scanning, static analyzers, the PDF checks. Clients that honor annotations auto-approve them, so a plain read never sits behind a confirmation dialog. The classification is deliberately conservative: 26 tools that modify files or state and 10 destructive tools (shell, SQL, stashes, file moves) keep their prompts. Nothing is marked read-only if it can execute, erase, or reach the network.

### Multiple workspace folders

Every tool that takes a path or a working directory also accepts an optional `workspace` parameter: an open folder's name (case-insensitive) or its 1-based position in the window. Relative paths resolve against that folder; leave the parameter out and the first folder is used, so single-folder setups behave exactly as before. A folder literally named "2" is matched by name before the number 2 means anything. `list_workspace_folders_code` prints the numbering to quote back.

Paths round-trip in both directions: results are displayed as `FolderName/relative/path` when several folders are open, and that same form is accepted as input, as are absolute paths, so an output of one tool can be fed to the next without re-deriving which root it lives in.

### Several VS Code windows, one server

Windows do not fight over the port: the first one to start serves `http://localhost:3400/mcp` exactly as before, and every other VS Code window joins it automatically. There is still one client URL to configure, no matter how many windows are open. Each joined window registers its open folders with the hosting window, which forwards every tool call to whichever window owns the target folder. Folder names, deduped labels (`proj-beta-2` when two windows open same-named folders) and the 1-based indexes all span the whole cluster; `list_workspace_folders_code` shows the global numbering and names the window behind each folder, and whole-workspace diagnostics or symbol searches fan out to every window at once. The status bar reads `MCP Server: 3400 (joined)` on a window sharing another's server. Close the hosting window and the remaining ones elect a new host within seconds, so the client URL never changes.

| Group | Tools | Covers |
|---|---|---|
| File | 6 | list, read (paged, truncated gracefully), move, rename, copy, open-folder inventory |
| Edit | 3 | create files, replace line ranges with validation, dry-run diff previews |
| Diagnostics | 1 | errors/warnings from the Problems panel |
| Symbol | 6 | fuzzy search, hover definitions, document outlines, call graph, test impact, migration diff |
| Shell | 2 | terminal execution with compact output and full-output recall, detached background tasks |
| Memory | 4 | persistent global and per-project notes |
| Test | 5 | run tests, coverage, formatting, linting, diffs |
| Git | 5 | commits, branches, blame, conflicts, stashes |
| Documentation | 5 | dependencies, file history, docstrings, project context, TODOs |
| Database | 5 | SQL, HTTP endpoints, env vars, ports, dev servers |
| Productivity | 6 | dead code, snapshots, checkpoints, regex testing, encodings, calendar extraction |
| Security | 7 | secret scanning, risky constructs, dependency audit, audit log, exposure view, scoped keys, key rotation |
| Performance | 3 | bundle sizes, server report, command profiling |
| Refactoring | 4 | rename symbol, extract function, duplicates, suggestions |
| Frontend | 4 | accessibility, CSS quality, element inspection, unused CSS |
| Workflow | 5 | npm/composer/Makefile tasks, project build, snippets, shell aliases, plan mode |
| Advanced | 2 | server info, installed extensions |
| Skills | 4 | agent skills: list, validate, create, package |
| OCR | 3 | scanned PDFs: needs-OCR check, page rendering, text extraction |

80 tools across those 19 groups, plus 5 always-on tools (session bootstrap, search, output recall, agent guide, coffee) for 85 total.

## Tool reference

Optional parameters are listed with their defaults.

### File tools
- **list_files_code**: lists files and directories. Params: `path`, `recursive` (default false; never recursive on the root, the output is huge).
- **read_file_code**: reads file contents. Params: `path`, `encoding` (default utf-8, or base64), `maxCharacters` (default 100000; 0 disables the limit), `startLine`/`endLine` (1-based, inclusive). Text above `maxCharacters` comes back truncated with a note giving the full size, so page through with `startLine`/`endLine` instead of retrying blind.
- **list_workspace_folders_code**: lists every folder open in the window as `1. Name -> path`, the same numbering the `workspace` parameter accepts.
- **move_file_code**: moves a file or directory through WorkspaceEdit. Params: `sourcePath`, `targetPath`, `overwrite` (default false).
- **rename_file_code**: renames a file or directory. Params: `filePath`, `newName`, `overwrite` (default false).
- **copy_file_code**: copies a file. Params: `sourcePath`, `targetPath`, `overwrite` (default false).

### Edit tools
- **create_file_code**: creates a file or rewrites an existing one completely. Params: `path`, `content`, `overwrite` (default false), `ignoreIfExists` (default false).
- **replace_lines_code**: replaces a line range, validating against the original text. Params: `path`, `startLine`, `endLine`, `content`, `originalCode`.
- **diff_preview_code** (read-only): dry-run of the edit tools above and of move/rename — returns the unified diff that would be written without touching anything, and ends with the exact call to apply it. Params: `op` (`replace_lines`, `create`, `move`, `rename`) plus the same parameters the matching tool takes.

### Search (always on)
- **search_workspace_code**: regex search across the workspace, matches grouped by file with 1-based line numbers. Params: `pattern`, `path` (default `.`), `glob` (a pattern without `/` like `*.ts` matches the file name at any depth, `src/**/*.py` matches relative paths), `caseSensitive`, `maxResults` (default 50, max 200), `skipCommon` (default true: node_modules, dist, out, build, dot-directories). Binary files and files over 1.5 MB are skipped. This replaces grep-through-shell for simple reads: strictly read-only, auto-approved, no terminal involved.

### Diagnostics
- **get_diagnostics_code**: lists errors and warnings. Params: `path` (optional; whole workspace if omitted), `severities` (default [0, 1]), `format` ('text' or 'json'), `includeSource` (default true). Run it after every round of changes. With several folders open, reported paths carry the owning folder's name as a prefix.

### Symbols
- **search_symbols_code**: fuzzy search across every open folder at once (VS Code providers span all roots). Params: `query`, `maxResults` (default 10). Results carry the owning folder's name in their location when several folders are open.
- **get_symbol_definition_code**: hover data for a symbol: type, docs, source. Params: `path`, `line`, `symbol`.
- **get_document_symbols_code**: hierarchical outline of a file. Params: `path`, `maxDepth`.
- **call_graph_code**: who calls a symbol and what it calls, with configurable depth and direction, served by the `.codegraph/` workspace index (built on first use, then incremental; delete the folder to force a rebuild). Heuristic and name-based: same-named symbols merge, dynamic dispatch is not resolved. Params: `symbol`, `depth` (default 3), `direction` (`callees`, `callers`, `both`), `maxNodes`.
- **test_impact_code**: changed source files mapped to the test files that transitively import them. Defaults to the git working-tree changes. Params: `files` (optional list).
- **migration_diff_code**: two revisions compared — changed files, declarations added, BREAKING declarations removed, renames flagged. Params: `base`, `head` (default HEAD).

### Shell
- **execute_shell_command_code**: runs a command in the integrated terminal through shell integration and captures real output plus exit code. Commands on the same terminal run one after another, never interleaved. Params: `command`, `cwd`, `timeout` ms (default 10000), `outputMode` (`compact` by default: transport logs, test runners, package managers and build output come back filtered to the lines that matter; `raw` disables filtering). A command past its limit returns the output captured so far with exit code 124; the process keeps running in the terminal, so slow scans need a larger timeout passed explicitly. When compact output ends with a `[@vscode-mcp ... retrieve_output_code "handle"]` notice, the full unfiltered text is one call away.
- **retrieve_output_code** (always on): recalls the full original output behind a compaction notice, paginated. Params: `handle`, `offset` (default 0), `maxChars` (default 20000).
- **background_task_code**: runs long commands detached and returns a task id immediately; poll `output`, `list` tasks, `kill` a run. Nothing gets truncated by the 10 s terminal timeout. Params: `action` (`start`, `list`, `output`, `kill`), `command`, `cwd`, `task_id`, `offset`, `maxChars`.

### Memory and session state
Three files, three jobs. The split is what keeps context small: memory accumulates, state is overwritten, the log is budgeted.

| File | What it holds | Growth |
| --- | --- | --- |
| `~/Mammouth/MEMORY.md` | user preferences, project rules, durable decisions | hand-curated |
| `{workspace}_STATE.md` | current version, branch, status, in-progress work, next step | overwritten, ~2 KB |
| `{workspace}_LOG.md` | dated session history: files touched, commands run, summaries | rotates at 40 entries |

- **memory_load_code**: loads memory plus the state snapshot. Trimmed to a budget by default; pass `full=true` for verbatim. Params: `full`, `workspace`.
- **memory_save_code**: appends a dated entry under a section header. Params: `section`, `entry`, `scope` (global/project), `sectionLevel`.
- **memory_search_code**: keyword search. Params: `query`, `scope`.
- **memory_clear_code**: removes an entry or a whole section. Params: `section`, `entry`, `scope`.
- **workspace_state_code**: reads or overwrites the state snapshot. Params: `action` ('read'/'write'), `version`, `branch`, `status`, `inProgress`, `nextStep`.
- **session_end_code**: closes a unit of work — writes the state snapshot and appends a dated summary. Call it as the last tool call of a finished, handed-off or abandoned task. Params: `summary`, `version`, `branch`, `status`, `inProgress`, `nextStep`.
- **workspace_log_code**: recent session history when the snapshot is not detailed enough. Params: `count`.

The server also journals tool activity on its own: any call carrying a path, command or query lands in the log without a model round-trip. `session_bootstrap_code` returns the state in full, memory within a budget, and only the newest log entries.

### Testing
Frameworks auto-detect from `package.json`, `requirements.txt` or `pyproject.toml`.

- **run_tests_code**: runs vitest/jest/pytest/mocha/playwright/cypress. Params: `pattern`, `framework`, `args`, `cwd`.
- **get_test_coverage_code**: coverage via vitest/jest/pytest. Params: `path`, `format` ('text'|'json'|'lcov'|'html'), `framework`.
- **format_document_code**: prettier/black/ruff/rustfmt/gofmt. Params: `path`, `formatter`, `checkOnly`.
- **lint_and_fix_code**: eslint/ruff/flake8/pylint, optionally fixing. Params: `path`, `linter`, `fix`.
- **get_git_diff_code**: staged/unstaged diffs. Params: `path`, `staged`, `noColor`.

### Git
- **commit_changes_code**: stages and commits with an auto-generated conventional message. Params: `message`, `addAll`, `amend`, `noVerify`.
- **create_branch_code**: creates, switches or lists branches (names are slugified). Params: `name`, `from`, `checkout`, `listOnly`.
- **get_blame_code**: line-by-line authorship. Params: `path`, `startLine`, `endLine`, `format`.
- **list_conflicts_code**: files with merge conflict markers.
- **stash_changes_code**: push/pop/list/drop/apply/show. Params: `action`, `message`, `index`, `includeUntracked`.

### Documentation
- **get_package_dependencies_code**: npm, pip/poetry/pipenv, cargo, go, composer, bundler. Params: `ecosystem`, `includeOutdated`.
- **get_file_history_code**: git history with filters and optional diffs. Params: `path`, `maxCommits`, `since`, `until`, `author`, `grep`, `includeStats`, `includeDiff`, `format`.
- **generate_docstring_code**: JSDoc/docstring/PHPDoc/GoDoc/Rustdoc, inserted into the file. Params: `path`, `symbol`, `line`, `style`, `includeTypes`, `includeExamples`, `async`, `overwrite`.
- **get_project_context_code**: stack, structure tree, languages, frameworks, entry points, scripts, test setup. Params: `depth`, `includeDeps`, `includeScripts`, `includeConfigFiles`, `includeReadme`, `maxFileSize`.
- **find_todo_code**: TODO/FIXME/HACK/XXX/NOTE/BUG/OPTIMIZE/REVIEW comments with severity classification. Params: `customPatterns`, `path`, `include`, `exclude`, `caseSensitive`, `contextLines`, `format`, `groupBy`.

### Developer productivity / databases
- **run_sql_query_code**: SQL against local PostgreSQL/MySQL/SQLite. Params: `query`, `database`, `connectionString`, `databaseName`, `filePath`, `format`, `timeout`.
- **test_api_endpoint_code**: sends requests and reports status/response details. Params: `url`, `method`, `headers`, `body`, `timeout`, `followRedirects`, `validateStatus`.
- **check_env_vars_code**: missing, unused or duplicate variables in `.env`. Params: `checkCodeUsage`, `envFiles`, `ignorePatterns`.
- **get_open_ports_code**: processes listening locally. Params: `port`, `protocol`, `state`.
- **restart_dev_server_code**: restarts Vite, Next.js, Webpack, Nodemon and friends. Params: `script`, `command`, `cwd`, `port`, `killTimeout`, `startupTimeout`.

### AI productivity
- **find_dead_code_code**: exported symbols nothing references. Params: `path`, `include`, `exclude`, `maxResults`.
- **snapshot_workspace_code**: SHA-256 snapshots of every file with before/after compare. Params: `action` (save/compare/list), `name`, `baseline`.
- **checkpoint_code**: one-call undo point backed by a non-destructive git stash: `save` records the current tracked changes and lets you keep working, `restore` rolls the tree back (kept, requires `confirm`), `list`/`drop` manage them. Params: `action` (save/list/restore/drop), `name`, `confirm`.
- **regex_tester_code**: matches with positions, captured groups and a replace preview. Params: `pattern`, `flags`, `text`, `filePath`, `replace`.
- **convert_encoding_code**: detects and converts utf-8, utf-8-bom, utf-16le, latin1. Params: `path`, `action`, `from`, `to`.
- **generate_ics_code**: pulls events out of a document into an .ics calendar file. Params: `path`, `output`, `calendarName`, `keywords`, `requireKeyword`, `year`.

### Security
- **find_secrets_code**: hardcoded AWS keys, GitHub/Slack tokens, Google API keys, Stripe live keys, private key blocks, JWTs and generic credential assignments. Values come back masked and obvious placeholders are ignored. Params: `path`, `exclude`, `maxResults`.
- **security_scan_code**: risky constructs rated by severity: eval/new Function, innerHTML sinks, exec calls with interpolated input, disabled TLS verification, unsafe yaml/pickle/subprocess, SQL string concatenation. Params: `path`, `severity` floor, `maxResults`.
- **check_dependencies_vulnerabilities_code**: npm audit results per package with patched versions. Params: `workspace`.
- **get_audit_log_code**: recent tool calls, denied tools, blocked shell commands, sandbox violations, consent grants and token revocations. Params: `limit`, `kind`.
- **expose_audit_code**: aggregated exposure view — clients with their tool counts, denied/blocked events, and the current rate-limit window with the top source IPs. Params: `last`, `topTools`.
- **scope_keys_code**: mint, list and revoke scoped api keys (`mcpk_ro_` / `mcpk_std_` / `mcpk_full_`). A read-only key cannot run shell commands, edit files or query databases; administration is never included, so remote clients never need the primary key. Params: `action`, `scope`, `label`, `key_id`.
- **secret_rotate_code**: regenerates the primary api key and invalidates the old one immediately, one audited call. Params: `confirm`.

### Performance
- **analyze_bundle_code**: build output sizes with the largest files and their share. Params: `dir` (default dist), `top`.
- **get_performance_report_code**: server uptime and memory, workspace weight, heaviest npm packages.
- **profile_command_code**: wall-clock timing of a command over repeated runs, alongside its output. Params: `command`, `runs`.

### Refactoring
- **rename_symbol_code**: word-boundary rename across every code file (JS/TS family, Python, PHP), so `calc` never touches `calcTotal`; dry-run previews first. Params: `oldName`, `newName`, `dryRun`, `exclude`.
- **extract_function_code**: pulls a line range into a new function and replaces it with a call. Params: `path`, `startLine`, `endLine`, `functionName`, `params`.
- **find_duplicate_code_code**: normalised sliding-window duplicate blocks with every location. Params: `path`, `minLines` (default 5), `exclude`.
- **suggest_refactoring_code**: flags functions worth another look with body length, parameter count, approximate complexity and nesting depth. Static analysis, nothing executes. Params: `path`, `maxLines`, `maxParams`, `maxComplexity`.

### Frontend
- **audit_accessibility_code**: missing alt text, unlabeled inputs, positive tabindex, clickable div/span, empty links, missing lang. Params: `path`, `exclude`.
- **analyze_css_code**: duplicate selectors, properties repeated inside one rule, empty rule blocks, heavy `!important` use. Params: `path`.
- **inspect_element_code**: markup usages plus every CSS rule styling a selector (.class, #id or tag). Params: `selector`, `path`.
- **find_unused_css_code**: stylesheet classes and ids nothing references anywhere; quoted strings count as usage, so dynamically composed names rarely false-positive. Params: `path`.

### Workflow

Project tasks, builds, editor snippets and shared shell shortcuts, discovered from files the project already has. Nothing to configure.

- **run_task_code**: lists or runs tasks from package.json scripts, composer.json scripts and Makefile targets, each through its own runner (`npm run`, `composer run-script`, `make`). When one name exists in several sources, qualify it (`make:build`). Params: `task`, `args`, `cwd` (tasks are discovered where you point), `timeout` ms (default 120000). Call it without `task` to list what exists.
- **build_project_code**: detects the build command (package.json build script, Makefile, tsconfig.json) and runs it with a duration and exit code report. Params: `command` to override detection, `cwd`, `timeout` ms (default 300000).
- **list_snippets_code**: lists snippets with a body preview, from `.vscode/snippets/*.json`, `.vscode/snippets/*.code-snippets` and the `.vscode/*.code-snippets` files VS Code itself creates; comment lines are tolerated. Params: `prefixFilter`.
- **run_alias_code**: runs shortcuts from `.mcp-aliases.json` at the workspace root, so a whole team shares one set of commands; values are plain command strings or `{ command, description }`. Params: `name`, `args`, `cwd`, `timeout`.
- **plan_mode_code**: a global planning switch — while on, every execution tool only describes what it would run, nothing executes; read-only tools keep working. Params: `enabled`, `status`.

### Skills

Agent skills are folders carrying a SKILL.md with YAML frontmatter. The server can inventory, lint, scaffold and package them.

- **list_skills_code**: recursively finds every SKILL.md under a root folder and reads its frontmatter (name, description). Params: `root`.
- **validate_skill_code**: checks one SKILL.md: frontmatter completeness, balanced code fences, referenced sibling files exist next to it, non-executing syntax check of embedded JavaScript blocks. Params: `path`.
- **create_skill_code**: scaffolds `<root>/<slug>/SKILL.md` with valid frontmatter and a section skeleton. Params: `name`, `description`, `root`, `overwrite`.
- **package_skill_code**: zips a skill folder through the system `zip` command, ready to share. Params: `skillPath`, `outputPath`, `exclude`.

### PDF and OCR

Reading scanned documents runs entirely on your machine: for every engine, no page content leaves it.

- **pdf_needs_ocr_code**: decide first. Checks whether a PDF already has an extractable text layer or is (fully or partly) image-only. Params: `pdfPath`, `minCharsPerPage`.
- **render_pdf_pages_code**: rasterizes pages to images returned in the tool result, so whichever vision-capable model drives the conversation reads them itself. Params: `pdfPath`, `firstPage`, `lastPage`, `dpi`.
- **ocr_pdf_code**: extracts text from a scanned PDF. Engines: `tesseract` (local binary; common Windows install paths are probed, including `%LOCALAPPDATA%\Programs\Tesseract-OCR`), `vision` (a local Ollama vision model), or `auto`. Page ranges are supported; long jobs run the passes under a shared deadline (`timeoutMs`) and come back with partial results and a note saying which pages were skipped instead of failing whole. Params: `pdfPath`, `engine` (default tesseract), `language` (default eng, combos like `fra+eng`), `firstPage`, `lastPage`, `dpi`, `ollamaUrl`, `visionModel`, `outputPath` (full text also written to disk), `timeoutMs`.

### Agent guide and housekeeping (always on)
- **session_bootstrap_code**: one-call session start — memory, workspace layout, skills and the complete 85-tool catalog in a single response, described in the agent guide section above.
- **brew_coffee_code**: brews nothing. Params: `sugar`.

## Configuration

* `vscode-mcp-server.port`: server port (default 3400)
* `vscode-mcp-server.host`: bind address (default 127.0.0.1)
* `vscode-mcp-server.defaultEnabled`: start the server automatically on launch
* `vscode-mcp-server.enabledTools`: which of the 19 groups above are active, all on by default. Changing it restarts the server.
* `vscode-mcp-server.auth.mode`: how clients authenticate: `session-token` (default), `static-token`, `api-key`, `oauth` or `none` (unsafe). See Security below.
* `vscode-mcp-server.auth.staticToken`: the secret required when mode is `static-token`.
* `vscode-mcp-server.auth.apiKey`: the key required when mode is `api-key`. Left empty, a key is generated on first activation and stored in VS Code SecretStorage.
* `vscode-mcp-server.auth.allowedOrigins`: extra Origins allowed besides the server itself (tunneled remote clients).
* `vscode-mcp-server.auth.allowNoOrigin`: accept Origin-less requests (curl, SDK clients). On by default; browsers always send Origin so drive-by protection is unaffected.
* `vscode-mcp-server.agentInstructions`: replaces the built-in text returned by `get_agent_instructions_code` and copied by **MCP Server: Copy Agent Instructions**. Empty means the built-in guide.
* `vscode-mcp-server.security.sandbox.mode`: filesystem confinement for authenticated tools. `workspace` (default): only folders open in this window plus `allowPaths`. `home`: the user profile directory. `full`: no restriction, dangerous with remote clients.
* `vscode-mcp-server.security.sandbox.allowPaths`: extra absolute paths allowed in `workspace` mode (e.g. `D:\docs`); symlinks pointing outside are refused.

Each request gets its own stateless MCP session, so one slow or hung call never blocks the others.

## Security

Every call to the endpoint carries a credential. On first start a random token is generated and shown once in a notification with a copy button; you can retrieve it any time through `get_server_info_code` (the Auth line) or the **MCP Server: Copy access token** command. Clients send it on every request as `Authorization: Bearer ***` or `X-MCP-Token`, and requests without it get a 401 before any tool executes.

Cross-origin browser requests are rejected with 403 outright, so visiting a hostile page cannot silently reach your files even with the port number known.

Four modes under `vscode-mcp-server.auth.mode`:

- `session-token` (default): one random secret per installation, persisted across window reloads.
- `static-token`: you pin the secret in `auth.staticToken`; handy for scripted setups.
- `api-key`: a stable key kept in SecretStorage (or pinned via `auth.apiKey`), sent as `Authorization: Bearer <key>` or `x-api-key`. The choice for agents and automations that cannot follow an OAuth dance, especially behind a tunnel.
- `oauth`: MCP OAuth 2.1 for remote clients that require it (Mammouth today). Clients discover `/.well-known/oauth-protected-resource` and register themselves at `/register`; the authorization shows a VS Code consent dialog before any code is issued. PKCE S256 is mandatory, and issued access tokens are this installation's session secret.

One honest limit: a token proves whoever holds it may act here. It cannot prove they are an AI.

### Reaching the server from outside

The OAuth metadata always announce the origin the request actually arrived through (`Host` / `X-Forwarded-Host` header), so any front door works without configuration:

| Setup | What the user does | What the metadata announce |
|---|---|---|
| Local client only | nothing | `http://127.0.0.1:3400` |
| nginx / Caddy reverse proxy | proxy to `127.0.0.1:3400`, set `proxy_set_header Host $host;` | the proxy's public `https://domain` |
| Tailscale Funnel | `tailscale funnel 3400` | `https://machine.tailnet.ts.net` |
| cloudflared | `cloudflared tunnel --url http://localhost:3400` | the `trycloudflare.com` URL |
| ngrok | `ngrok http 3400` | the `ngrok-free.app` URL |

No tunnel-specific setting exists on purpose: run the tunnel, connect through it, and discovery reflects it. Remote clients that POST from a browser context should also have their public origin added to `vscode-mcp-server.auth.allowedOrigins`; pure server-to-server calls carry no Origin header and pass regardless.

For liveness probes (uptime monitors, `tailscale serve` checks, reverse proxies), hit the unauthenticated `GET /health`: it answers `{ok, mode, version}` before any auth check, so a 200 tells you the tunnel and the server are both up. `/favicon.ico` answers `204` so browser hits stop spamming the log with 401s.

Connecting [Mammouth](https://mammouth.ai): set `auth.mode` to `oauth`, expose the port through any of the tunnels above, then give Mammouth the public URL. It discovers the OAuth endpoints itself. Log into mammouth.ai in the same browser first; their flow bounces through their login page otherwise. Approve the VS Code consent dialog when it appears.

## Caveats

Multiple workspace folders are supported; tools pick one through the `workspace` parameter described above. Local connections only. Every VS Code window shares the one server automatically, so extra windows join the first one and there is nothing to configure per window (a foreign program squatting on the port still reports an explicit already-in-use error, and windows on different extension versions refuse to mix). Shell execution means a misbehaving *authenticated* client can run commands on your machine: keep the port closed to your network and only connect clients you trust. Inside a devcontainer, WSL or SSH remote the server listens within that environment, so forward the port or connect from a client inside the same remote.

## Credits and license

Original extension by [Juehang Qin](https://github.com/juehang/vscode-mcp-server); this fork extends his work under the same [MIT license](https://github.com/Romixof/vscode-mcp-server/blob/HEAD/LICENSE). Demo video by LTTPoseidon.
