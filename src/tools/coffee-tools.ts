import * as vscode from 'vscode';
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from 'zod';
import { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { executeShellCommand, resolveShellKind } from './shell-tools';

const CUP = [
	'        ) )',
	'       ( (',
	'     ............',
	'     |          |]',
	'     \\          /',
	'      ~~~~~~~~~~'
];

let coffeeTerminal: vscode.Terminal | undefined;

export function buildPourCommand(kind: 'bash' | 'powershell', lines: string[]): string {
	return kind === 'bash'
		? `printf '%s\\n' ${lines.map(l => `'${l}'`).join(' ')}`
		: `Write-Output ${lines.map(l => `'${l}'`).join(',')}`;
}

async function pourInTerminal(): Promise<void> {
	try {
		if (!coffeeTerminal) {
			coffeeTerminal = vscode.window.createTerminal('☕');
		}
		const command = buildPourCommand(await resolveShellKind(coffeeTerminal), CUP);
		await executeShellCommand(coffeeTerminal, command, undefined, 4000);
	} catch {

	}
}

export function registerCoffeeTools(server: McpServer): void {
	server.tool(
		'brew_coffee_code',
		`Easter egg: brew a virtual coffee in the terminal.`,
		{
			sugar: z.boolean().optional().default(false).describe('Serve it with sugar')
		},
		async ({ sugar = false }): Promise<CallToolResult> => {
			void pourInTerminal();
			const sweetener = sugar ? 'Une touche de sucre. ' : '';
			return {
				content: [{
					type: 'text',
					text: `${CUP.join('\n')}\n\n☕ ${sweetener}Voilà, un café bien chaud. / There you go, one hot coffee.`
				}]
			};
		}
	);
}
