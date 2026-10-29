/**
 * AG-Wormhole - Unified Dashboard & Control Center Panel
 */

import * as vscode from 'vscode';
import { ProxyStatus, DiagnosticReport, TrafficStats } from '../shared/types';
import { DiagnosticsEngine } from '../telemetry/diagnosticsEngine';
import { TrafficCollector } from '../telemetry/trafficCollector';
import {
    CONFIG_SECTION,
    CFG_ENABLE_LOCAL_FORWARDING,
    CFG_LOCAL_PROXY_PORT,
    CFG_REMOTE_PROXY_HOST,
    CFG_REMOTE_PROXY_PORT,
    CFG_PROXY_TYPE,
    DEFAULT_PROXY_PORT,
    DEFAULT_PROXY_HOST,
    DEFAULT_PROXY_TYPE,
    CMD_SETUP,
    CMD_ROLLBACK,
    CMD_SHOW_OUTPUT
} from '../shared/constants';
import { logger } from '../shared/logger';

export class StatusPanel {
    private static currentPanel: StatusPanel | undefined;
    private readonly panel: vscode.WebviewPanel;
    private disposables: vscode.Disposable[] = [];
    private onConfigSaveHandler?: () => Promise<void>;

    private currentStatus: ProxyStatus;
    private trafficStats?: TrafficStats;
    private diagnosticReport?: DiagnosticReport;
    private isRunningDiagnostics: boolean = false;

