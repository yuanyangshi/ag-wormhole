/**
 * AG-Wormhole - Traffic Panel Adapter
 */

import * as vscode from 'vscode';
import { CMD_SHOW_STATUS_PANEL } from '../shared/constants';

export class TrafficPanel {
    constructor(private context: vscode.ExtensionContext) {}

    public show(): void {
        vscode.commands.executeCommand(CMD_SHOW_STATUS_PANEL);
    }

    public dispose(): void {
        // Handled by unified dashboard
    }
}

