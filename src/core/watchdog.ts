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
    CMD_RECLAIM_PORT,
    CMD_SHOW_STATUS_PANEL
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
    private fastPathTimers: NodeJS.Timeout[] = [];
    private metrics: WatchdogMetrics;
    private stateChangeCallbacks: ((metrics: WatchdogMetrics) => void)[] = [];
    private isProbing = false;
    private probeCount = 0;
    private checkIntervalMs = 10000; // default 10s non-intrusive probe
    private readonly fastRecoveryIntervalMs = 2500; // 2.5s fast-path self-healing probe
    private readonly failureThreshold = 2; // trigger recovery early after 2 consecutive failures
    private readonly reclaimCooldownMs = 15000; // 15s between automatic port reclaim attempts

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

        this.checkIntervalMs = intervalSec * 1000;
        logger.log(`Starting High-Availability Tunnel Watchdog (interval: ${intervalSec}s, adaptive fast-recovery: 2.5s)`, isRunningLocally());
        
        // Immediate initial check
        this.probe();

        // Fast-path startup burst: probe at 250ms, 750ms, and 1600ms to immediately lock on live reverse tunnels
        const fastDelays = [250, 750, 1600];
        for (const delay of fastDelays) {
            const t = setTimeout(() => {
                this.probe();
            }, delay);
            this.fastPathTimers.push(t);
        }

        this.scheduleNextProbe();
    }

    private scheduleNextProbe(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }

        const isUnhealthy = this.metrics.state === 'DEGRADED' || this.metrics.state === 'DISCONNECTED';
        const delayMs = isUnhealthy ? this.fastRecoveryIntervalMs : this.checkIntervalMs;

        this.timer = setInterval(() => {
            this.probe();
        }, delayMs);
    }

    public stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = undefined;
        }
        for (const ft of this.fastPathTimers) {
            clearTimeout(ft);
        }
        this.fastPathTimers = [];
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
        if (this.isProbing) {
            return this.getMetrics();
        }
        this.isProbing = true;
        this.probeCount++;
        this.metrics.lastChecked = new Date();

        try {
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

            // Autonomous Relay Yielding & Native Port Reclaim Probe:
            // Only yield IngressRelay if an external process (like sshd) is already bound to remotePort
            // or if we never drop the listening socket on remotePort while active sessions rely on it.
            // Keeping IngressRelay continuously bound when relaying eliminates the 150ms+ ECONNREFUSED window
            // during periodic health probes.
            if (isRunningRemotely() && IngressRelay.getInstance().isRelaying() && this.metrics.state === 'HEALTHY') {
                const targetFp = IngressRelay.getInstance().getRelayInfo().targetPort;
                if (targetFp) {
                    const targetL7 = await TunnelManager.checkProxyL7(remoteHost, targetFp, proxyType, 1800);
                    if (!targetL7.ok) {
                        // Current relay target degraded; force immediate re-hunt across fallback cluster
                        logger.log(`Tunnel Watchdog: Relay target port ${targetFp} degraded, re-hunting fallback cluster...`, false);
                    }
                }
            }

            const relayInfo = IngressRelay.getInstance().getRelayInfo();
            const probePort = (isRunningRemotely() && relayInfo.isRelaying && relayInfo.targetPort)
                ? relayInfo.targetPort
                : (isRunningRemotely() ? remotePort : localPort);
            const targetHost = isRunningRemotely() ? remoteHost : '127.0.0.1';

            const isReachable = await TunnelManager.checkPortAvailable(targetHost, probePort, 2500);

            let l7Result: { ok: boolean; message: string } | undefined;
            if (isReachable) {
                // Always run fast L7 verification on remote hosts because a dead/zombie sshd
                // still completes local TCP 3-way handshakes even when the SSH tunnel is dead.
                const shouldRunL7 =
                    isRunningRemotely() ||
                    this.metrics.state !== 'HEALTHY' ||
                    this.metrics.l7Health === undefined ||
                    this.probeCount % 6 === 1;

                if (shouldRunL7) {
                    l7Result = await TunnelManager.checkProxyL7(targetHost, probePort, proxyType, 2200);
                } else {
                    l7Result = {
                        ok: true,
                        message: this.metrics.l7Message || 'Proxy tunnel active'
                    };
                }
            }

            // Autonomous Reconnect Recovery:
            // If primary remote port is unavailable (or held by a dead zombie sshd from a previous session
            // while a new sshd bound to one of the fallback ports), bridge traffic via IngressRelay.
            if (isRunningRemotely() && (!isReachable || !l7Result?.ok)) {
                const wasRelaying = IngressRelay.getInstance().isRelaying();
                const primaryPids = (!wasRelaying && isReachable) ? await Provisioner.getListeningPids(remotePort) : [];
                const fallbackPorts = [remotePort + 1, remotePort + 2, remotePort + 3];
                let recoveredViaFallback = false;

                for (const fp of fallbackPorts) {
                    if (fp === probePort && !isReachable) {
                        continue;
                    }
                    const fpPids = await Provisioner.getListeningPids(fp);
                    // If primary port is reachable and owned by the exact same live sshd PID as the fallback port,
                    // it is NOT a zombie collision; skip failover to avoid disrupting the active session.
                    const sharesSameOwner =
                        primaryPids.length > 0 &&
                        fpPids.length > 0 &&
                        primaryPids.some(pid => fpPids.includes(pid));

                    if (sharesSameOwner) {
                        continue;
                    }

                    const fpReachable = await TunnelManager.checkPortAvailable(remoteHost, fp, 1500);
                    if (fpReachable) {
                        const fpL7 = await TunnelManager.checkProxyL7(remoteHost, fp, proxyType, 2000);
                        if (fpL7.ok) {
                            logger.log(`Tunnel Watchdog: Detected active fallback SSH tunnel on port ${fp}. Auto-healing primary port ${remotePort}...`, false);
                            if (wasRelaying) {
                                IngressRelay.getInstance().updateTargetPort(fp);
                                l7Result = { ok: true, message: `Relayed via active tunnel port ${fp}` };
                                this.metrics.activeTunnelPort = fp;
                                this.metrics.isRelaying = true;
                                recoveredViaFallback = true;
                                break;
                            } else {
                                await Provisioner.reclaimPort(remotePort);
                                const relaySuccess = await IngressRelay.getInstance().startRelay(remotePort, fp, fallbackPorts);
                                if (relaySuccess) {
                                    l7Result = { ok: true, message: `Relayed via active tunnel port ${fp}` };
                                    this.metrics.activeTunnelPort = fp;
                                    this.metrics.isRelaying = true;
                                    recoveredViaFallback = true;
                                    break;
                                }
                            }
                        }
                    }
                }

                // If no fallback port is healthy yet, ensure the Zero-Refusal Ingress Shield remains active
                // on remotePort so incoming requests wait in the buffer rather than getting ECONNREFUSED.
                if (!recoveredViaFallback && !IngressRelay.getInstance().isRelaying()) {
                    await Provisioner.reclaimPort(remotePort);
                    await IngressRelay.getInstance().startRelay(remotePort, remotePort + 1, fallbackPorts);
                }
            }

            // Ping-Pong Standby Port Guard management:
            // When IngressRelay owns remotePort, ensure at least one fallback port (remotePort+2) is
            // reserved in standby while remotePort+1 is unbound, and released once remotePort+1 is bound.
            if (isRunningRemotely() && IngressRelay.getInstance().isRelaying()) {
                const fp1Bound = await TunnelManager.checkPortAvailable(remoteHost, remotePort + 1, 200);
                if (fp1Bound) {
                    await IngressRelay.getInstance().releaseStandbyGuard();
                } else {
                    await IngressRelay.getInstance().ensureStandbyGuard(remotePort + 2);
                }
            }

            const effectiveReachable = isReachable || Boolean(this.metrics.isRelaying && l7Result?.ok);

            const prevState = this.metrics.state;
            if (effectiveReachable && l7Result?.ok) {
                this.metrics.l7Health = true;
                this.metrics.l7Message = l7Result.message;
                this.metrics.activeTunnelPort = IngressRelay.getInstance().isRelaying()
                    ? IngressRelay.getInstance().getRelayInfo().targetPort
                    : (isRunningRemotely() ? remotePort : localPort);
                this.metrics.isRelaying = IngressRelay.getInstance().isRelaying();

                const wasDisconnected = prevState === 'DISCONNECTED';
                if (prevState !== 'HEALTHY') {
                    logger.log(`Tunnel Watchdog: Connection verified HEALTHY (Port ${this.metrics.activeTunnelPort}${this.metrics.isRelaying ? ' via bridge' : ''})`, isRunningLocally());
                }
                this.metrics.consecutiveFailures = 0;
                this.metrics.state = 'HEALTHY';
                this.metrics.reconnectPromptShown = false;

                if (prevState !== 'HEALTHY') {
                    this.scheduleNextProbe();
                }

                if (isRunningLocally()) {
                    try {
                        await TunnelManager.ensureBackgroundTunnelKeepers(localPort, remotePort, true);
                    } catch {
                        // Ignore keeper check error in standalone test context
                    }
                }

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
            } else if (effectiveReachable && !l7Result?.ok) {
                this.metrics.l7Health = false;
                this.metrics.l7Message = l7Result?.message || 'L7 handshake failed';
                this.metrics.consecutiveFailures++;
                if (isRunningRemotely() && this.metrics.consecutiveFailures >= this.failureThreshold) {
                    this.metrics.state = 'DISCONNECTED';
                    await this.handleTunnelDisconnection(remotePort);
                } else {
                    this.metrics.state = 'DEGRADED';
                }
                if (prevState === 'HEALTHY') {
                    this.scheduleNextProbe();
                }
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
                if (prevState === 'HEALTHY') {
                    this.scheduleNextProbe();
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
        } finally {
            this.isProbing = false;
        }
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

            const now = Date.now();
            const lastAttemptMs = this.metrics.lastRecoveryAttempt?.getTime() ?? 0;
            const cooldownElapsed = now - lastAttemptMs >= this.reclaimCooldownMs;

            // Attempt autonomous zombie port reclamation on remote failure (respecting cooldown)
            // Automatically clears all ports across the forwarding cluster (primary, fallbacks, and keeper)
            if (autoReclaim && cooldownElapsed) {
                this.metrics.lastRecoveryAttempt = new Date();
                logger.log(`Tunnel Watchdog: Autonomous self-healing triggered for remote ports ${remotePort}-${remotePort + 3}`, false);
                const result = await Provisioner.reclaimPortRange(remotePort, 4);
                if (result.success && result.pidsKilled.length > 0) {
                    logger.log(`Tunnel Watchdog: Terminated ${result.pidsKilled.length} zombie process(es): ${result.pidsKilled.join(', ')}`, false);
                }
                if (!IngressRelay.getInstance().isRelaying()) {
                    await IngressRelay.getInstance().startRelay(
                        remotePort,
                        remotePort + 1,
                        [remotePort + 1, remotePort + 2, remotePort + 3]
                    );
                }
            }

            // Show non-intrusive notification only after prolonged outage (>= 8 probes, ~80s)
            // Informing user that background self-healing is running, without requiring manual intervention.
            if (this.metrics.consecutiveFailures >= 8 && !this.metrics.reconnectPromptShown) {
                this.metrics.reconnectPromptShown = true;
                try {
                    const vscode = require('vscode');
                    vscode.window.showWarningMessage(
                        '[AG-Wormhole] Proxy tunnel unreachable (background self-healing is active). If local proxy (Clash/v2ray) is stopped, please restart it.',
                        'Run Diagnostics',
                        'Open Dashboard'
                    ).then((action: string | undefined) => {
                        if (action === 'Run Diagnostics') {
                            vscode.commands.executeCommand('ag-wormhole.diagnose');
                        } else if (action === 'Open Dashboard') {
                            vscode.commands.executeCommand(CMD_SHOW_STATUS_PANEL);
                        }
                    });
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
