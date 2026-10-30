/**
 * AG-Wormhole - Tunnel Watchdog & Self-Healing Engine
 * Actively monitors tunnel health, mitigates dead connections, and orchestrates auto-recovery.
 */

import { logger } from '../shared/logger';
import { TunnelManager } from './tunnelManager';
import { Provisioner } from './provisioner';
import { IngressRelay } from './ingressRelay';
import { isRunningRemotely, isRunningLocally } from '../shared/environment';
import {
    CONFIG_SECTION,
    CFG_REMOTE_PROXY_HOST,
    CFG_REMOTE_PROXY_PORT,
    CFG_LOCAL_PROXY_PORT,
    CFG_WATCHDOG_INTERVAL,
    CFG_AUTO_RECLAIM_PORT,
    CFG_PROXY_TYPE,
    DEFAULT_PROXY_HOST,
    DEFAULT_PROXY_PORT,
    DEFAULT_PROXY_TYPE,
    DEFAULT_WATCHDOG_INTERVAL_SEC,
    CMD_RECLAIM_PORT
} from '../shared/constants';

export type TunnelHealthState = 'HEALTHY' | 'DEGRADED' | 'DISCONNECTED';

export interface WatchdogMetrics {
    state: TunnelHealthState;
    consecutiveFailures: number;
    lastChecked: Date;
    lastRecoveryAttempt?: Date;
    reconnectPromptShown: boolean;
    l7Health?: boolean;
    l7Message?: string;
    activeTunnelPort?: number;
    isRelaying?: boolean;
}

export interface IDisposable {
    dispose(): void;
}

export class TunnelWatchdog {
    private static instance: TunnelWatchdog;
    private timer?: NodeJS.Timeout;
    private metrics: WatchdogMetrics;
    private stateChangeCallbacks: ((metrics: WatchdogMetrics) => void)[] = [];
    private readonly checkIntervalMs = 10000; // 10s non-intrusive probe
    private readonly failureThreshold = 2; // trigger recovery after 2 consecutive failures

    private constructor() {
        this.metrics = {
            state: 'HEALTHY',
            consecutiveFailures: 0,
            lastChecked: new Date(),
            reconnectPromptShown: false
        };
    }

    public static getInstance(): TunnelWatchdog {
        if (!TunnelWatchdog.instance) {
            TunnelWatchdog.instance = new TunnelWatchdog();
        }
        return TunnelWatchdog.instance;
    }

    public start(): void {
        this.stop();
        let intervalSec = DEFAULT_WATCHDOG_INTERVAL_SEC;
        try {
            const vscode = require('vscode');
            const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
            intervalSec = Math.max(3, Math.min(60, config.get(CFG_WATCHDOG_INTERVAL, DEFAULT_WATCHDOG_INTERVAL_SEC)));
        } catch {
            // Standalone test context
        }

        const intervalMs = intervalSec * 1000;
        logger.log(`Starting High-Availability Tunnel Watchdog (interval: ${intervalSec}s)`, isRunningLocally());
        
        // Immediate initial check
        this.probe();

        this.timer = setInterval(() => {
            this.probe();
        }, intervalMs);
    }

