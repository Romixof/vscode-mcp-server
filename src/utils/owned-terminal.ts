import * as vscode from 'vscode';

/**
 * Terminals this extension host created, by name.
 *
 * VS Code revives terminals across a window reload or an extension update
 * (persistent sessions). A revived shell still runs the text we send, but its
 * shell-integration events no longer reach this extension host, so the output
 * stream never yields: the command runs and the call times out with nothing
 * captured (observed live: `rm x && ls x` deleted the file, then hit the 25 s
 * ceiling). Only a terminal created by this activation is reused; a revived
 * one with the same name is closed and replaced.
 */
const owned = new Map<string, vscode.Terminal>();

export function ownedTerminal(name: string, create: () => vscode.Terminal, onReplace?: () => void): vscode.Terminal {
        const mine = owned.get(name);
        if (mine && mine.exitStatus === undefined) {
                return mine;
        }
        for (const stale of vscode.window.terminals) {
                if (stale.name === name && stale !== mine && stale.exitStatus === undefined) {
                        onReplace?.();
                        stale.dispose();
                }
        }
        const fresh = create();
        owned.set(name, fresh);
        return fresh;
}
