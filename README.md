# VSCodium MCP Server

Turn VS Code into a local MCP server: 58 tools that let AI coding assistants explore and edit your workspace, run terminal commands, work with git, test APIs and databases, audit frontend code, and remember context between sessions. Everything runs on localhost over the streamable HTTP API.

This project began as a fork of [juehang/vscode-mcp-server](https://github.com/juehang/vscode-mcp-server) by Juehang Qin, built on his 0.4.0 codebase with his git history intact. His original 12 tools are still here; the other 46 came later. Credit for the core idea and the first implementation belongs to him.

## Demo

https://github.com/user-attachments/assets/f60da97b-a5a9-45cb-8379-3bf91c9bbad0

## Quick start

1. Install the extension from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=Romixo.vscode-mcp-server), from a `.vsix` (Extensions view → `⋯` → *Install from VSIX*), or build it yourself with `npm install && npm run compile`.
2. Click the status bar item to start the server.
3. Point your MCP client at `http://localhost:3000/mcp`.

### Claude Desktop

```json
{
  "mcpServers": {
    "vscode-mcp-server": {
        "command": "npx",
        "args": ["mcp-remote@next", "http://localhost:3000/mcp"]
    }
  }
}
```

Clients that speak streamable HTTP directly can skip `mcp-remote` and use the URL as-is.

### A prompt that works well

Drop this into your agent's instructions (project instructions in Claude, `CLAUDE.md` elsewhere):

```
You are working on an existing codebase, which you can access using your tools. These code tools interact with a VS Code workspace.

WORKFLOW ESSENTIALS:
1. Always start exploration with list_files_code on root directory (.) first
2. CRITICAL: Run get_diagnostics_code after EVERY set of code changes before completing tasks
3. For small edits (≤10 lines): use replace_lines_code with exact original content
4. For large changes, new files, or uncertain content: use create_file_code with overwrite=true

EXPLORATION STRATEGY:
- Start: list_files_code with path='.' (never recursive on root)
- Understand structure: read key files like package.json, README, main entry points
- Find symbols: use search_symbols_code for functions/classes, get_document_symbols_code for file overviews
- Before editing: read_file_code the target file to understand current content

EDITING BEST PRACTICES:
- Small modifications: replace_lines_code (requires exact original content match)
- If replace_lines_code fails: read_file_code the target lines, then retry with correct content
- Large changes: create_file_code with overwrite=true is more reliable
- After any changes: get_diagnostics_code to check for errors

APPROVAL PROCESS:
IMPORTANT: Only run code modification tools after presenting a plan and receiving explicit approval.
```

For context efficiency, agents that already read whole files benefit most from the symbol tools:

```
Use VS Code symbol tools to reduce context consumption:
- get_document_symbols_code for file structure instead of reading entire files
- search_symbols_code to find functions/classes by name across the project
- get_symbol_definition_code for type info without pulling the whole file
Workflow: outline → search → definition → read only what you need
```

## What the tools do

Every group maps to a key in the `vscode-mcp-server.enabledTools` setting and can be turned off individually. Useful when your coding agent already has some of these abilities: disable file/edit and keep only symbol tools, for example.

| Group | Tools | Covers |
|---|---|---|
| File | 5 | list, read (paged, truncated gracefully), move, rename, copy |
| Edit | 2 | create files, replace line ranges with validation |
| Diagnostics | 1 | errors/warnings from the Problems panel |
| Symbol | 3 | fuzzy search, hover definitions, document outlines |
| Shell | 1 | terminal execution with real exit codes and timeouts |
| Memory | 4 | persistent global and per-project notes |
| Test | 5 | run tests, coverage, formatting, linting, diffs |
| Git | 5 | commits, branches, blame, conflicts, stashes |
| Documentation | 5 | dependencies, file history, docstrings, project context, TODOs |
| Database | 5 | SQL, HTTP endpoints, env vars, ports, dev servers |
| Productivity | 4 | dead code, snapshots, regex testing, encodings |
| Security | 3 | secret scanning, risky constructs, dependency audit |
| Performance | 3 | bundle sizes, server report, command profiling |
| Refactoring | 4 | rename symbol, extract function, duplicates, suggestions |
| Frontend | 4 | accessibility, CSS quality, element inspection, unused CSS |
| Workflow | 4 | npm/composer/Makefile tasks, project build, snippets, shell aliases |

## Tool reference

Optional parameters are listed with their defaults.

### File tools
- **list_files_code**: lists files and directories. Params: `path`, `recursive` (default false; never recursive on the root, the output is huge).
- **read_file_code**: reads file contents. Params: `path`, `encoding` (default utf-8, or base64), `maxCharacters` (default 100000; 0 disables the limit), `startLine`/`endLine` (1-based, inclusive). Text above `maxCharacters` comes back truncated with a note giving the full size, so page through with `startLine`/`endLine` instead of retrying blind.
- **move_file_code**: moves a file or directory through WorkspaceEdit. Params: `sourcePath`, `targetPath`, `overwrite` (default false).
- **rename_file_code**: renames a file or directory. Params: `filePath`, `newName`, `overwrite` (default false).
- **copy_file_code**: copies a file. Params: `sourcePath`, `targetPath`, `overwrite` (default false).

