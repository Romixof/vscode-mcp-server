# VS Code MCP Server

A Visual Studio Code extension (available on the [Marketplace](https://marketplace.visualstudio.com/items?itemName=JuehangQin.vscode-mcp-server)) that allows Claude and other MCP clients to code directly in VS Code! Inspired by [Serena](https://github.com/oraios/serena), but using VS Code's built-in capabilities. This is currently far simpler than Serena, but it works! Note that this extension uses the streamable HTTP API, not the SSE API.

This extension can allow for execution of shell commands. This means that there is a potential security risk, so use with caution, and ensure that you trust the MCP client that you are using and that the port is not exposed to anything. Authentication would help, but as the MCP authentication spec is still in flux, this has not been implemented for now.

PRs are welcome!

## Demo Video
https://github.com/user-attachments/assets/20b87dfb-fc39-4710-a910-b9481dde1e90

## Installation

1. Install the extension from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=JuehangQin.vscode-mcp-server) or clone this repository and run `npm install` and `npm run compile` to build it.

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

Before running code tools that will make any modification to code, always think about your task and present a comprehensive and detailed plan to the user, including your confidence level (out of 10). When planning, use your tools to explore the codebase so that you understand the context of the project. Keep in mind that you may not be able to explore an entire codebase fully within a reasonable time, and your initial exploration should be focused on understanding the structure of the codebase. For example, you may want to fully read the directory structure of the codebase and a few key files during your initial exploration, along with relevant symbols in other files. Make sure to think hard when planning.

If you are not confident in your plan because you require more information, use your tools, such as web search, to look for this information or ask the user. Use industry-standard tools where applicable, and if simple solutions are possible with minimal compromise, they should be preferred.

Do not add try statements or extraneous error handling, especially when the error will just get raised again without modification or if the error will just be printed. Let errors happen unless there is a clear reason to handle the error that can allow the code to continue running without issue.

Do not add tests when it is not part of the task description. Instead, if you believe that it is important to create testing code, let the user make an informed decision by telling the user why you believe testing code is needed.

IMPORTANT: Only run code tools that will modify code after presenting such a plan to the user, and receiving explicit approval. Approval must be given each time; prior approval for a change does not imply that subsequent changes are approved.
```



This extension serves as a Model Context Protocol (MCP) server, exposing VS Code's filesystem and editing capabilities to MCP clients.

## Features

The VS Code MCP Server extension implements an MCP-compliant server that allows AI models and other MCP clients to:

- **List files and directories** in your VS Code workspace
- **Read file contents** with encoding support and size limits
- **Search for symbols** across your workspace
- **Get symbol definitions** and hover information by line and symbol name
- **Create new files** using VS Code's WorkspaceEdit API
- **Make line replacements** in files
- **Check for diagnostics** (errors and warnings) in your workspace
- **Execute shell commands** in the integrated terminal with shell integration
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

## Caveats/TODO

Currently, only one workspace is supported. The extension also only works locally, to avoid exposing your VS Code instance to any network you may be connected to.

## Extension Settings

This extension contributes the following settings:

* `vscode-mcp-server.port`: The port number for the MCP server (default: 3000)

## Using with MCP Clients

To connect MCP clients to this server, configure them to use:
```
http://localhost:3000/mcp
```

Remember that you need to enable the server first by clicking on the status bar item!

## Contributing

Contributions are welcome! Feel free to submit issues or pull requests.

## License

[MIT](LICENSE)
