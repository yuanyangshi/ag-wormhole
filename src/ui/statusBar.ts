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
        let text = '$(plug) Wormhole: ';
        let tooltip = 'AG-Wormhole Control Center\n\n';

        if (isLocal) {
            tooltip += `Location: Local\n`;
            tooltip += `SSH Reverse Forwarding: ${status.sshConfigEnabled ? 'Active' : 'Disabled'}\n`;
            tooltip += `Local Proxy (127.0.0.1:${status.localProxyPort}): ${status.localProxyReachable ? 'Reachable' : 'Unreachable'}\n`;

            if (status.sshConfigEnabled && status.localProxyReachable) {
                text += `$(check) Local Active (Port ${status.remoteProxyPort})`;
                this.statusBarItem.backgroundColor = undefined;
            } else if (!status.sshConfigEnabled) {
                text += `$(circle-slash) Disabled`;
                this.statusBarItem.backgroundColor = undefined;
            } else {
                text += `$(warning) Proxy Unreachable`;
                this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            }
        } else {
            tooltip += `Location: Remote\n`;
            tooltip += `Ingress Endpoint (${status.remoteProxyHost}:${status.remoteProxyPort}): ${status.remoteProxyReachable ? 'Reachable' : 'Unreachable'}\n`;
            tooltip += `Language Server Interception: ${status.languageServerConfigured ? 'Injected' : 'Pending'}\n`;

            if (status.remoteProxyReachable && status.languageServerConfigured) {
                text += `$(check) Remote Active`;
                this.statusBarItem.backgroundColor = undefined;
            } else if (status.remoteProxyReachable && !status.languageServerConfigured) {
                text += `$(gear) Setup Pending`;
                this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            } else {
                text += `$(error) Ingress Offline`;
                this.statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
            }
        }

        tooltip += `\nClick to open AG-Wormhole Dashboard`;
        this.statusBarItem.text = text;
        this.statusBarItem.tooltip = tooltip;
    }

    public dispose(): void {
        this.statusBarItem.dispose();
    }
}

