export const CLIENT_CEILING_MS = 30000;
export const RESPONSE_RESERVE_MS = 3000;
export const CLIENT_BUDGET_MS = CLIENT_CEILING_MS - RESPONSE_RESERVE_MS;
export const SHELL_TIMEOUT_MS = 25000;
export function clampToBudget(timeout: number): number {
        return Math.max(1, Math.min(timeout, CLIENT_BUDGET_MS));
}
