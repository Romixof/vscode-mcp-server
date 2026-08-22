


# VSCodium MCP Server

A Visual Studio Code extension (available on the [Marketplace](https://marketplace.visualstudio.com/items?itemName=Romixo.vscode-mcp-server)) that allows Claude and other MCP clients to code directly in VS Code! Inspired by [Serena](https://github.com/oraios/serena), but using VS Code's built-in capabilities. Perfect for extending existing coding agents like Claude Code with VS Code-specific capabilities (symbol search, document outlines) without duplicating tools they already have. Note that this extension uses the streamable HTTP API, not the SSE API.

The server currently exposes **54 tools** across **15 independently toggleable groups** (see the full catalog below).

This extension can allow for execution of shell commands. This means that there is a potential security risk, so use with caution, and ensure that you trust the MCP client that you are using and that the port is not exposed to anything. Authentication would help, but as the MCP authentication spec is still in flux, this has not been implemented for now.

PRs are welcome!

## Demo

https://github.com/user-attachments/assets/f60da97b-a5a9-45cb-8379-3bf91c9bbad0

A short presentation video is included in the extension: [`media/demo.mp4`](media/demo.mp4).

## Installation

1. Install the extension from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=Romixo.vscode-mcp-server), from a `.vsix` file (VS Code → Extensions → `⋯` → *Install from VSIX*), or clone this repository and run `npm install` and `npm run compile` to build it.

## Claude Desktop Configuration

Claude Desktop can be configured to use this extension as an MCP server. To do this, your `claude_desktop_config.json` file should look like this:
```
{
  "mcpServers": {
    "vscode-mcp-server": {
        "command": "npx",
        "args": ["mcp-remote@next", "http://localhost:3000/mcp"]
    }

  }
}
```

I also like to use this extension in a Claude project, as it allows me to specify additional instructions for Claude. I find the following prompt to work well:
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

PLANNING REQUIREMENTS:
Before making code modifications, present a comprehensive plan including:
- Confidence level (1-10) and reasoning
- Specific tools you'll use and why
- Files you'll modify and approach (small edits vs complete rewrites)
- How you'll verify the changes work (diagnostics, testing, etc.)

ERROR HANDLING:
- Let errors happen naturally - don't add unnecessary try/catch blocks
- For tool failures: follow the specific recovery guidance in each tool's description
- If uncertain about file content: use read_file_code to verify before making changes

APPROVAL PROCESS:
IMPORTANT: Only run code modification tools after presenting a plan and receiving explicit approval. Each change requires separate approval.

Do not add tests unless specifically requested. If you believe testing is important, explain why and let the user decide.
```

For context efficiency when exploring codebases, consider adding this to your CLAUDE.md:
```
## VS Code Symbol Tools for Context Efficiency
Use VS Code symbol tools to reduce context consumption:
- `get_document_symbols_code` for file structure overview instead of reading entire files
- `search_symbols_code` to find symbols by name across the project
- `get_symbol_definition_code` for type info and docs without full file context
- Workflow: get outline → search symbols → get definitions → read implementation only when needed
```



This extension serves as a Model Context Protocol (MCP) server, exposing VS Code's filesystem and editing capabilities to MCP clients.

## Features

The VS Code MCP Server extension implements an MCP-compliant server that allows AI models and other MCP clients to:

- **List files and directories** in your VS Code workspace
- **Read file contents** with encoding support, line ranges and graceful truncation of oversized files
- **Move, rename and copy files** with VS Code's WorkspaceEdit API
- **Search for symbols** across your workspace and get definitions/hover info
- **Create new files** and replace specific lines with exact-content validation
- **Check diagnostics** (errors and warnings) in your workspace
- **Execute shell commands** in the integrated terminal with real exit codes, timeouts and per-terminal serialization
- **Persist memory** across sessions (global and per-project)
- **Run tests, coverage, formatting, and linting** with automatic framework detection
- **Automate git workflows**: commit, branch, blame, conflict listing, stash, file history and diffs
- **Generate documentation**: docstrings, project context, dependency lists, TODO reports
- **Query databases, test API endpoints, inspect environment variables and ports**
- **Find dead code, snapshot workspaces, test regexes and convert encodings**
- **Scan for secrets, risky constructs and vulnerable dependencies**
- **Measure bundle sizes, server footprint and command timing**
- **Refactor**: rename symbols, extract functions, find duplicate blocks, flag refactor candidates
- **Audit frontend code**: accessibility issues, CSS quality, element inspection, unused CSS
- **Toggle the server** on and off via a status bar item

This extension enables AI assistants and other tools to interact with your VS Code workspace through the standardized MCP protocol.

## How It Works

The extension creates an MCP server that:

1. Runs locally on a configurable port (when enabled)
2. Handles MCP protocol requests via HTTP — each request gets its own stateless session, so one slow or hung tool call never blocks other requests
3. Exposes VS Code's functionality as MCP tools
4. Provides a status bar indicator showing server status, which can be clicked to toggle the server on/off

## Supported MCP Tools

Every group below maps to a key of the `vscode-mcp-server.enabledTools` setting and can be disabled individually. Optional parameters show their default.

### File Tools (`enabledTools.file`)
- **list_files_code**: Lists files and directories in the workspace. Params: `path`, `recursive` (default `false` — never use `recursive=true` on the root, the output is huge).
- **read_file_code**: Reads file contents. Params: `path`, `encoding` (default `utf-8`, or `base64`), `maxCharacters` (default `100000`; `0` disables the limit), `startLine`/`endLine` (1-based, inclusive). Text above `maxCharacters` is returned truncated with a note giving the full size — page through with `startLine`/`endLine` instead.
- **move_file_code**: Moves a file or directory via WorkspaceEdit. Params: `sourcePath`, `targetPath`, `overwrite` (default `false`).
- **rename_file_code**: Renames a file or directory via WorkspaceEdit. Params: `filePath`, `newName`, `overwrite` (default `false`).
- **copy_file_code**: Copies a file to a new location. Params: `sourcePath`, `targetPath`, `overwrite` (default `false`).

### Edit Tools (`enabledTools.edit`)
- **create_file_code**: Creates a new file or completely rewrites an existing one. Params: `path`, `content`, `overwrite` (default `false`), `ignoreIfExists` (default `false`).
- **replace_lines_code**: Replaces a line range with exact-content validation. Params: `path`, `startLine`, `endLine` (1-based, inclusive), `content`, `originalCode`.

### Diagnostics Tools (`enabledTools.diagnostics`)
- **get_diagnostics_code**: Lists errors/warnings from VS Code's Problems panel. Params: `path` (optional, whole workspace if omitted), `severities` (default `[0, 1]` = Error + Warning), `format` (`text`|`json`), `includeSource` (default `true`). Run it after every series of code changes.

### Symbol Tools (`enabledTools.symbol`)
- **search_symbols_code**: Fuzzy-searches symbols across the workspace. Params: `query`, `maxResults` (default `10`).
- **get_symbol_definition_code**: Hover data for a symbol: type, docs, source. Params: `path`, `line` (1-based), `symbol`.
- **get_document_symbols_code**: Full hierarchical outline of a file, like the Outline view. Params: `path`, `maxDepth`.

### Shell Tools (`enabledTools.shell`)
- **execute_shell_command_code**: Runs a command in the integrated terminal through shell integration, capturing real output and exit code. Commands are serialized per terminal. Params: `command`, `cwd` (default workspace root), `timeout` in ms (default `10000`). On timeout the error says so and the command may still be running in the terminal.

### Memory Tools (`enabledTools.memory`)
Persistent markdown memory: global at `~/Mammouth/MEMORY.md`, per-project at `{workspaceName}_MEMORY.md` in the workspace root.
- **memory_load_code**: Loads both scopes. No params.
- **memory_save_code**: Appends a dated entry under a section header. Params: `section`, `entry`, `scope` (`global`|`project`), `sectionLevel`.
- **memory_search_code**: Keyword search across scopes. Params: `query`, `scope`.
- **memory_clear_code**: Removes an entry or an entire section. Params: `section`, `entry`, `scope`.

### Test Tools (`enabledTools.test`)
Frameworks are auto-detected from `package.json`, `requirements.txt` or `pyproject.toml`.
- **run_tests_code**: Runs vitest/jest/pytest/mocha/playwright/cypress. Params: `pattern`, `framework`, `args`, `cwd`.
- **get_test_coverage_code**: Coverage reports via vitest/jest/pytest. Params: `path`, `format` (`text`|`json`|`lcov`|`html`), `framework`.
- **format_document_code**: Formats with prettier/black/ruff/rustfmt/gofmt. Params: `path`, `formatter`, `checkOnly`.
- **lint_and_fix_code**: eslint/ruff/flake8/pylint with optional auto-fix. Params: `path`, `linter`, `fix`.
- **get_git_diff_code**: Staged/unstaged diffs for a file or the repository. Params: `path`, `staged`, `noColor`.

### Git Tools (`enabledTools.git`)
- **commit_changes_code**: Stages and commits with an auto-generated conventional message. Params: `message` (optional), `addAll`, `amend`, `noVerify`.
- **create_branch_code**: Creates, switches to, or lists branches (names are slugified). Params: `name`, `from`, `checkout`, `listOnly`.
- **get_blame_code**: Line-by-line authorship. Params: `path`, `startLine`, `endLine`, `format` (`text`|`json`).
- **list_conflicts_code**: Lists files with merge conflict markers. No params.
- **stash_changes_code**: Manages stashes. Params: `action` (`push`|`pop`|`apply`|`list`|`drop`|`show`), `message`, `index`, `includeUntracked`.

### Documentation Tools (`enabledTools.documentation`)
- **get_package_dependencies_code**: Dependencies across npm, pip/poetry/pipenv, cargo, go modules, composer and bundler. Params: `ecosystem`, `includeOutdated`.
- **get_file_history_code**: Git history for a file with filters and optional diffs. Params: `path`, `maxCommits`, `since`, `until`, `author`, `grep`, `includeStats`, `includeDiff`, `format` (`json`|`text`|`csv`).
- **generate_docstring_code**: Generates JSDoc/docstring/PHPDoc/GoDoc/Rustdoc and inserts it. Params: `path`, `symbol`, `line`, `style`, `includeTypes`, `includeExamples`, `async`, `overwrite`.
- **get_project_context_code**: Project summary: stack, structure tree, languages, frameworks, entry points, scripts, test setup. Params: `depth`, `includeDeps`, `includeScripts`, `includeConfigFiles`, `includeReadme`, `maxFileSize`.
- **find_todo_code**: Finds TODO/FIXME/HACK/XXX/NOTE/BUG/OPTIMIZE/REVIEW comments with severity classification. Params: `customPatterns`, `path`, `include`, `exclude`, `caseSensitive`, `contextLines`, `format`, `groupBy` (`file`|`tag`).

### Developer Productivity / Database Tools (`enabledTools.database`)
- **run_sql_query_code**: SQL against local PostgreSQL/MySQL/SQLite. Params: `query`, `database`, `connectionString`, `databaseName`, `filePath`, `format`, `timeout`.
- **test_api_endpoint_code**: Sends HTTP requests and reports status/response details. Params: `url`, `method`, `headers`, `body`, `timeout`, `followRedirects`, `validateStatus`.
- **check_env_vars_code**: Checks `.env` files for missing, unused or duplicate variables. Params: `checkCodeUsage`, `envFiles`, `ignorePatterns`.
- **get_open_ports_code**: Lists processes listening on local ports. Params: `port`, `protocol`, `state`.
- **restart_dev_server_code**: Restarts common dev servers (Vite, Next.js, Webpack, Nodemon…). Params: `script`, `command`, `cwd`, `port`, `killTimeout`, `startupTimeout`.

### AI Productivity Tools (`enabledTools.productivity`)
- **find_dead_code_code**: Exported symbols never referenced elsewhere. Params: `path`, `include`, `exclude`, `maxResults`.
- **snapshot_workspace_code**: Point-in-time SHA-256 snapshots of every file, with before/after compare. Params: `action` (`save`|`compare`|`list`), `name`, `baseline`.
- **regex_tester_code**: Tests a pattern against text or a file: positions, captured groups, replace preview. Params: `pattern`, `flags`, `text`, `filePath`, `replace`.
- **convert_encoding_code**: Detects/converts utf-8, utf-8-bom, utf-16le, latin1. Params: `path`, `action`, `from`, `to`.

### Security Tools (`enabledTools.security`)
- **find_secrets_code**: Hardcoded credentials: AWS keys, GitHub/Slack tokens, Google API keys, Stripe live keys, private key blocks, JWTs, generic assignments — values masked, placeholders ignored. Params: `path`, `exclude`, `maxResults`.
- **security_scan_code**: Risky constructs with severity levels: eval/new Function, innerHTML sinks, shell-injection exec, disabled TLS verification, unsafe yaml/pickle/subprocess, SQL string concatenation. Params: `path`, `severity` floor, `maxResults`.
- **check_dependencies_vulnerabilities_code**: npm audit with per-package advisories and patched versions. No params.

### Performance Tools (`enabledTools.performance`)
- **analyze_bundle_code**: Build output sizes, largest files with their share. Params: `dir`, `top`.
- **get_performance_report_code**: Server uptime/memory, workspace weight, heaviest npm packages. No params.
- **profile_command_code**: Times a shell command over repeated runs (mean/best/worst) alongside its output. Params: `command`, `runs`.

### Refactoring Tools (`enabledTools.refactoring`)
- **rename_symbol_code**: Word-boundary rename across every code file (JS/TS family, Python, PHP), with dry-run. Params: `oldName`, `newName`, `dryRun`, `exclude`.
- **extract_function_code**: Extracts a line range into a new function and replaces it with a call. Params: `path`, `startLine`, `endLine`, `functionName`, `params`.
- **find_duplicate_code_code**: Normalised sliding-window duplicate blocks with all locations. Params: `path`, `minLines` (default `5`), `exclude`.
- **suggest_refactoring_code**: Flags long/over-parameterised/complex/deeply-nested functions with concrete numbers. Static heuristics, nothing is executed. Params: `path`, `maxLines`, `maxParams`, `maxComplexity`.

### Frontend Tools (`enabledTools.frontend`)
- **audit_accessibility_code**: Missing alt/labels, positive tabindex, clickable div/span, empty links, missing `lang`. Params: `path`, `exclude`.
- **analyze_css_code**: Duplicate selectors, properties repeated inside one rule, empty rules, heavy `!important` use. Params: `path`.
- **inspect_element_code**: Markup usages plus CSS rules for a selector (`.class`, `#id` or tag). Params: `selector`, `path`.
- **find_unused_css_code**: Classes/ids defined in stylesheets but never referenced in markup or scripts. Quoted strings count as usage, so dynamically composed names rarely false-positive. Params: `path`.

## Caveats/TODO

Currently, only one workspace is supported. The extension also only works locally, to avoid exposing your VS Code instance to any network you may be connected to.

## Extension Settings

* `vscode-mcp-server.port`: The port number for the MCP server (default: 3000)
* `vscode-mcp-server.host`: Host address for the MCP server (default: 127.0.0.1)
* `vscode-mcp-server.defaultEnabled`: Whether the MCP server should be enabled by default on VS Code startup
* `vscode-mcp-server.enabledTools`: Configure which tool categories are enabled (file, edit, shell, diagnostics, symbol, memory, test, git, documentation, database, productivity, security, performance, refactoring, frontend). All categories are enabled by default. Changing this setting restarts the server automatically.

**Selective Tool Configuration**: Useful for coding agents that already have certain capabilities. For example, with Claude Code you might disable file/edit tools and only enable symbol tools to add VS Code-specific symbol searching without tool duplication.

## Using with MCP Clients

To connect MCP clients to this server, configure them to use:
```
http://localhost:3000/mcp
```

Or if you've configured a custom host:
```
http://[your-host]:3000/mcp
```

Remember that you need to enable the server first by clicking on the status bar item!

## Contributing

Contributions are welcome! Feel free to submit issues or pull requests.

## License

[MIT](LICENSE)
