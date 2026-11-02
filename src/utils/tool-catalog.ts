import { TOOL_HINTS, ToolHints } from './tool-annotations';

/**
 * One compact entry per tool: the exact call signature, a one-line brief and
 * a keyword bag for the lexical search. This is the RAG source of truth, so a
 * new tool gets its keywords here the same time it is registered — the
 * registry-integrity test fails until they exist.
 */
export interface ToolMeta {
        sig: string;
        brief: string;
        kw: string;
        sec: string;
}

export const CATALOG: Record<string, ToolMeta> = {
        list_workspace_folders_code: { sig: 'list_workspace_folders_code()', brief: 'list open workspace folders; source of the workspace= values', kw: 'folders workspace open roots multi-root', sec: 'files' },
        list_files_code: { sig: 'list_files_code(path, recursive, limit, offset)', brief: 'directory listing; never recursive=true on the root', kw: 'ls directory folder contents browse tree lister contenu dossier', sec: 'files' },
        read_file_code: { sig: 'read_file_code(path, startLine, endLine, maxCharacters, encoding)', brief: 'file content; use line ranges for large files', kw: 'read text content view lire contenu voir', sec: 'files' },
        search_workspace_code: { sig: 'search_workspace_code(pattern, path, glob, caseSensitive, maxResults, skipCommon)', brief: 'regex search grouped by file with line numbers; glob "*.ts" matches at any depth', kw: 'search grep find text regex pattern codebase hunt locate chercher texte', sec: 'files' },
        move_file_code: { sig: 'move_file_code(sourcePath, targetPath, overwrite)', brief: 'move a file to a new path', kw: 'move déplacer relocate file path', sec: 'files' },
        copy_file_code: { sig: 'copy_file_code(sourcePath, targetPath, overwrite)', brief: 'copy a file', kw: 'copy copier duplicate file annex', sec: 'files' },
        rename_file_code: { sig: 'rename_file_code(filePath, newName, overwrite)', brief: 'rename a file', kw: 'rename renommer file new name', sec: 'files' },
        delete_file_code: { sig: 'delete_file_code(path, recursive)', brief: 'delete a file, or a directory with recursive=true; the user approves and it goes to the trash', kw: 'delete remove rm erase trash unlink file supprimer effacer', sec: 'files' },
        convert_encoding_code: { sig: 'convert_encoding_code(path, action="detect"|"convert", from, to)', brief: 'detect or convert a file encoding', kw: 'encoding utf8 latin1 convert détecter encodage', sec: 'files' },
        snapshot_workspace_code: { sig: 'snapshot_workspace_code(action="save"|"compare", name, baseline)', brief: 'SHA-256 point-in-time snapshots of every file', kw: 'snapshot save compare checksum files compare', sec: 'files' },
        diff_preview_code: { sig: 'diff_preview_code(op, ...)', brief: 'dry-run of replace_lines/create/move/rename: prints the unified diff, applies nothing', kw: 'diff preview dry-run validate before edits', sec: 'files' },
        checkpoint_code: { sig: 'checkpoint_code(action="save"|"list"|"restore"|"drop", name, confirm)', brief: 'one-call undo point (non-destructive git stash); save before risky work, restore needs confirm=true', kw: 'undo checkpoint rollback restore revert annuler revenir undone resume changes', sec: 'files' },
        get_active_editor_code: { sig: 'get_active_editor_code()', brief: 'which file the user has open and selected right now — call before guessing a path when the user says "this"', kw: 'active editor current file selection this', sec: 'files' },
        list_open_tabs_code: { sig: 'list_open_tabs_code()', brief: 'list the editors currently open', kw: 'tabs editors pane onglets', sec: 'files' },
        get_document_symbols_code: { sig: 'get_document_symbols_code(path, maxDepth, maxItems)', brief: 'file outline, classes and functions of one file', kw: 'outline structure symbols classes aperçu plan sommaire symboles', sec: 'symbols' },
        search_symbols_code: { sig: 'search_symbols_code(query, maxResults)', brief: 'find symbols by name across the whole workspace', kw: 'find symbol locate class function name identifier déclarée déclaration', sec: 'symbols' },
        get_symbol_definition_code: { sig: 'get_symbol_definition_code(path, line, symbol)', brief: 'definition and type info at a position', kw: 'definition def defined type symbol goto déclarée définie function', sec: 'symbols' },
        call_graph_code: { sig: 'call_graph_code(symbol, depth=3, direction="callees"|"callers")', brief: 'who calls it / what it calls, via the .codegraph/ index', kw: 'call calls callees callers graph appelants appelle dependencies callers-graph', sec: 'symbols' },
        test_impact_code: { sig: 'test_impact_code(files)', brief: 'changed files -> tests that transitively import them (defaults to git changes)', kw: 'impact tests affected by change which', sec: 'symbols' },
        migration_diff_code: { sig: 'migration_diff_code(base, head="HEAD")', brief: 'two revisions: files changed, declarations added, BREAKING removals', kw: 'migration diff revisions between commits api', sec: 'symbols' },
        edit_file_code: { sig: 'edit_file_code(path, old_string, new_string, replace_all)', brief: 'THE way to change existing code: exact-text match, no stale line numbers; fails on 0 matches, lists every location on 2+ unless replace_all', kw: 'edit lancer spell change modify replace str_replace patch fix code update', sec: 'edits' },
        replace_lines_code: { sig: 'replace_lines_code(path, startLine, endLine, content, originalCode | firstLine+lastLine)', brief: 'insert, replace or delete a line range; validate with originalCode verbatim, or firstLine+lastLine (start of each end line) for long lines; omit content to delete', kw: 'insert delete remove lines replace known line insertion range block supprimer lignes', sec: 'edits' },
        create_file_code: { sig: 'create_file_code(path, content, overwrite, ignoreIfExists)', brief: 'new file or complete rewrite', kw: 'create new file write generate écrire rédiger fichier document creer nouveau', sec: 'edits' },
        rename_symbol_code: { sig: 'rename_symbol_code(oldName, newName, dryRun, exclude)', brief: 'workspace-wide symbol rename with word-boundary matching; use dryRun=true to preview', kw: 'rename symbol refactor across workspace variable', sec: 'edits' },
        extract_function_code: { sig: 'extract_function_code(path, startLine, endLine, functionName, params)', brief: 'extract a line range into a new function', kw: 'extract refactoring block extraire bloc plage refactor décomposer', sec: 'edits' },
        generate_docstring_code: { sig: 'generate_docstring_code(path, symbol, line, style)', brief: 'docstring generation', kw: 'docstring comments documentation generate', sec: 'edits' },
        format_document_code: { sig: 'format_document_code(path, formatter, checkOnly)', brief: 'format a file', kw: 'format prettier black gofmt style indent', sec: 'edits' },
        lint_and_fix_code: { sig: 'lint_and_fix_code(path, linter, fix=true)', brief: 'run the linter, optionally with auto-fix', kw: 'lint eslint ruff flake8 fix warnings style', sec: 'edits' },
        get_diagnostics_code: { sig: 'get_diagnostics_code(path, severities, format)', brief: 'VS Code problems (errors, warnings); run after every edit batch', kw: 'diagnostics errors warnings problems problems check compile fails', sec: 'diagnostics' },
        find_todo_code: { sig: 'find_todo_code(path, include, format, groupBy)', brief: 'TODO/FIXME/HACK/XXX/NOTE/BUG markers in every code file', kw: 'todo todos todolist todo-list fixme marker comments bugs tâches', sec: 'diagnostics' },
        find_dead_code_code: { sig: 'find_dead_code_code(path, maxResults)', brief: 'exported symbols never referenced anywhere', kw: 'dead unused unreferenced exports remove', sec: 'diagnostics' },
        find_duplicate_code_code: { sig: 'find_duplicate_code_code(path, minLines, exclude)', brief: 'duplicated code blocks with all locations', kw: 'duplicate repeated copied blocks', sec: 'diagnostics' },
        suggest_refactoring_code: { sig: 'suggest_refactoring_code(path, maxLines, maxParams, maxComplexity)', brief: 'long, complex or deeply nested functions with concrete numbers', kw: 'refactoring long complex complexity nesting improve', sec: 'diagnostics' },
        regex_tester_code: { sig: 'regex_tester_code(pattern, flags, text, filePath, replace)', brief: 'test a regex live', kw: 'regex tester pattern test match', sec: 'diagnostics' },
        get_test_coverage_code: { sig: 'get_test_coverage_code(path, format, framework)', brief: 'test coverage for the project or specific files', kw: 'coverage testing percent covered', sec: 'diagnostics' },
        run_tests_code: { sig: 'run_tests_code(pattern, framework, args, cwd)', brief: 'runs tests, auto-detects vitest, jest, pytest, mocha, playwright, cypress', kw: 'run tests suite execute test validate verification executer lancer', sec: 'tests' },
        run_task_code: { sig: 'run_task_code(task, args, cwd, timeout)', brief: 'run a VS Code task; call with NO arguments first to list them', kw: 'task runner tasks npm scripts jobs', sec: 'tests' },
        build_project_code: { sig: 'build_project_code(command, cwd, timeout)', brief: 'build the project', kw: 'build compile bundle assemble webpack tsc', sec: 'tests' },
        background_task_code: { sig: 'background_task_code(action="start"|"list"|"output"|"kill", command, cwd, task_id)', brief: 'long builds/tests DETACHED, poll output later; no 10s truncation', kw: 'background long detached poll async long', sec: 'tests' },
        restart_dev_server_code: { sig: 'restart_dev_server_code(script, command, cwd, port, killTimeout, startupTimeout)', brief: 'restart the project dev server', kw: 'dev server restart serve hot reload', sec: 'tests' },
        profile_command_code: { sig: 'profile_command_code(command, runs)', brief: 'wall-clock timing statistics', kw: 'profile timing benchmark performance measure', sec: 'tests' },
        analyze_bundle_code: { sig: 'analyze_bundle_code(dir="dist", top)', brief: 'build output sizes and largest files', kw: 'bundle size output dist heaviness weight', sec: 'tests' },
        get_git_diff_code: { sig: 'get_git_diff_code(path, staged)', brief: 'git diff; with staged=true only the staged changes', kw: 'diff git changed recently modified differences modifiés changements récents delta', sec: 'git' },
        get_blame_code: { sig: 'get_blame_code(path, startLine, endLine)', brief: 'git blame line by line', kw: 'blame author who wrote', sec: 'git' },
        get_file_history_code: { sig: 'get_file_history_code(path, maxCommits, includeDiff)', brief: 'git commit history for a file', kw: 'history commits log blame historique', sec: 'git' },
        list_conflicts_code: { sig: 'list_conflicts_code()', brief: 'files with merge conflict markers', kw: 'merge conflict markers rebase', sec: 'git' },
        commit_changes_code: { sig: 'commit_changes_code(message, addAll=true, amend, noVerify)', brief: 'commit with auto-generated conventional message', kw: 'commit save git message commit', sec: 'git' },
        create_branch_code: { sig: 'create_branch_code(name, from, checkout, listOnly=true to list)', brief: 'create/switch/list git branches', kw: 'branch create checkout switch branch', sec: 'git' },
        stash_changes_code: { sig: 'stash_changes_code(action="push"|"pop"|"apply"|"list"|"show"|"drop", message, index, includeUntracked)', brief: 'git stash push/pop/apply/list/show/drop', kw: 'stash shelve temporary shelve', sec: 'git' },
        execute_shell_command_code: { sig: 'execute_shell_command_code(command, cwd, timeout, outputMode="compact")', brief: 'LAST RESORT for builds, tests, git and other mutations; never for reading or searching files; output is compacted, full text via retrieve_output_code(handle)', kw: 'shell command execute run terminal bash cmd install script', sec: 'shell' },
        retrieve_output_code: { sig: 'retrieve_output_code(handle, offset, maxChars)', brief: 'full original output behind a "[@vscode-mcp ... retrieve_output_code]" compaction notice', kw: 'retrieve full raw original output handle paged', sec: 'shell' },
        run_alias_code: { sig: 'run_alias_code(name, args)', brief: 'run a configured shell alias', kw: 'alias shortcut shell run', sec: 'shell' },
        run_sql_query_code: { sig: 'run_sql_query_code(query, database, connectionString, databaseName, filePath, format)', brief: 'SQL against a configured or file-backed database', kw: 'sql query database select insert database sqlite mysql postgres', sec: 'shell' },
        get_open_ports_code: { sig: 'get_open_ports_code(port, protocol, state)', brief: 'list listening ports', kw: 'ports netstat listening sockets', sec: 'shell' },
        check_env_vars_code: { sig: 'check_env_vars_code(checkCodeUsage, envFiles, revealValues=false)', brief: 'env vars and .env files; values redacted to a length+sha fingerprint unless revealValues=true', kw: 'env environment variables secrets dotenv', sec: 'shell' },
        get_server_info_code: { sig: 'get_server_info_code()', brief: 'server version, endpoint, auth mode, enabled tool groups, usage counters', kw: 'server status info version endpoint help state usage', sec: 'shell' },
        session_bootstrap_code: { sig: 'session_bootstrap_code(action="bootstrap"|"call", tool, args, sections, mode, workspace)', brief: 'ONE-CALL session start: memory + workspace folders + root layout + skills + this guide (compact form); action="call" is the relay that runs any other tool by name when it is not in your client list', kw: 'bootstrap start session open memory guide layout skills relay call', sec: 'memory' },
        get_agent_instructions_code: { sig: 'get_agent_instructions_code()', brief: 'the agent guide; same content as the bootstrap guide section without memory/layout/skills', kw: 'guide instructions help tools map manual how', sec: 'memory' },
        lookup_tool_code: { sig: 'lookup_tool_code(query, limit)', brief: 'targeted tool lookup: which tool fits a task like "read the PDF", "run the tests", "commit" — the compact catalog alone does not carry this', kw: 'lookup find tool which recommend for helping task recherche', sec: 'memory' },
        memory_load_code: { sig: 'memory_load_code()', brief: 'persistent memory only (when the session was opened with a partial bootstrap)', kw: 'memory load recall recall persistent', sec: 'memory' },
        memory_save_code: { sig: 'memory_save_code(section, entry, scope="global"|"project")', brief: 'append a dated memory entry; save durable facts and decisions', kw: 'memory save remember persistent store note', sec: 'memory' },
        memory_search_code: { sig: 'memory_search_code(query, scope)', brief: 'search memory by keyword', kw: 'memory search find query recall', sec: 'memory' },
        memory_clear_code: { sig: 'memory_clear_code(section, entry, scope)', brief: 'remove a memory entry or an entire wrong/outdated section', kw: 'memory clear remove erase memory delete', sec: 'memory' },
        workspace_state_code: { sig: 'workspace_state_code(action="read"|"write", version, branch, status, inProgress, nextStep)', brief: 'the CURRENT snapshot of where the work stands; overwritten, never grows; loaded by session_bootstrap_code', kw: 'state snapshot current progress standing', sec: 'memory' },
        session_end_code: { sig: 'session_end_code(summary, version, branch, status, inProgress, nextStep)', brief: 'close a work session: writes the state snapshot and appends a dated summary to the log; LAST tool call of a finished unit', kw: 'session end close finish summary stop final', sec: 'memory' },
        handoff_code: { sig: 'handoff_code(action="write"|"read", inProgress, lastTool, nextStep, status)', brief: 'partial state update at a context switch; loaded by session_bootstrap_code', kw: 'handoff pass continue next transfer resume', sec: 'memory' },
        workspace_log_code: { sig: 'workspace_log_code(count)', brief: 'recent session history with files touched and commands run', kw: 'log journal history session activity', sec: 'memory' },
        get_audit_log_code: { sig: 'get_audit_log_code(limit, kind)', brief: 'recent tool calls, denied tools, blocked commands', kw: 'audit log security events tool calls denied', sec: 'security' },
        expose_audit_code: { sig: 'expose_audit_code(last, topTools)', brief: 'clients with tool counts, denied/blocked events, rate-limit top IPs', kw: 'expose audit clients funnel scanning abuse', sec: 'security' },
        find_secrets_code: { sig: 'find_secrets_code(path, maxResults)', brief: 'hardcoded API keys, tokens, private keys; run before every commit', kw: 'secrets keys scan credentials leak api manifesto', sec: 'security' },
        security_scan_code: { sig: 'security_scan_code(path, severity, maxResults)', brief: 'eval, innerHTML sinks, SQL concatenation, shell=True, disabled TLS', kw: 'security scan risky vulnerabilities eval innerHTML sql', sec: 'security' },
        check_dependencies_vulnerabilities_code: { sig: 'check_dependencies_vulnerabilities_code()', brief: 'npm audit with severities and patched versions (uses network)', kw: 'npm audit vulnerabilities dependencies cve', sec: 'security' },
        scope_keys_code: { sig: 'scope_keys_code(action="create"|"list"|"revoke", scope="read-only"|"standard"|"full", label, key_id)', brief: 'scoped mcpk_ keys; read-only = no shell/edits/SQL, admin never included. Key shown ONCE', kw: 'scope keys admin access control token create revoke', sec: 'admin' },
        secret_rotate_code: { sig: 'secret_rotate_code(confirm=true)', brief: 'regenerate the primary API key; the old key dies immediately. After any exposure', kw: 'rotate secret key regenerate exposure leak', sec: 'admin' },
        get_project_context_code: { sig: 'get_project_context_code(depth, sections, workspace)', brief: 'stack, structure, entry points, scripts; sections=["scripts","config","readme"] picks a subset', kw: 'project context overview stack readme scripts structure', sec: 'docs' },
        get_package_dependencies_code: { sig: 'get_package_dependencies_code(ecosystem, includeOutdated)', brief: 'dependencies across npm, pip, cargo, go, composer', kw: 'dependencies packages npm pip cargo list', sec: 'docs' },
        list_extensions_code: { sig: 'list_extensions_code(filter, missingOnly)', brief: 'installed VS Code extensions or recommended-but-missing ones', kw: 'extensions installed vscode plugins list', sec: 'docs' },
        list_snippets_code: { sig: 'list_snippets_code(prefixFilter)', brief: 'user snippets', kw: 'snippets templates abbreviations', sec: 'docs' },
        generate_ics_code: { sig: 'generate_ics_code(path, output, calendarName, keywords)', brief: 'extract events into an .ics calendar file', kw: 'calendar ics ics events dates generate', sec: 'docs' },
        list_skills_code: { sig: 'list_skills_code(root)', brief: 'list agent skills (SKILL.md frontmatter); auto-detects "skills" then ".claude/skills"', kw: 'skills list available capabilities', sec: 'skills' },
        validate_skill_code: { sig: 'validate_skill_code(path)', brief: 'validate one SKILL.md', kw: 'skill validate check frontmatter', sec: 'skills' },
        create_skill_code: { sig: 'create_skill_code(name, description, root, overwrite)', brief: 'scaffold a new skill', kw: 'skill create new scaffold build', sec: 'skills' },
        package_skill_code: { sig: 'package_skill_code(skillPath, outputPath, exclude)', brief: 'zip a skill folder to share', kw: 'skill package zip share export', sec: 'skills' },
        analyze_css_code: { sig: 'analyze_css_code(path)', brief: 'duplicate selectors, repeated properties, !important abuse, empty rules', kw: 'css analyze quality selectors style', sec: 'frontend' },
        audit_accessibility_code: { sig: 'audit_accessibility_code(path)', brief: 'missing alt and labels, positive tabindex, clickable divs, empty links', kw: 'accessibility a11y audit html alt aria', sec: 'frontend' },
        find_unused_css_code: { sig: 'find_unused_css_code(path)', brief: 'selectors never used in markup or scripts', kw: 'unused css dead selectors cleanup inutilisés', sec: 'frontend' },
        inspect_element_code: { sig: 'inspect_element_code(selector, path)', brief: 'where a selector appears in markup and every CSS rule styling it', kw: 'inspect element selector html css', sec: 'frontend' },
        pdf_needs_ocr_code: { sig: 'pdf_needs_ocr_code(pdfPath, minCharsPerPage)', brief: 'decide first: existing text layer or scanned document', kw: 'pdf ocr needs decide scan', sec: 'pdf' },
        render_pdf_pages_code: { sig: 'render_pdf_pages_code(pdfPath, firstPage, lastPage, dpi)', brief: 'page images the vision model reads directly', kw: 'pdf render pages images vision rasterize view', sec: 'pdf' },
        ocr_pdf_code: { sig: 'ocr_pdf_code(pdfPath, engine="auto"|"tesseract"|"vision", language, firstPage, lastPage, outputPath, timeoutMs)', brief: 'extracted text; auto returns an existing text layer directly', kw: 'ocr pdf text extract read scanned', sec: 'pdf' },
        test_api_endpoint_code: { sig: 'test_api_endpoint_code(url, method, headers, body, timeout, validateStatus, allowPrivateNetwork=false)', brief: 'live HTTP checks; private/metadata IPs blocked unless allowPrivateNetwork=true; body capped at 1 MB', kw: 'http api endpoint curl request test fetch url', sec: 'net' },
        browser_open_code: { sig: 'browser_open_code(url, newTab=false)', brief: 'open a web page in the Chrome browser this server drives (Chrome DevTools MCP, started on first use)', kw: 'browser chrome web page url open navigate site internet navigateur ouvrir page', sec: 'browser' },
        browser_snapshot_code: { sig: 'browser_snapshot_code(verbose)', brief: 'text snapshot of the selected tab; each element has the uid that click/fill need', kw: 'browser snapshot page content read dom elements uid navigateur lire page', sec: 'browser' },
        browser_screenshot_code: { sig: 'browser_screenshot_code(fullPage, uid, format)', brief: 'image of the selected tab or of one element, plus a ![screenshot](url) link to paste in your reply so the user sees it', kw: 'browser screenshot capture image photo picture page navigateur capture ecran', sec: 'browser' },
        browser_click_code: { sig: 'browser_click_code(uid, dblClick)', brief: 'click an element by uid from the latest snapshot', kw: 'browser click button link press navigateur cliquer bouton lien', sec: 'browser' },
        browser_fill_code: { sig: 'browser_fill_code(uid, value | elements=[{uid,value}])', brief: 'type into inputs or pick select options; elements fills a whole form at once', kw: 'browser fill form input type field select navigateur remplir formulaire saisir', sec: 'browser' },
        browser_call_code: { sig: 'browser_call_code(tool, args)', brief: 'any other Chrome DevTools MCP tool (tabs, keys, wait_for, console, network, performance, lighthouse, evaluate_script); tool="list" lists them; sensitive calls need a VS Code confirmation', kw: 'browser devtools console network tabs pages key wait lighthouse performance script navigateur onglets reseau', sec: 'browser' },
        browser_close_code: { sig: 'browser_close_code()', brief: 'close the browser and stop Chrome DevTools MCP', kw: 'browser close quit stop chrome navigateur fermer', sec: 'browser' },
        get_performance_report_code: { sig: 'get_performance_report_code()', brief: 'server footprint and workspace weight', kw: 'performance footprint memory rss weight report', sec: 'net' },
        brew_coffee_code: { sig: 'brew_coffee_code(sugar)', brief: 'easter egg, brews nothing', kw: 'coffee easter egg joke', sec: 'net' },
        plan_mode_code: { sig: 'plan_mode_code(enabled)', brief: 'while ON, execution tools only DESCRIBE what they would run; reads keep working', kw: 'plan mode draft describe before executing', sec: 'net' }
};

