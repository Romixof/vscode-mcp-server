export type Scope = 'fs:read' | 'fs:write' | 'shell:exec' | 'net:out' | 'mem:write' | 'admin';

export const ALL_SCOPES: Scope[] = ['fs:read', 'fs:write', 'shell:exec', 'net:out', 'mem:write', 'admin'];

export type PresetName = 'read-only' | 'standard' | 'full';

export const PRESETS: Record<PresetName, Scope[]> = {
    'read-only': ['fs:read'],
    'standard': ['fs:read', 'fs:write', 'shell:exec'],
    'full': ['fs:read', 'fs:write', 'shell:exec', 'net:out', 'mem:write']
};

const SCOPE_TOOLS: Record<Scope, string[]> = {
    'fs:read': [
        'read_file_code', 'list_files_code', 'find_todo_code',
        'get_diagnostics_code', 'search_symbols_code', 'get_document_symbols_code',
        'get_symbol_definition_code', 'list_workspace_folders_code',
        'get_git_diff_code', 'get_blame_code', 'get_file_history_code', 'list_conflicts_code',
        'check_env_vars_code', 'list_extensions_code', 'list_snippets_code',
        'get_performance_report_code', 'get_server_info_code', 'get_open_ports_code',
        'get_project_context_code', 'get_package_dependencies_code',
        'memory_load_code', 'memory_search_code',
        'snapshot_workspace_code',
        'list_skills_code', 'validate_skill_code'
    ],
    'fs:write': [
        'create_file_code', 'move_file_code', 'copy_file_code', 'rename_file_code',
        'replace_lines_code', 'format_document_code', 'generate_docstring_code',
        'generate_ics_code', 'rename_symbol_code',
        'memory_save_code',
        'create_skill_code'
    ],
    'shell:exec': [
        'execute_shell_command_code', 'run_task_code', 'restart_dev_server_code',
        'run_sql_query_code', 'profile_command_code', 'run_alias_code',
        'commit_changes_code', 'create_branch_code', 'stash_changes_code',
        'run_tests_code', 'build_project_code',
        'package_skill_code'
    ],
    'net:out': [
        'test_api_endpoint_code', 'check_dependencies_vulnerabilities_code'
    ],
    'mem:write': [
        'memory_save_code', 'memory_clear_code'
    ],
    'admin': [
        'get_audit_log_code'
    ]
};

const EXACT = new Map<string, Scope[]>();
for (const [scope, tools] of Object.entries(SCOPE_TOOLS) as Array<[Scope, string[]]>) {
    for (const t of tools) {
        const existing = EXACT.get(t);
        EXACT.set(t, existing ? [...existing, scope] : [scope]);
    }
}

export function scopeDescription(scopes: Scope[]): string {
    if (scopes.length === 0) return 'no access';
    const parts: string[] = [];
    if (scopes.includes('fs:read')) parts.push('read files');
    if (scopes.includes('fs:write')) parts.push('edit files');
    if (scopes.includes('shell:exec')) parts.push('run commands');
    if (scopes.includes('net:out')) parts.push('network calls');
    if (scopes.includes('mem:write')) parts.push('modify memory');
    if (scopes.includes('admin')) parts.push('administration');
    return parts.join(', ');
}

export function parseScopes(input: string | undefined): Scope[] {
    if (!input) return [];
    return input.split(/[\s,]+/).map(s => s.trim()).filter((s): s is Scope => (ALL_SCOPES as string[]).includes(s));
}

export function scopeAllows(granted: Scope[], toolName: string): boolean {
    if (!toolName) return false;
    if ((ALL_SCOPES as string[]).includes(toolName)) return false;
    const needed = EXACT.get(toolName);
    if (!needed) return false;
    return granted.some(g => needed.includes(g));
}

export function intersectScopes(requested: string | undefined, preset: Scope[]): Scope[] {
    if (!requested || !requested.trim()) return [...preset];
    const req = parseScopes(requested);
    if (req.length === 0) return [...preset];
    const inter = req.filter((r): r is Scope => preset.includes(r));
    return inter.includes('fs:read') ? inter : [...new Set<Scope>(['fs:read', ...inter])];
}

export function unregisteredToolNames(): string[] {
    const known = new Set<string>(EXACT.keys());
    return [...known].sort();
}
