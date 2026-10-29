/**
 * AG-Wormhole - Unified Output Channel Logger
 */

import { EXTENSION_NAME } from './constants';

interface MinimalOutputChannel {
    appendLine(value: string): void;
    show(): void;
}

export class WormholeLogger {
    private static instance: WormholeLogger;
    private outputChannel: MinimalOutputChannel | null = null;

    private constructor() {}

    public static getInstance(): WormholeLogger {
        if (!WormholeLogger.instance) {
            WormholeLogger.instance = new WormholeLogger();
        }
        return WormholeLogger.instance;
    }

    public initialize(context: { subscriptions: { push(item: unknown): void } }): void {
        if (!this.outputChannel) {
            try {
                // Dynamically load vscode to support both Extension Host and standalone test environments
                const vscode = require('vscode');
                this.outputChannel = vscode.window.createOutputChannel(EXTENSION_NAME);
                if (this.outputChannel) {
                    context.subscriptions.push(this.outputChannel);
                }
            } catch {
                // Non-extension environment (e.g., mocha unit test execution)
            }
        }
    }

    public setOutputChannel(channel: MinimalOutputChannel | null): void {
        this.outputChannel = channel;
    }

    public log(message: string, isLocal: boolean = true): void {
        const timestamp = new Date().toISOString();
        const locationTag = isLocal ? '[LOCAL]' : '[REMOTE]';
        const line = `${timestamp} ${locationTag} [AG-Wormhole] ${message}`;
        if (this.outputChannel) {
            this.outputChannel.appendLine(line);
        }
    }

    public show(): void {
        this.outputChannel?.show();
    }
}

export const logger = WormholeLogger.getInstance();
