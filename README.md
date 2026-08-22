# VSCodium MCP Server

A Visual Studio Code extension (available on the [Marketplace](https://marketplace.visualstudio.com/items?itemName=Romixo.vscode-mcp-server)) that allows Claude and other MCP clients to code directly in VS Code! Inspired by [Serena](https://github.com/oraios/serena), but using VS Code's built-in capabilities. Perfect for extending existing coding agents like Claude Code with VS Code-specific capabilities (symbol search, document outlines) without duplicating tools they already have. Note that this extension uses the streamable HTTP API, not the SSE API.

This extension can allow for execution of shell commands. This means that there is a potential security risk, so use with caution, and ensure that you trust the MCP client that you are using and that the port is not exposed to anything. Authentication would help, but as the MCP authentication spec is still in flux, this has not been implemented for now.

PRs are welcome!

## Demo Video
https://github.com/user-attachments/assets/20b87dfb-fc39-4710-a910-b9481dde1e90

## Installation

1. Install the extension from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=Romixo.vscode-mcp-server) or clone this repository and run `npm install` and `npm run compile` to build it.

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
- **Read file contents** with encoding support and size limits
- **Move files and directories** with proper refactoring support for imports
- **Rename files and directories** with automatic reference updates
- **Copy files** to new locations (files only, not directories)
- **Search for symbols** across your workspace
- **Get symbol definitions** and hover information by line and symbol name
- **Create new files** using VS Code's WorkspaceEdit API
- **Make line replacements** in files
- **Check for diagnostics** (errors and warnings) in your workspace
- **Execute shell commands** in the integrated terminal with shell integration
- **Persist memory** across sessions (global and per-project)
- **Run tests, coverage, formatting, and linting** with automatic framework detection
- **Automate git workflows**: commit, branch, blame, conflict listing, stash
- **Generate documentation**: docstrings, project context, dependency lists, TODO reports
- **Query databases, test API endpoints, inspect environment variables and ports**
- **Toggle the server** on and off via a status bar item

This extension enables AI assistants and other tools to interact with your VS Code workspace through the standardized MCP protocol.

## How It Works

The extension creates an MCP server that:

1. Runs locally on a configurable port (when enabled)
2. Handles MCP protocol requests via HTTP
3. Exposes VS Code's functionality as MCP tools
4. Provides a status bar indicator showing server status, which can be clicked to toggle the server on/off

## Supported MCP Tools

### File Tools
- **list_files_code**: Lists files and directories in your workspace
  - Parameters:
    - `path`: The path to list files from
    - `recursive` (optional): Whether to list files recursively

- **read_file_code**: Reads file contents
  - Parameters:
    - `path`: The path to the file to read
    - `encoding` (optional): File encoding (default: utf-8)
    - `maxCharacters` (optional): Maximum character count (default: 100,000)

- **move_file_code**: Moves a file or directory to a new location using VS Code's WorkspaceEdit API
  - Parameters:
    - `sourcePath`: The current path of the file or directory to move
    - `targetPath`: The new path where the file or directory should be moved to
    - `overwrite` (optional): Whether to overwrite if target already exists (default: false)

- **rename_file_code**: Renames a file or directory using VS Code's WorkspaceEdit API
  - Parameters:
    - `filePath`: The current path of the file or directory to rename
    - `newName`: The new name for the file or directory
    - `overwrite` (optional): Whether to overwrite if a file with the new name already exists (default: false)

- **copy_file_code**: Copies a file to a new location using VS Code's file system API
  - Parameters:
    - `sourcePath`: The path of the file to copy
    - `targetPath`: The path where the copy should be created
    - `overwrite` (optional): Whether to overwrite if target already exists (default: false)

### Edit Tools
- **create_file_code**: Creates a new file using VS Code's WorkspaceEdit API
  - Parameters:
    - `path`: The path to the file to create
    - `content`: The content to write to the file
    - `overwrite` (optional): Whether to overwrite if the file exists (default: false)
    - `ignoreIfExists` (optional): Whether to ignore if the file exists (default: false)

- **replace_lines_code**: Replaces specific lines in a file
  - Parameters:
    - `path`: The path to the file to modify
    - `startLine`: The start line number (1-based, inclusive)
    - `endLine`: The end line number (1-based, inclusive)
    - `content`: The new content to replace the lines with
    - `originalCode`: The original code for validation

### Diagnostics Tools
- **get_diagnostics_code**: Checks for warnings and errors in your workspace
  - Parameters:
    - `path` (optional): File path to check (if not provided, checks the entire workspace)
    - `severities` (optional): Array of severity levels to include (0=Error, 1=Warning, 2=Information, 3=Hint). Default: [0, 1]
    - `format` (optional): Output format ('text' or 'json'). Default: 'text'
    - `includeSource` (optional): Whether to include the diagnostic source. Default: true

  This tool is particularly useful for:
  - Code quality checks before committing changes
  - Verifying fixes resolved all reported issues
  - Identifying problems in specific files or the entire workspace

### Symbol Tools
- **search_symbols_code**: Searches for symbols across the workspace
  - Parameters:
    - `query`: The search query for symbol names
    - `maxResults` (optional): Maximum number of results to return (default: 10)
  
  This tool is useful for:
  - Finding definitions of symbols (functions, classes, variables, etc.) across the codebase
  - Exploring project structure and organization
  - Locating specific elements by name

- **get_symbol_definition_code**: Gets definition information for a symbol in a file
  - Parameters:
    - `path`: The path to the file containing the symbol
    - `line`: The line number of the symbol
    - `symbol`: The symbol name to look for on the specified line
  
  This tool provides:
  - Type information, documentation, and source details for symbols
  - Code context showing the line where the symbol appears
  - Symbol range information
  
  It's particularly useful for:
  - Understanding what a symbol represents without navigating away
  - Checking function signatures, type definitions, or documentation
  - Quick reference for APIs or library functions

- **get_document_symbols_code**: Gets an outline of all symbols in a file, showing the hierarchical structure
  - Parameters:
    - `path`: The path to the file to analyze (relative to workspace)
    - `maxDepth` (optional): Maximum nesting depth to display
  
  This tool provides:
  - Complete symbol tree for a document (similar to VS Code's Outline view)
  - Hierarchical structure showing classes, functions, methods, variables, etc.
  - Position information and symbol kinds for each symbol
  - Summary statistics by symbol type
  
  It's particularly useful for:
  - Understanding file structure and organization at a glance
  - Getting an overview of all symbols in a document
  - Analyzing code architecture and relationships
  - Finding all symbols of specific types within a file

### Shell Tools
- **execute_shell_command_code**: Executes a shell command in the VS Code integrated terminal with shell integration
  - Parameters:
    - `command`: The shell command to execute
    - `cwd` (optional): Optional working directory for the command (default: '.')

  This tool is useful for:
  - Running CLI commands and build operations
  - Executing git commands
  - Performing any shell operations that require terminal access
  - Getting command output for analysis and further processing

### Memory Tools
Persistent markdown-based memory that survives across sessions. Global memory lives at `~/Mammouth/MEMORY.md`, project memory at `{workspaceName}_MEMORY.md` in the workspace root.

- **memory_load_code**: Loads both global and project memory
- **memory_save_code**: Saves a dated entry under a section header (`scope`: `global` or `project`)
- **memory_search_code**: Searches memory for a keyword across one or both scopes
- **memory_clear_code**: Removes a specific entry or an entire section

### Test Tools
All commands auto-detect the framework from `package.json`, `requirements.txt`, or `pyproject.toml`.

- **run_tests_code**: Runs the test suite (vitest, jest, pytest, mocha, playwright, cypress) with optional pattern filtering
- **get_test_coverage_code**: Generates coverage reports (`text`, `json`, `lcov`, `html`) via vitest/jest/pytest
- **format_document_code**: Formats a file with prettier, black, ruff, rustfmt, or gofmt; supports check-only mode
- **lint_and_fix_code**: Runs eslint, ruff, flake8, or pylint with optional auto-fix
- **get_git_diff_code**: Shows staged or unstaged diffs for a file or the whole repository

### Git Tools
- **commit_changes_code**: Stages and commits changes with an auto-generated conventional commit message (supports amend, custom messages, `--no-verify`)
- **create_branch_code**: Creates, switches to, or lists branches (names are slugified)
- **get_blame_code**: Line-by-line authorship for a file or line range (`text` or `json`)
- **list_conflicts_code**: Lists files with merge conflicts and shows the conflict markers
- **stash_changes_code**: Push/pop/list/drop/apply/show stashes

### Documentation Tools
- **get_package_dependencies_code**: Lists dependencies across npm, pip/poetry/pipenv, cargo, go modules, composer, and bundler
- **get_file_history_code**: Git commit history for a file with stats, filters (author/date/message), and optional diffs (`json`, `text`, `csv`)
- **generate_docstring_code**: Generates JSDoc, Python docstrings, PHPDoc, GoDoc, or Rustdoc for a function/class and inserts it into the file
- **get_project_context_code**: Project summary: stack, structure tree, languages, frameworks, entry points, scripts, and test setup
- **find_todo_code**: Finds TODO/FIXME/HACK/BUG comments with severity classification, grouping by file or tag

### Database / Productivity Tools
- **run_sql_query_code**: Executes SQL queries against a configured database
- **test_api_endpoint_code**: Sends requests to HTTP endpoints and reports status/response details
- **check_env_vars_code**: Verifies required environment variables against `.env` files
- **get_open_ports_code**: Lists processes listening on local ports
- **restart_dev_server_code**: Restarts the development server

## Caveats/TODO

Currently, only one workspace is supported. The extension also only works locally, to avoid exposing your VS Code instance to any network you may be connected to.

## Extension Settings

* `vscode-mcp-server.port`: The port number for the MCP server (default: 3000)
* `vscode-mcp-server.host`: Host address for the MCP server (default: 127.0.0.1)
* `vscode-mcp-server.defaultEnabled`: Whether the MCP server should be enabled by default on VS Code startup
* `vscode-mcp-server.enabledTools`: Configure which tool categories are enabled (file, edit, shell, diagnostics, symbol, memory, test, git, documentation, database). All categories are enabled by default. Changing this setting restarts the server automatically.

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