export interface ToolCard {
        name: string;
        meta: ToolMeta;
        hints: ToolHints;
}

function tag(tool: string): string {
        const h = TOOL_HINTS[tool] ?? {};
        if (h.readOnlyHint) { return 'RO'; }
        if (h.destructiveHint) { return 'DST'; }
        return 'MUT';
}

const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'for', 'and', 'or', 'in', 'on', 'with', 'is', 'are', 'what', 'which', 'how', 'do', 'can', 'me', 'my', 'then', 'tell', 'image', 'this', 'that', 'where', 'your', 'you', 'elle', 'nous', 'vous', 'only', 'who', 'show', 'get', 'cette', 'les', 'des', 'une', 'un', 'de', 'du', 'la', 'le', 'et', 'ou', 'dans', 'pour', 'quand', 'veux', 'veut', 'faire', 'est', 'que', 'qui', 'sur', 'par', 'tout', 'plus', 'peux', 'pourrais', 'fichier', 'fichiers', 'change', 'changes']);

function tokenize(query: string): string[] {
        return (query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''))
                .split(/[^a-z0-9]+/).filter(t => t.length >= 3 && !STOP.has(t)).flatMap(t => t.endsWith('s') && t.length >= 4 ? [t, t.slice(0, -1)] : [t]);
}