    public stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
    }

    public onStateChange(callback: (metrics: WatchdogMetrics) => void): IDisposable {
        this.stateChangeCallbacks.push(callback);
        return {
            dispose: () => {
                const index = this.stateChangeCallbacks.indexOf(callback);
                if (index >= 0) {
                    this.stateChangeCallbacks.splice(index, 1);
                }
            }
        };
    }

    public getMetrics(): WatchdogMetrics {
        return { ...this.metrics };
    }

    /**
     * Actively probe tunnel endpoints and handle degradation
     */
    public async probe(): Promise<WatchdogMetrics> {
        this.metrics.lastChecked = new Date();

        let remoteHost = DEFAULT_PROXY_HOST;
        let remotePort = DEFAULT_PROXY_PORT;
        let localPort = DEFAULT_PROXY_PORT;
        let proxyType = DEFAULT_PROXY_TYPE;

        try {
            const vscode = require('vscode');
            const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
            remoteHost = config.get(CFG_REMOTE_PROXY_HOST, DEFAULT_PROXY_HOST);
            remotePort = config.get(CFG_REMOTE_PROXY_PORT, DEFAULT_PROXY_PORT);
            localPort = config.get(CFG_LOCAL_PROXY_PORT, DEFAULT_PROXY_PORT);
            proxyType = config.get(CFG_PROXY_TYPE, DEFAULT_PROXY_TYPE);
        } catch {
            // Fallback for non-vscode standalone execution
        }

        let isReachable = false;
        const targetHost = isRunningRemotely() ? remoteHost : '127.0.0.1';
        const targetPort = isRunningRemotely() ? remotePort : localPort;

        if (isRunningRemotely()) {
            isReachable = await TunnelManager.checkPortAvailable(remoteHost, remotePort, 2000);
        } else {
            isReachable = await TunnelManager.checkPortAvailable('127.0.0.1', localPort, 2000);
        }

        let l7Result: { ok: boolean; message: string } | undefined;
        if (isReachable) {
            l7Result = await TunnelManager.checkProxyL7(targetHost, targetPort, proxyType, 2000);
        }

        // Autonomous Reconnect Recovery:
        // If primary remote port is unavailable or degraded (e.g. following an abrupt SSH disconnect/reconnect),
        // check whether OpenSSH bound to one of the fallback ports in the resilience pool.
        if (isRunningRemotely() && (!isReachable || !l7Result?.ok)) {
            const fallbackPorts = [remotePort + 1, remotePort + 2];
            for (const fp of fallbackPorts) {
                const fpReachable = await TunnelManager.checkPortAvailable(remoteHost, fp, 1500);
                if (fpReachable) {
                    const fpL7 = await TunnelManager.checkProxyL7(remoteHost, fp, proxyType, 1500);
                    if (fpL7.ok) {
                        logger.log(`Tunnel Watchdog: Detected active fallback SSH tunnel on port ${fp}. Auto-healing primary port ${remotePort}...`, false);
                        await Provisioner.reclaimPort(remotePort);
                        const relaySuccess = await IngressRelay.getInstance().startRelay(remotePort, fp);
                        if (relaySuccess) {
                            isReachable = true;
                            l7Result = { ok: true, message: `Relayed via active tunnel port ${fp}` };
                            this.metrics.activeTunnelPort = fp;
                            this.metrics.isRelaying = true;
                            break;
                        }
                    }
                }
            }
        }

        if (isReachable && l7Result?.ok) {
            this.metrics.l7Health = true;
            this.metrics.l7Message = l7Result.message;
            this.metrics.activeTunnelPort = this.metrics.activeTunnelPort || (isRunningRemotely() ? remotePort : localPort);
            this.metrics.isRelaying = IngressRelay.getInstance().isRelaying();

            const wasDisconnected = this.metrics.state === 'DISCONNECTED';
            if (this.metrics.state !== 'HEALTHY') {
                logger.log(`Tunnel Watchdog: Connection verified HEALTHY (Port ${this.metrics.activeTunnelPort}${this.metrics.isRelaying ? ' via bridge' : ''})`, isRunningLocally());
            }
            this.metrics.consecutiveFailures = 0;
            this.metrics.state = 'HEALTHY';
            this.metrics.reconnectPromptShown = false;

            if (wasDisconnected && isRunningLocally()) {
                // Auto-sync when local gateway is brought back online
                try {
                    await TunnelManager.syncLocalForwarding();
                    const vscode = require('vscode');
                    vscode.window.showInformationMessage(
                        `[AG-Wormhole] Local proxy listener at 127.0.0.1:${localPort} recovered! Tunnel synchronized.`
                    );
                } catch {
                    // Non-extension environment
                }
            }
        } else if (isReachable && !l7Result?.ok) {
            this.metrics.l7Health = false;
            this.metrics.l7Message = l7Result?.message || 'L7 handshake failed';
            this.metrics.state = 'DEGRADED';
            logger.log(`Tunnel Watchdog: Port open but L7 proxy probe degraded: ${this.metrics.l7Message}`, isRunningLocally());
        } else {
            this.metrics.l7Health = false;
            this.metrics.l7Message = 'All ingress tunnel ports unreachable';
            this.metrics.consecutiveFailures++;
            if (this.metrics.consecutiveFailures >= this.failureThreshold) {
                this.metrics.state = 'DISCONNECTED';
                await this.handleTunnelDisconnection(remotePort);
            } else {
                this.metrics.state = 'DEGRADED';
            }
            logger.log(
                `Tunnel Watchdog probe failed (consecutive failures: ${this.metrics.consecutiveFailures})`,
                isRunningLocally()
            );
        }

        for (const cb of this.stateChangeCallbacks) {
            cb(this.getMetrics());
        }

        return this.getMetrics();
    }

    /**
     * Self-healing logic when tunnel disconnection is detected
     */
    private async handleTunnelDisconnection(remotePort: number): Promise<void> {
        if (isRunningRemotely()) {
            let autoReclaim = true;
            try {
                const vscode = require('vscode');
                const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
                autoReclaim = config.get(CFG_AUTO_RECLAIM_PORT, true);
            } catch {
                // Default true
            }

            // Attempt autonomous zombie port reclamation on remote failure
            if (autoReclaim) {
                this.metrics.lastRecoveryAttempt = new Date();
                logger.log(`Tunnel Watchdog: Autonomous self-healing triggered for remote port ${remotePort}`, false);
                const result = await Provisioner.reclaimPort(remotePort);
                if (result.success && result.pidsKilled.length > 0) {
                    logger.log(`Tunnel Watchdog: Terminated ${result.pidsKilled.length} zombie process(es)`, false);
                }
            }

            // Show reconnect notification only after prolonged outage (>= 4 probes, ~40s)
            // to allow transient SSH auto-reconnect and IngressRelay recovery without disruption.
            if (this.metrics.consecutiveFailures >= 4 && !this.metrics.reconnectPromptShown) {
                this.metrics.reconnectPromptShown = true;
                try {
                    const vscode = require('vscode');
                    const action = await vscode.window.showErrorMessage(
                        '[AG-Wormhole] Remote proxy tunnel lost! SSH reverse forwarding is unreachable.',
                        'Reclaim Port',
                        'Run Diagnostics',
                        'Reload Window'
                    );

                    if (action === 'Reclaim Port') {
                        await vscode.commands.executeCommand(CMD_RECLAIM_PORT);
                    } else if (action === 'Run Diagnostics') {
                        await vscode.commands.executeCommand('ag-wormhole.diagnose');
                    } else if (action === 'Reload Window') {
                        await vscode.commands.executeCommand('workbench.action.reloadWindow');
                    }
                } catch {
                    // Non-extension environment
                }
            }
        } else {
            // In local environment, attempt auto-sync of SSH config
            this.metrics.lastRecoveryAttempt = new Date();
            try {
                await TunnelManager.syncLocalForwarding();
            } catch (err) {
                logger.log(`Tunnel Watchdog auto-sync failed: ${err}`, true);
            }
        }
    }

    /**
     * Trigger manual zombie port reclamation
     */
    public async reclaimRemotePort(port?: number): Promise<{ success: boolean; message: string }> {
        const targetPort = port ?? DEFAULT_PROXY_PORT;
        return Provisioner.reclaimPort(targetPort);
    }
}
