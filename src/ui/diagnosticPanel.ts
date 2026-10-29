/**
 * AG-Wormhole - Diagnostic Panel Adapter
 */

import * as vscode from 'vscode';
import { CMD_SHOW_STATUS_PANEL } from '../shared/constants';
import { DiagnosticsEngine } from '../telemetry/diagnosticsEngine';
import { DiagnosticReport } from '../shared/types';

export class DiagnosticPanel {
    constructor(private context: vscode.ExtensionContext) {}

    public async show(): Promise<void> {
        await vscode.commands.executeCommand(CMD_SHOW_STATUS_PANEL);
    }

    public async runDiagnostics(): Promise<DiagnosticReport> {
        return await DiagnosticsEngine.runDiagnostics();
    }

    public dispose(): void {
        // Handled by unified dashboard
    }
}