/**
 * A keyword class is a tiny controlled synonym family ('read', 'test', 'pdf'
 * …). Exact keyword hits outrank name hits, name hits outrank prefix hits,
 * the brief counts only as a tie-breaker — otherwise one generic word
 * ('file') drags the wrong tool to the top.
 */
export function scoreTool(tool: string, meta: ToolMeta, tokens: string[]): number {
        if (tokens.length === 0) { return 0; }
        let score = 0;
        const toolL = tool.toLowerCase();
        // Exact-name hits crush everything: the querier who names the job
        // ('read a file' -> read_file_code) must not lose to a keyword pile.
        const nameCore = toolL.replace(/_code$/, '').replace(/_/g, ' ');
        let nameHits = 0;
        for (const t of tokens) {
                if (nameCore.includes(t)) { nameHits++; }
        }
        score += nameHits * nameHits * 6;
        const kwL = meta.kw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        const bag = new Set(kwL.split(/[^a-z0-9]+/).filter(Boolean));
        let kwHits = 0;
        for (const t of tokens) {
                if (bag.has(t)) { kwHits++; }
        }
        score += kwHits * kwHits * 4;
        for (const t of tokens) {
                if (bag.has(t)) { continue; }
                for (const b of bag) {
                        if (b.startsWith(t) || t.startsWith(b)) { score += 1; break; }
                }
        }
        const briefL = meta.brief.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
        for (const t of tokens) {
                if (briefL.includes(t)) { score += 1; }
        }
        return score;
}

