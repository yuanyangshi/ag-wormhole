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
    public static async checkPortAvailable(host: string, port: number, timeoutMs: number = 2500): Promise<boolean> {
        return new Promise((resolve) => {
            const socket = new net.Socket();
            let settled = false;
            const done = (result: boolean) => {
                if (settled) {
                    return;
                }
                settled = true;
                socket.removeAllListeners();
                socket.end();
                socket.destroy();
                resolve(result);
            };
            socket.setTimeout(timeoutMs);
            socket.on('connect', () => done(true));
            socket.on('timeout', () => done(false));
            socket.on('error', () => done(false));
            socket.connect(port, host);
        });
    }

    /**
     * Perform lightweight application-level (L7) health check without external traffic overhead.
     * Verifies that the proxy process is actively accepting and parsing protocol frames.
     */
    public static async checkProxyL7(
        host: string,
        port: number,
        proxyType: string = 'http',
        timeoutMs: number = 3000
    ): Promise<{ ok: boolean; message: string }> {
        return new Promise((resolve) => {
            const socket = new net.Socket();
            let resolved = false;

            const finalize = (ok: boolean, message: string) => {
                if (resolved) {
                    return;
                }
                resolved = true;
                socket.removeAllListeners();
                socket.end();
                socket.destroy();
                resolve({ ok, message });
            };

            socket.setTimeout(timeoutMs);

            socket.on('connect', () => {
                try {
                    if (proxyType.toLowerCase() === 'socks5') {
                        // SOCKS5 greeting: VER=5, NMETHODS=1, METHOD=0 (No Auth)
                        socket.write(Buffer.from([0x05, 0x01, 0x00]));
                    } else {
                        // Minimal local HTTP parser probe (avoids outbound dial errors in Clash/V2Ray logs)
                        socket.write('HEAD / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
                    }
                } catch (err: unknown) {
                    const e = err as { message?: string };
                    finalize(false, `Failed to write L7 probe frame: ${e.message}`);
                }
            });

            socket.on('data', (data) => {
                if (proxyType.toLowerCase() === 'socks5') {
                    if (data.length >= 2 && data[0] === 0x05) {
                        finalize(true, 'SOCKS5 proxy responded with valid greeting handshake');
                    } else {
                        finalize(false, `Unexpected response byte from SOCKS5 listener (0x${data[0]?.toString(16)})`);
                    }
                } else {
                    const resp = data.toString('utf-8');
                    if (resp.startsWith('HTTP/')) {
                        finalize(true, 'HTTP proxy returned valid status line');
                    } else {
                        finalize(false, 'Non-HTTP response received from proxy gateway');
                    }
                }
            });

            socket.on('timeout', () => {
                finalize(false, `L7 proxy handshake timed out after ${timeoutMs}ms`);
            });

            socket.on('error', (err) => {
                finalize(false, `L7 socket connection error: ${err.message}`);
            });

            socket.on('close', () => {
                if (!resolved) {
                    finalize(false, 'Socket closed before L7 handshake response was received');
                }
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
