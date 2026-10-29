/**
 * AG-Wormhole - Tunnel Manager
 * Handles local/remote port connectivity checks and tunnel synchronization
 */

import * as net from 'net';
import { SSHConfigManager } from './sshConfigManager';
import { logger } from '../shared/logger';
import {
    CONFIG_SECTION,
    CFG_ENABLE_LOCAL_FORWARDING,
    CFG_LOCAL_PROXY_PORT,
    CFG_REMOTE_PROXY_PORT,
    DEFAULT_PROXY_PORT
} from '../shared/constants';

export class TunnelManager {
    /**
     * Test TCP connectivity to specified endpoint
     */
    public static async checkPortAvailable(host: string, port: number, timeoutMs: number = 2000): Promise<boolean> {
        return new Promise((resolve) => {
            const socket = new net.Socket();
            socket.setTimeout(timeoutMs);
            socket.on('connect', () => {
                socket.destroy();
                resolve(true);
            });
            socket.on('timeout', () => {
                socket.destroy();
                resolve(false);
            });
            socket.on('error', () => {
                socket.destroy();
                resolve(false);
            });
            socket.connect(port, host);
        });
    }

    /**
     * Synchronize local SSH port forwarding according to VS Code configuration
     */
    public static async syncLocalForwarding(): Promise<{ enabled: boolean; localPort: number; remotePort: number }> {
        let enabled = true;
        let localPort = DEFAULT_PROXY_PORT;
        let remotePort = DEFAULT_PROXY_PORT;

        try {
            const vscode = require('vscode');
            const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
            enabled = config.get(CFG_ENABLE_LOCAL_FORWARDING, true);
            localPort = config.get(CFG_LOCAL_PROXY_PORT, DEFAULT_PROXY_PORT);
            remotePort = config.get(CFG_REMOTE_PROXY_PORT, DEFAULT_PROXY_PORT);
        } catch {
            // Standalone test context
        }

        logger.log(`Syncing local forwarding (enabled=${enabled}, localPort=${localPort}, remotePort=${remotePort})`, true);
        await SSHConfigManager.updateConfigFile(remotePort, localPort, enabled);

        if (enabled) {
            const isLocalReachable = await TunnelManager.checkPortAvailable('127.0.0.1', localPort);
            if (!isLocalReachable) {
                try {
                    const vscode = require('vscode');
                    vscode.window.showWarningMessage(
                        `[AG-Wormhole] Local proxy listener at 127.0.0.1:${localPort} is unreachable. Please verify your local proxy gateway is started.`
                    );
                } catch {
                    // Non-VS Code environment
                }
            }
        }

        return { enabled, localPort, remotePort };
    }
}