export function searchCatalog(query: string, limit: number = 8): ToolCard[] {
        const tokens = tokenize(query);
        if (tokens.length === 0) { return []; }
        return Object.entries(CATALOG)
                .map(([name, meta]) => ({ name, meta, score: scoreTool(name, meta, tokens) }))
                .filter(e => e.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, Math.max(1, Math.min(limit, 20)))
                .map(e => ({ name: e.name, meta: e.meta, hints: TOOL_HINTS[e.name] ?? {} }));
}

export function renderToolCard(card: ToolCard): string {
        const { name, meta, hints } = card;
        const tags: string[] = [];
        if (hints.readOnlyHint) { tags.push('RO'); } else { tags.push(hints.destructiveHint ? 'DST' : 'MUT'); }
        if (hints.openWorldHint) { tags.push('NET'); }
        return `[${tags.join('+')}] ${name}(${meta.sig.replace(`${name}(`, '')}) — ${meta.brief} (kw: ${meta.kw})`;
}

/**
 * The compact index replaces the old 92-tool inline catalog. Every line is one
 * tool: name + a five-word role, sectioned. Roughly 1.5K tokens against ~10K
 * for the old inline catalog — the model calls lookup_tool_code(query) for the
 * precise signature, parameters and approval class of the tools its task
 * needs, and looks up the correct names instead of guessing them.
 */
export function compactCatalogIndex(): string {
        const sections = new Map<string, string[]>();
        for (const name of Object.keys(CATALOG)) {
                const meta = CATALOG[name];
                const list = sections.get(meta.sec) ?? [];			// Names-only line per tool: the brief lives in the full card, which
			// lookup_tool_code(query) returns.
			const short = '';
			list.push(name + (short ? ` (${short})` : ''));
                sections.set(meta.sec, list);
        }
        const lines: string[] = [
                `TOOL INDEX (${Object.keys(CATALOG).length} tools — lookup_tool_code(query) returns the full card: how to call it, params, RO/MUT/DST):`
        ];		for (const [sec, tools] of sections) {
			lines.push(`${sec}: ${tools.join(' ')}`);
        }
        return lines.join('\n');
}

/**
 * Count of tools currently indexed; test-visible so the catalog drifts loudly
 * instead of silently.
 */
export function catalogSize(): number {
        return Object.keys(CATALOG).length;
}