    private constructor(
        panel: vscode.WebviewPanel,
        initialStatus: ProxyStatus,
        private readonly trafficCollector?: TrafficCollector,
        onConfigSave?: () => Promise<void>
    ) {
        this.panel = panel;
        this.currentStatus = initialStatus;
        this.onConfigSaveHandler = onConfigSave;

        if (this.trafficCollector) {
            this.trafficStats = this.trafficCollector.getStats();
            this.disposables.push(
                this.trafficCollector.onUpdate((stats) => {
                    this.trafficStats = stats;
                    this.postMessage({ type: 'updateTraffic', stats });
                })
            );
        }

        this.updateHtml();

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

        this.panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'refresh':
                        await vscode.commands.executeCommand('ag-wormhole.refreshStatus');
                        break;
                    case 'runDiagnostics':
                        await this.triggerDiagnostics();
                        break;
                    case 'copyReport':
                        if (this.diagnosticReport) {
                            const text = DiagnosticsEngine.generateReportText(this.diagnosticReport);
                            await vscode.env.clipboard.writeText(text);
                            vscode.window.showInformationMessage('AG-Wormhole diagnostic report copied to clipboard.');
                        }
                        break;
                    case 'saveConfig':
                        await this.saveConfiguration(message.config);
                        break;
                    case 'setupRemote':
                        await vscode.commands.executeCommand(CMD_SETUP);
                        break;
                    case 'rollbackRemote':
                        await vscode.commands.executeCommand(CMD_ROLLBACK);
                        break;
                    case 'showLogs':
                        await vscode.commands.executeCommand(CMD_SHOW_OUTPUT);
                        break;
                }
            },
            null,
            this.disposables
        );
    }

    public static createOrShow(
        context: vscode.ExtensionContext,
        status: ProxyStatus,
        trafficCollector?: TrafficCollector,
        onConfigSave?: () => Promise<void>
    ): StatusPanel {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;

        if (StatusPanel.currentPanel) {
            StatusPanel.currentPanel.currentStatus = status;
            StatusPanel.currentPanel.panel.reveal(column);
            StatusPanel.currentPanel.updateHtml();
            return StatusPanel.currentPanel;
        }

        const panel = vscode.window.createWebviewPanel(
            'agWormholeDashboard',
            'AG-Wormhole Dashboard',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        StatusPanel.currentPanel = new StatusPanel(panel, status, trafficCollector, onConfigSave);
        return StatusPanel.currentPanel;
    }

    public updateStatus(status: ProxyStatus): void {
        this.currentStatus = status;
        this.updateHtml();
    }

    private postMessage(msg: Record<string, unknown>): void {
        this.panel.webview.postMessage(msg);
    }

    private async triggerDiagnostics(): Promise<void> {
        this.isRunningDiagnostics = true;
        this.postMessage({ type: 'diagnosticsStart' });
        try {
            this.diagnosticReport = await DiagnosticsEngine.runDiagnostics();
            this.postMessage({
                type: 'diagnosticsComplete',
                report: this.diagnosticReport
            });
        } catch (error) {
            logger.log(`Diagnostics error: ${error}`, this.currentStatus.runningLocation === 'local');
        } finally {
            this.isRunningDiagnostics = false;
        }
    }

    private async saveConfiguration(cfg: {
        enableLocalForwarding?: boolean;
        localProxyPort?: number;
        remoteProxyHost?: string;
        remoteProxyPort?: number;
        proxyType?: string;
    }): Promise<void> {
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);

        if (cfg.enableLocalForwarding !== undefined) {
            await config.update(CFG_ENABLE_LOCAL_FORWARDING, cfg.enableLocalForwarding, vscode.ConfigurationTarget.Global);
        }
        if (cfg.localProxyPort !== undefined) {
            await config.update(CFG_LOCAL_PROXY_PORT, Number(cfg.localProxyPort), vscode.ConfigurationTarget.Global);
        }
        if (cfg.remoteProxyHost !== undefined) {
            await config.update(CFG_REMOTE_PROXY_HOST, cfg.remoteProxyHost, vscode.ConfigurationTarget.Global);
        }
        if (cfg.remoteProxyPort !== undefined) {
            await config.update(CFG_REMOTE_PROXY_PORT, Number(cfg.remoteProxyPort), vscode.ConfigurationTarget.Global);
        }
        if (cfg.proxyType !== undefined) {
            await config.update(CFG_PROXY_TYPE, cfg.proxyType, vscode.ConfigurationTarget.Global);
        }

        if (this.onConfigSaveHandler) {
            await this.onConfigSaveHandler();
        }

        vscode.window.showInformationMessage('AG-Wormhole configuration updated successfully.');
        await vscode.commands.executeCommand('ag-wormhole.refreshStatus');
    }

    private updateHtml(): void {
        this.panel.webview.html = this.renderHtml();
    }

    private renderHtml(): string {
        const isLocal = this.currentStatus.runningLocation === 'local';
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
        const localPort = config.get<number>(CFG_LOCAL_PROXY_PORT, DEFAULT_PROXY_PORT);
        const remoteHost = config.get<string>(CFG_REMOTE_PROXY_HOST, DEFAULT_PROXY_HOST);
        const remotePort = config.get<number>(CFG_REMOTE_PROXY_PORT, DEFAULT_PROXY_PORT);
        const proxyType = config.get<string>(CFG_PROXY_TYPE, DEFAULT_PROXY_TYPE);
        const enableForwarding = config.get<boolean>(CFG_ENABLE_LOCAL_FORWARDING, true);

        const isOnline = isLocal
            ? (this.currentStatus.sshConfigEnabled && this.currentStatus.localProxyReachable)
            : (this.currentStatus.remoteProxyReachable && this.currentStatus.languageServerConfigured);

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>AG-Wormhole Dashboard</title>
    <style>
        :root {
            --bg-primary: var(--vscode-editor-background, #1e1e1e);
            --bg-secondary: var(--vscode-sideBar-background, #252526);
            --bg-card: var(--vscode-editorWidget-background, #2d2d30);
            --border-color: var(--vscode-widget-border, #3c3c3c);
            --text-primary: var(--vscode-foreground, #cccccc);
            --text-secondary: var(--vscode-descriptionForeground, #888888);
            --accent: var(--vscode-button-background, #007acc);
            --accent-hover: var(--vscode-button-hoverBackground, #0062a3);
            --success: #4ec9b0;
            --warning: #ce9178;
            --error: #f14c4c;
        }
        body {
            font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
            background-color: var(--bg-primary);
            color: var(--text-primary);
            padding: 24px;
            margin: 0;
            line-height: 1.5;
        }
        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid var(--border-color);
            padding-bottom: 16px;
            margin-bottom: 24px;
        }
        .title-group {
            display: flex;
            align-items: center;
            gap: 12px;
        }
        .title {
            font-size: 20px;
            font-weight: 600;
            margin: 0;
        }
        .badge {
            font-size: 11px;
            font-weight: 600;
            padding: 2px 8px;
            border-radius: 4px;
            text-transform: uppercase;
        }
        .badge-mode {
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            color: var(--text-secondary);
        }
        .badge-online {
            background: rgba(78, 201, 176, 0.15);
            color: var(--success);
            border: 1px solid var(--success);
        }
        .badge-offline {
            background: rgba(241, 76, 76, 0.15);
            color: var(--error);
            border: 1px solid var(--error);
        }
        .grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
            gap: 20px;
            margin-bottom: 24px;
        }
        .card {
            background: var(--bg-card);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 18px;
        }
        .card-title {
            font-size: 14px;
            font-weight: 600;
            margin-top: 0;
            margin-bottom: 14px;
            color: var(--text-primary);
            display: flex;
            align-items: center;
            justify-content: space-between;
        }
        .metric-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 0;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
            font-size: 13px;
        }
        .metric-row:last-child {
            border-bottom: none;
        }
        .metric-label {
            color: var(--text-secondary);
        }
        .metric-value {
            font-weight: 500;
        }
        .btn {
            background: var(--accent);
            color: #ffffff;
            border: none;
            border-radius: 4px;
            padding: 6px 14px;
            font-size: 12px;
            font-weight: 500;
            cursor: pointer;
            transition: background 0.2s;
        }
        .btn:hover {
            background: var(--accent-hover);
        }
        .btn-secondary {
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            color: var(--text-primary);
        }
        .btn-secondary:hover {
            background: rgba(255, 255, 255, 0.1);
        }
        .btn-danger {
            background: var(--error);
        }
        .btn-group {
            display: flex;
            gap: 8px;
            margin-top: 14px;
        }
        .form-group {
            margin-bottom: 12px;
        }
        .form-group label {
            display: block;
            font-size: 12px;
            color: var(--text-secondary);
            margin-bottom: 4px;
        }
        .form-control {
            width: 100%;
            background: var(--bg-secondary);
            border: 1px solid var(--border-color);
            color: var(--text-primary);
            padding: 6px 10px;
            border-radius: 4px;
            font-size: 13px;
            box-sizing: border-box;
        }
        .checkbox-group {
            display: flex;
            align-items: center;
            gap: 8px;
            font-size: 13px;
            margin-bottom: 12px;
        }
        .diag-item {
            padding: 10px;
            border-radius: 4px;
            background: var(--bg-secondary);
            margin-bottom: 8px;
            font-size: 12px;
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="title-group">
            <h1 class="title">AG-Wormhole</h1>
            <span class="badge badge-mode">${isLocal ? 'Local Mode' : 'Remote Mode'}</span>
            <span class="badge ${isOnline ? 'badge-online' : 'badge-offline'}">${isOnline ? 'Active' : 'Degraded'}</span>
        </div>
        <div class="btn-group" style="margin: 0;">
            <button class="btn btn-secondary" onclick="sendMessage('refresh')">Refresh</button>
            <button class="btn btn-secondary" onclick="sendMessage('runDiagnostics')">Run Diagnostics</button>
            <button class="btn btn-secondary" onclick="sendMessage('showLogs')">View Logs</button>
        </div>
    </div>

    <div class="grid">
        <!-- Plane Architecture Card -->
        <div class="card">
            <h3 class="card-title">Dual-Plane Status</h3>
            <div class="metric-row">
                <span class="metric-label">Execution Environment</span>
                <span class="metric-value">${isLocal ? 'Local Host Machine' : 'Remote SSH Server'}</span>
            </div>
            ${isLocal ? `
            <div class="metric-row">
                <span class="metric-label">Local Proxy (127.0.0.1:${this.currentStatus.localProxyPort})</span>
                <span class="metric-value" style="color: ${this.currentStatus.localProxyReachable ? 'var(--success)' : 'var(--error)'};">
                    ${this.currentStatus.localProxyReachable ? 'Reachable' : 'Unreachable'}
                </span>
            </div>
            <div class="metric-row">
                <span class="metric-label">SSH Reverse Tunnel</span>
                <span class="metric-value" style="color: ${this.currentStatus.sshConfigEnabled ? 'var(--success)' : 'var(--error)'};">
                    ${this.currentStatus.sshConfigEnabled ? 'Active (RemoteForward ' + this.currentStatus.remoteProxyPort + ')' : 'Disabled'}
                </span>
            </div>
            ` : `
            <div class="metric-row">
                <span class="metric-label">Remote Ingress (${this.currentStatus.remoteProxyHost}:${this.currentStatus.remoteProxyPort})</span>
                <span class="metric-value" style="color: ${this.currentStatus.remoteProxyReachable ? 'var(--success)' : 'var(--error)'};">
                    ${this.currentStatus.remoteProxyReachable ? 'Reachable' : 'Unreachable'}
                </span>
            </div>
            <div class="metric-row">
                <span class="metric-label">Syscall Redirection Sandbox</span>
                <span class="metric-value" style="color: ${this.currentStatus.languageServerConfigured ? 'var(--success)' : 'var(--warning)'};">
                    ${this.currentStatus.languageServerConfigured ? 'Injected (Active)' : 'Pending Setup'}
                </span>
            </div>
            `}
            <div class="metric-row">
                <span class="metric-label">Last Synchronization</span>
                <span class="metric-value">${this.currentStatus.lastUpdated.toLocaleTimeString()}</span>
            </div>
        </div>

        <!-- Telemetry & Traffic Card -->
        <div class="card">
            <h3 class="card-title">Live Telemetry</h3>
            ${!isLocal && this.trafficStats ? `
            <div class="metric-row">
                <span class="metric-label">Active Tunnel Connections</span>
                <span class="metric-value" id="activeConn">${this.trafficStats.activeConnections}</span>
            </div>
            <div class="metric-row">
                <span class="metric-label">Cumulative Handshakes</span>
                <span class="metric-value" id="totalConn">${this.trafficStats.totalConnectionsSeen}</span>
            </div>
            <div class="metric-row">
                <span class="metric-label">Uplink Heartbeat</span>
                <span class="metric-value" style="color: ${this.trafficStats.proxyReachable ? 'var(--success)' : 'var(--error)'};">
                    ${this.trafficStats.proxyReachable ? 'Healthy' : 'Disconnected'}
                </span>
            </div>
            ` : `
            <div class="metric-row">
                <span class="metric-label">Telemetry Scope</span>
                <span class="metric-value">Active in Remote Environments</span>
            </div>
            <div class="metric-row">
                <span class="metric-label">Tunnel Verification</span>
                <span class="metric-value">${this.currentStatus.sshConfigEnabled ? 'Include Directive Configured' : 'Idle'}</span>
            </div>
            `}
            ${!isLocal ? `
            <div class="btn-group">
                <button class="btn" onclick="sendMessage('setupRemote')">Inject Sandbox</button>
                <button class="btn btn-secondary" onclick="sendMessage('rollbackRemote')">Rollback Binary</button>
            </div>
            ` : ''}
        </div>
    </div>

    <!-- Configuration Settings Form -->
    <div class="card" style="margin-bottom: 24px;">
        <h3 class="card-title">Control Plane Configuration</h3>
        <form id="configForm" onsubmit="handleSave(event)">
            ${isLocal ? `
            <div class="checkbox-group">
                <input type="checkbox" id="enableLocalForwarding" ${enableForwarding ? 'checked' : ''}>
                <label for="enableLocalForwarding">Enable SSH Port Reverse Forwarding</label>
            </div>
            <div class="grid" style="margin-bottom: 0;">
                <div class="form-group">
                    <label for="localProxyPort">Local Proxy Port (Listener on host machine)</label>
                    <input type="number" class="form-control" id="localProxyPort" value="${localPort}">
                </div>
                <div class="form-group">
                    <label for="remoteProxyPort">Remote Tunnel Port (Forwarded ingress port)</label>
                    <input type="number" class="form-control" id="remoteProxyPort" value="${remotePort}">
                </div>
            </div>
            ` : `
            <div class="grid" style="margin-bottom: 0;">
                <div class="form-group">
                    <label for="remoteProxyHost">Remote Ingress Host</label>
                    <input type="text" class="form-control" id="remoteProxyHost" value="${remoteHost}">
                </div>
                <div class="form-group">
                    <label for="remoteProxyPort">Remote Ingress Port</label>
                    <input type="number" class="form-control" id="remoteProxyPort" value="${remotePort}">
                </div>
                <div class="form-group">
                    <label for="proxyType">Tunnel Protocol</label>
                    <select class="form-control" id="proxyType">
                        <option value="http" ${proxyType === 'http' ? 'selected' : ''}>HTTP (Standard)</option>
                        <option value="socks5" ${proxyType === 'socks5' ? 'selected' : ''}>SOCKS5</option>
                    </select>
                </div>
            </div>
            `}
            <div class="btn-group">
                <button type="submit" class="btn">Apply & Synchronize</button>
            </div>
        </form>
    </div>

    <!-- Diagnostic Panel -->
    <div class="card" id="diagContainer">
        <h3 class="card-title">
            <span>Link Diagnostics</span>
            <button class="btn btn-secondary" onclick="sendMessage('copyReport')" id="copyBtn" style="display: none;">Copy Report</button>
        </h3>
        <div id="diagContent">
            <p style="color: var(--text-secondary); margin: 0; font-size: 13px;">
                No diagnostics executed yet. Click "Run Diagnostics" to inspect the end-to-end routing stack.
            </p>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        function sendMessage(command, payload = {}) {
            vscode.postMessage({ command, ...payload });
        }

        function handleSave(e) {
            e.preventDefault();
            const config = {};
            const isLocal = ${isLocal};

            if (isLocal) {
                config.enableLocalForwarding = document.getElementById('enableLocalForwarding').checked;
                config.localProxyPort = parseInt(document.getElementById('localProxyPort').value, 10);
                config.remoteProxyPort = parseInt(document.getElementById('remoteProxyPort').value, 10);
            } else {
                config.remoteProxyHost = document.getElementById('remoteProxyHost').value;
                config.remoteProxyPort = parseInt(document.getElementById('remoteProxyPort').value, 10);
                config.proxyType = document.getElementById('proxyType').value;
            }

            sendMessage('saveConfig', { config });
        }

        window.addEventListener('message', event => {
            const msg = event.data;
            if (msg.type === 'updateTraffic') {
                const ac = document.getElementById('activeConn');
                const tc = document.getElementById('totalConn');
                if (ac) ac.textContent = msg.stats.activeConnections;
                if (tc) tc.textContent = msg.stats.totalConnectionsSeen;
            } else if (msg.type === 'diagnosticsStart') {
                document.getElementById('diagContent').innerHTML = '<p style="color: var(--text-secondary);">Executing diagnostic pipeline...</p>';
            } else if (msg.type === 'diagnosticsComplete') {
                const report = msg.report;
                const copyBtn = document.getElementById('copyBtn');
                if (copyBtn) copyBtn.style.display = 'inline-block';

                let html = '<div style="display: flex; flex-direction: column; gap: 8px;">';
                for (const check of report.checks) {
                    const color = check.status === 'success' ? 'var(--success)' :
                                  check.status === 'warning' ? 'var(--warning)' : 'var(--error)';
                    html += \`
                        <div class="diag-item">
                            <div style="font-weight: 600; color: \${color};">\${check.name} (\${check.status.toUpperCase()})</div>
                            \${check.message ? \`<div style="margin-top: 4px;">\${check.message}</div>\` : ''}
                            \${check.suggestion ? \`<div style="margin-top: 4px; color: var(--text-secondary);">Suggestion: \${check.suggestion}</div>\` : ''}
                        </div>
                    \`;
                }
                html += '</div>';
                document.getElementById('diagContent').innerHTML = html;
            }
        });
    </script>
</body>
</html>`;
    }

    public dispose(): void {
        StatusPanel.currentPanel = undefined;
        this.panel.dispose();
        while (this.disposables.length) {
            const x = this.disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
}