### Edit tools
- **create_file_code**: creates a file or rewrites an existing one completely. Params: `path`, `content`, `overwrite` (default false), `ignoreIfExists` (default false).
- **replace_lines_code**: replaces a line range, validating against the original text. Params: `path`, `startLine`, `endLine`, `content`, `originalCode`.

### Diagnostics
- **get_diagnostics_code**: lists errors and warnings. Params: `path` (optional; whole workspace if omitted), `severities` (default [0, 1]), `format` ('text' or 'json'), `includeSource` (default true). Run it after every round of changes.

### Symbols
- **search_symbols_code**: fuzzy search across the workspace. Params: `query`, `maxResults` (default 10).
- **get_symbol_definition_code**: hover data for a symbol: type, docs, source. Params: `path`, `line`, `symbol`.
- **get_document_symbols_code**: hierarchical outline of a file. Params: `path`, `maxDepth`.

### Shell
- **execute_shell_command_code**: runs a command in the integrated terminal through shell integration and captures real output plus exit code. Commands on the same terminal run one after another, never interleaved. Params: `command`, `cwd`, `timeout` ms (default 10000). A command past its limit returns the output captured so far with exit code 124; the process keeps running in the terminal, so slow scans need a larger timeout passed explicitly.

### Memory
Notes live in markdown: global at `~/Mammouth/MEMORY.md`, per-project at `{workspaceName}_MEMORY.md` in the workspace root.

- **memory_load_code**: loads both scopes.
- **memory_save_code**: appends a dated entry under a section header. Params: `section`, `entry`, `scope` (global/project), `sectionLevel`.
- **memory_search_code**: keyword search. Params: `query`, `scope`.
- **memory_clear_code**: removes an entry or a whole section. Params: `section`, `entry`, `scope`.

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
- **regex_tester_code**: matches with positions, captured groups and a replace preview. Params: `pattern`, `flags`, `text`, `filePath`, `replace`.
- **convert_encoding_code**: detects and converts utf-8, utf-8-bom, utf-16le, latin1. Params: `path`, `action`, `from`, `to`.

### Security
- **find_secrets_code**: hardcoded AWS keys, GitHub/Slack tokens, Google API keys, Stripe live keys, private key blocks, JWTs and generic credential assignments. Values come back masked and obvious placeholders are ignored. Params: `path`, `exclude`, `maxResults`.
- **security_scan_code**: risky constructs rated by severity: eval/new Function, innerHTML sinks, exec calls with interpolated input, disabled TLS verification, unsafe yaml/pickle/subprocess, SQL string concatenation. Params: `path`, `severity` floor, `maxResults`.
- **check_dependencies_vulnerabilities_code**: npm audit results per package with patched versions.

### Performance
- **analyze_bundle_code**: build output sizes with the largest files and their share. Params: `dir`, `top`.
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

- **run_task_code**: lists or runs tasks from package.json scripts, composer.json scripts and Makefile targets, each through its own runner (`npm run`, `composer run-script`, `make`). Params: `task`, `args`, `cwd`, `timeout` ms (default 120000). Call it without `task` to list what exists.
- **build_project_code**: detects the build command (package.json build script, Makefile, tsconfig.json) and runs it with a duration and exit code report. Params: `command` to override detection, `cwd`, `timeout` ms (default 300000).
- **list_snippets_code**: lists snippets under .vscode/snippets with a body preview; comment lines in the JSON files are tolerated. Params: `prefixFilter`.
- **run_alias_code**: runs shortcuts from `.mcp-aliases.json` at the workspace root, so a whole team shares one set of commands; values are plain command strings or `{ command, description }`. Params: `name`, `args`, `cwd`, `timeout`.

## Configuration

* `vscode-mcp-server.port`: server port (default 3000)
* `vscode-mcp-server.host`: bind address (default 127.0.0.1)
* `vscode-mcp-server.defaultEnabled`: start the server automatically on launch
* `vscode-mcp-server.enabledTools`: which of the 16 groups above are active, all on by default. Changing it restarts the server.

Each request gets its own stateless MCP session, so one slow or hung call never blocks the others.

## Caveats

One workspace at a time, local connections only. Shell execution means a misbehaving client can run commands on your machine: keep the port closed to your network and only connect clients you trust. No authentication yet; the MCP auth spec is still moving.

## Credits and license

Original extension by [Juehang Qin](https://github.com/juehang/vscode-mcp-server); this fork extends his work under the same [MIT license](LICENSE). Demo video by LTTPoseidon.
