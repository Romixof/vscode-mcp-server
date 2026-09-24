import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export interface ToolHints {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
}

export interface AnnotationReport {
    annotated: number;
    unknown: string[];
}

const RO: ToolHints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };
const MUT: ToolHints = { readOnlyHint: false, destructiveHint: false };
const DST: ToolHints = { readOnlyHint: false, destructiveHint: true };
const NET_RO: ToolHints = { ...RO, openWorldHint: true };
const NET_MUT: ToolHints = { ...MUT, openWorldHint: true };

export const TOOL_HINTS: Record<string, ToolHints> = {
    list_workspace_folders_code: RO,
    list_files_code: RO,
    read_file_code: RO,
    search_workspace_code: RO,
    get_agent_instructions_code: RO,
    get_diagnostics_code: RO,
    search_symbols_code: RO,
    get_symbol_definition_code: RO,
    get_document_symbols_code: RO,
    memory_load_code: RO,
    memory_search_code: RO,
    get_active_editor_code: RO,
    list_open_tabs_code: RO,
    workspace_state_code: RO,
    workspace_log_code: RO,
    session_bootstrap_code: RO,
    get_git_diff_code: RO,
    get_blame_code: RO,
    list_conflicts_code: RO,
    find_todo_code: RO,
    get_file_history_code: RO,
    get_package_dependencies_code: RO,
    get_project_context_code: RO,
    find_dead_code_code: RO,
    regex_tester_code: RO,
    find_secrets_code: RO,
    security_scan_code: RO,
    get_audit_log_code: RO,
    check_dependencies_vulnerabilities_code: NET_RO,
    list_skills_code: RO,
    validate_skill_code: RO,
    get_performance_report_code: RO,
    analyze_bundle_code: RO,
    analyze_css_code: RO,
    audit_accessibility_code: RO,
    find_unused_css_code: RO,
    inspect_element_code: RO,
    find_duplicate_code_code: RO,
    suggest_refactoring_code: RO,
    get_server_info_code: RO,
    list_extensions_code: RO,
    list_snippets_code: RO,
    check_env_vars_code: RO,
    get_open_ports_code: RO,
    retrieve_output_code: RO,
    brew_coffee_code: RO,
    pdf_needs_ocr_code: RO,
    render_pdf_pages_code: RO,
    diff_preview_code: RO,
    call_graph_code: RO,
    test_impact_code: RO,
    migration_diff_code: RO,
    expose_audit_code: RO,

    create_file_code: MUT,
    replace_lines_code: MUT,
    memory_save_code: MUT,
    session_end_code: MUT,
    edit_file_code: MUT,
    commit_changes_code: MUT,
    create_branch_code: MUT,
    format_document_code: MUT,
    lint_and_fix_code: MUT,
    run_tests_code: MUT,
    get_test_coverage_code: MUT,
    generate_docstring_code: MUT,
    generate_ics_code: MUT,
    snapshot_workspace_code: MUT,
    convert_encoding_code: MUT,
    rename_symbol_code: MUT,
    extract_function_code: MUT,
    package_skill_code: MUT,
    create_skill_code: MUT,
    run_task_code: MUT,
    build_project_code: MUT,
    plan_mode_code: MUT,
    checkpoint_code: MUT,
    background_task_code: MUT,
    scope_keys_code: MUT,
    secret_rotate_code: MUT,
    test_api_endpoint_code: NET_MUT,
    ocr_pdf_code: MUT,

    execute_shell_command_code: DST,
    run_alias_code: DST,
    run_sql_query_code: DST,
    restart_dev_server_code: DST,
    profile_command_code: DST,
    stash_changes_code: DST,
    memory_clear_code: DST,
    move_file_code: DST,
    rename_file_code: DST,
    copy_file_code: DST
};

export function applyToolAnnotations(server: McpServer): AnnotationReport {
    const registrations = (server as unknown as { _registeredTools?: Record<string, { annotations?: ToolHints }> })._registeredTools;
    if (!registrations) {
        return { annotated: 0, unknown: [] };
    }
    const unknown: string[] = [];
    let annotated = 0;
    for (const name of Object.keys(registrations)) {
        const hints = TOOL_HINTS[name];
        if (hints) {
            registrations[name].annotations = { ...hints };
            annotated += 1;
        } else {
            unknown.push(name);
        }
    }
    return { annotated, unknown };
}
