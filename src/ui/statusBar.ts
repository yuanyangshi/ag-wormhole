/**
 * AG-Wormhole - Status Bar Controller
 */

import * as vscode from 'vscode';
import { ProxyStatus } from '../shared/types';
import { CMD_SHOW_STATUS_PANEL } from '../shared/constants';

export class StatusBarController implements vscode.Disposable {
    private statusBarItem: vscode.StatusBarItem;

    constructor() {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Left,
            -100
        );
        this.statusBarItem.command = CMD_SHOW_STATUS_PANEL;
        this.statusBarItem.name = 'AG-Wormhole';
        this.update({
            runningLocation: 'local',
            sshConfigEnabled: false,
            localProxyPort: 7890,
            remoteProxyPort: 7890,
            remoteProxyHost: '127.0.0.1',
            localProxyReachable: false,
            remoteProxyReachable: false,
            lastUpdated: new Date()
        });
        this.statusBarItem.show();
    }

    public update(status: ProxyStatus): void {
        const isLocal = status.runningLocation === 'local';
        let icon = '🟢';
        let label = 'AGW';
        let tooltip = 'AG-Wormhole Control Center\n\n';

        if (isLocal) {
            tooltip += `Role: Local Control Plane\n`;
            tooltip += `SSH Reverse Forwarding: ${status.sshConfigEnabled ? 'Active' : 'Disabled'}\n`;
            tooltip += `Local Proxy (127.0.0.1:${status.localProxyPort}): ${status.localProxyReachable ? 'Reachable' : 'Unreachable'}\n`;

            if (status.sshConfigEnabled && status.localProxyReachable) {
                icon = '🟢';
                this.statusBarItem.color = '#73c991';
                this.statusBarItem.backgroundColor = undefined;
                tooltip += `Status: Healthy (Forwarding Port ${status.remoteProxyPort})\n`;
            } else if (!status.sshConfigEnabled) {
                icon = '⚪';
                this.statusBarItem.color = '#8c8c8c';
                this.statusBarItem.backgroundColor = undefined;
                tooltip += `Status: Forwarding Disabled\n`;
            } else {
                icon = '🟡';
                this.statusBarItem.color = '#e2c08d';
                this.statusBarItem.backgroundColor = undefined;
                tooltip += `Status: Local Proxy Unreachable\n`;
            }
        } else {
            tooltip += `Role: Remote Data Plane\n`;
            tooltip += `Ingress Endpoint (${status.remoteProxyHost}:${status.remoteProxyPort}): ${status.remoteProxyReachable ? 'Reachable' : 'Unreachable'}\n`;
            if (status.isRelaying) {
                tooltip += `Tunnel Bridge: Active (Auto-bridged via port ${status.activeTunnelPort})\n`;
            }
            tooltip += `Language Server Interception: ${status.languageServerConfigured ? 'Injected' : 'Pending'}\n`;

            if (status.remoteProxyReachable && status.languageServerConfigured) {
                icon = '🟢';
                this.statusBarItem.color = '#73c991';
                this.statusBarItem.backgroundColor = undefined;
                tooltip += `Status: Active & Connected${status.isRelaying ? ` (Relayed via :${status.activeTunnelPort})` : ''}\n`;
            } else if (status.remoteProxyReachable && !status.languageServerConfigured) {
                icon = '🟡';
                this.statusBarItem.color = '#e2c08d';
                this.statusBarItem.backgroundColor = undefined;
                tooltip += `Status: Setup Pending\n`;
            } else {
                icon = '🔴';
                this.statusBarItem.color = '#f14c4c';
                this.statusBarItem.backgroundColor = undefined;
                tooltip += `Status: Ingress Offline\n`;
            }
        }

        tooltip += `\nClick to open AG-Wormhole Dashboard`;
        this.statusBarItem.text = `${icon} ${label}`;
        this.statusBarItem.tooltip = tooltip;
    }

    public dispose(): void {
        this.statusBarItem.dispose();
    }
}

