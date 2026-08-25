import * as vscode from 'vscode';

export class Logger {
    private static instance: Logger;
    private outputChannel: vscode.OutputChannel;

    private constructor() {
        this.outputChannel = vscode.window.createOutputChannel('MCP Server Extension');
    }

    public static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }

    private formatMessage(message: string): string {
        const timestamp = new Date().toISOString();
        return `[${timestamp}] ${message}`;
    }

    public info(message: string): void {
        this.outputChannel.appendLine(this.formatMessage(`INFO: ${message}`));
    }

    public warn(message: string): void {
        this.outputChannel.appendLine(this.formatMessage(`WARN: ${message}`));
    }

    public error(message: string): void {
        this.outputChannel.appendLine(this.formatMessage(`ERROR: ${message}`));
    }

    public debug(message: string): void {
        this.outputChannel.appendLine(this.formatMessage(`DEBUG: ${message}`));
    }

    public showChannel(): void {
        this.outputChannel.show();
    }

    public dispose(): void {
        if (this.outputChannel) {
            this.outputChannel.dispose();
        }
    }
}

export const logger = Logger.getInstance();
