/**
 * AG-Wormhole - Tunnel Watchdog & Self-Healing Engine
 * Actively monitors tunnel health, mitigates dead connections, and orchestrates auto-recovery.
 */

import { logger } from '../shared/logger';
import { TunnelManager } from './tunnelManager';
import { SSHConfigManager } from './sshConfigManager';
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
    CFG_SUPPRESS_UNREACHABLE_WARNING,
    DEFAULT_PROXY_HOST,
    DEFAULT_PROXY_PORT,
    DEFAULT_PROXY_TYPE,
    DEFAULT_WATCHDOG_INTERVAL_SEC,
    ALL_FALLBACK_PORT_OFFSETS,
    CMD_RECLAIM_PORT,
    CMD_SHOW_STATUS_PANEL,
    CMD_BYPASS_TERMINAL_PROXY
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
    isProlongedOutage?: boolean;
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
    private isMutedForSession = false;
    private probeCount = 0;
    private checkIntervalMs = 10000; // default 10s non-intrusive probe
    private readonly fastRecoveryIntervalMs = 2500; // 2.5s fast-path self-healing probe
    private readonly backoffIntervalMs = 30000; // 30s smart backoff probe during prolonged outages
    private readonly failureThreshold = 2; // trigger recovery early after 2 consecutive failures
    private readonly prolongedFailureThreshold = 12; // ~1 minute persistent failure, enter smart backoff
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
        const isProlonged = (this.metrics.consecutiveFailures || 0) >= this.prolongedFailureThreshold;
        let delayMs = this.checkIntervalMs;
        if (isProlonged) {
            delayMs = this.backoffIntervalMs;
        } else if (isUnhealthy) {
            delayMs = this.fastRecoveryIntervalMs;
        }

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

    public muteSession(): void {
        this.isMutedForSession = true;
    }

    public unmuteSession(): void {
        this.isMutedForSession = false;
    }

    public isMuted(): boolean {
        return this.isMutedForSession;
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

            if (isRunningLocally()) {
                try {
                    const sshStatus = await SSHConfigManager.getStatus();
                    if (sshStatus.enabled && sshStatus.localPort) {
                        localPort = sshStatus.localPort;
                    }
                } catch {
                    // Use configured localPort
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
                const fallbackPorts = ALL_FALLBACK_PORT_OFFSETS.map(o => remotePort + o);
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
                                await Provisioner.reclaimPort(remotePort, remotePort);
                                const relaySuccess = await IngressRelay.getInstance().startRelay(remotePort, fp, fallbackPorts);
                                if (relaySuccess) {
                                    l7Result = { ok: true, message: `Relayed via active tunnel port ${fp}` };
                                    this.metrics.activeTunnelPort = fp;
                                    this.metrics.isRelaying = true;
                                    recoveredViaFallback = true;
                                    break;
                                } else {
                                    // Another Extension Host's IngressRelay or a newly bound sshd already holds remotePort.
                                    // Re-verify primary port L7 or treat the verified fallback tunnel as healthy without EADDRINUSE loops.
                                    const primaryRecheck = await TunnelManager.checkProxyL7(remoteHost, remotePort, proxyType, 1800);
                                    if (primaryRecheck.ok) {
                                        l7Result = primaryRecheck;
                                        this.metrics.activeTunnelPort = remotePort;
                                    } else {
                                        l7Result = { ok: true, message: `Active tunnel verified on fallback port ${fp}` };
                                        this.metrics.activeTunnelPort = fp;
                                    }
                                    this.metrics.isRelaying = false;
                                    recoveredViaFallback = true;
                                    break;
                                }
                            }
                        }
                    }
                }

                // If no fallback port is healthy, never blindly seize remotePort into a dead loop.
                // Instead, stop any existing dead relay to keep remotePort completely unblocked
                // for native incoming SSH reverse port forwards.
                if (!recoveredViaFallback) {
                    if (wasRelaying) {
                        logger.log(`Tunnel Watchdog: All fallback ports offline. Releasing IngressRelay on port ${remotePort}...`, false);
                        await IngressRelay.getInstance().stopRelay();
                        this.metrics.isRelaying = false;
                    }
                    await Provisioner.reclaimPort(remotePort, remotePort);
                }
            }

            const effectiveReachable = isReachable || Boolean(l7Result?.ok);

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
                this.metrics.isProlongedOutage = false;

                if (prevState !== 'HEALTHY') {
                    this.scheduleNextProbe();
                }

                if (isRunningLocally()) {
                    try {
                        await TunnelManager.ensureBackgroundTunnelKeepers(localPort, remotePort, true);
                    } catch {
                        // Ignore keeper check error in standalone test context
                    }
                } else if (this.probeCount % 30 === 15) {
                    // Periodically reap any orphaned PPid=1 runtime processes (e.g. agy --hub from closed windows)
                    Provisioner.reapOrphanProcesses().catch(() => {});
                }

                if (wasDisconnected && isRunningLocally()) {
                    // Auto-sync silently when local gateway is brought back online (no intrusive popup)
                    try {
                        await TunnelManager.syncLocalForwarding(true);
                        logger.log(`Local proxy listener at 127.0.0.1:${localPort} recovered; tunnel synchronized.`, true);
                    } catch {
                        // Non-extension environment
                    }
                }
            } else if (effectiveReachable && !l7Result?.ok) {
                this.metrics.l7Health = false;
                this.metrics.l7Message = l7Result?.message || 'L7 handshake failed';
                this.metrics.consecutiveFailures++;
                const isFirstProlonged = this.metrics.consecutiveFailures === this.prolongedFailureThreshold;
                if (this.metrics.consecutiveFailures >= this.prolongedFailureThreshold) {
                    this.metrics.isProlongedOutage = true;
                }
                if (isRunningRemotely() && this.metrics.consecutiveFailures >= this.failureThreshold) {
                    this.metrics.state = 'DISCONNECTED';
                    await this.handleTunnelDisconnection(remotePort);
                } else {
                    this.metrics.state = 'DEGRADED';
                }
                if (prevState === 'HEALTHY' || isFirstProlonged) {
                    this.scheduleNextProbe();
                }
                logger.log(`Tunnel Watchdog: Port open but L7 proxy probe degraded: ${this.metrics.l7Message}`, isRunningLocally());
            } else {
                this.metrics.l7Health = false;
                this.metrics.l7Message = 'All ingress tunnel ports unreachable';
                this.metrics.consecutiveFailures++;
                const isFirstProlonged = this.metrics.consecutiveFailures === this.prolongedFailureThreshold;
                if (this.metrics.consecutiveFailures >= this.prolongedFailureThreshold) {
                    this.metrics.isProlongedOutage = true;
                }
                if (this.metrics.consecutiveFailures >= this.failureThreshold) {
                    this.metrics.state = 'DISCONNECTED';
                    await this.handleTunnelDisconnection(remotePort);
                } else {
                    this.metrics.state = 'DEGRADED';
                }
                if (prevState === 'HEALTHY' || isFirstProlonged) {
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
            const isProlonged = (this.metrics.consecutiveFailures || 0) >= this.prolongedFailureThreshold;

            // Attempt autonomous zombie port reclamation on remote failure (respecting cooldown)
            // If outage is prolonged (user is connected in direct mode without local IDE), avoid thrashing port reclamation
            if (autoReclaim && cooldownElapsed && !isProlonged) {
                this.metrics.lastRecoveryAttempt = new Date();
                const clusterRange = ALL_FALLBACK_PORT_OFFSETS.length + 1;
                logger.log(`Tunnel Watchdog: Autonomous self-healing triggered for remote ports ${remotePort}-${remotePort + clusterRange - 1}`, false);
                const result = await Provisioner.reclaimPortRange(remotePort, clusterRange);
                if (result.success && result.pidsKilled.length > 0) {
                    logger.log(`Tunnel Watchdog: Terminated ${result.pidsKilled.length} zombie process(es): ${result.pidsKilled.join(', ')}`, false);
                }
                // Verify if any fallback port is alive before starting relay
                const fallbackPorts = ALL_FALLBACK_PORT_OFFSETS.map(o => remotePort + o);
                let liveFp: number | undefined;
                for (const fp of fallbackPorts) {
                    if (await TunnelManager.checkPortAvailable('127.0.0.1', fp, 200)) {
                        const fpL7 = await TunnelManager.checkProxyL7('127.0.0.1', fp, 'http', 300);
                        if (fpL7.ok) {
                            liveFp = fp;
                            break;
                        }
                    }
                }

                if (liveFp) {
                    if (!IngressRelay.getInstance().isRelaying()) {
                        await IngressRelay.getInstance().startRelay(remotePort, liveFp, fallbackPorts);
                    }
                } else if (IngressRelay.getInstance().isRelaying()) {
                    await IngressRelay.getInstance().stopRelay();
                }
            }

            let suppressWarning = false;
            try {
                const vscode = require('vscode');
                const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
                suppressWarning = config.get(CFG_SUPPRESS_UNREACHABLE_WARNING, false);
            } catch {
                // Default false
            }

            // Show non-intrusive notification only after prolonged outage (>= 8 probes, ~80s)
            // If muted for this session or explicitly suppressed by user, skip notification
            if (this.metrics.consecutiveFailures >= 8 && !this.metrics.reconnectPromptShown && !this.isMutedForSession && !suppressWarning) {
                this.metrics.reconnectPromptShown = true;
                try {
                    const vscode = require('vscode');
                    vscode.window.showWarningMessage(
                        '[AG-Wormhole] Proxy tunnel unreachable. Ensure local proxy (Clash/v2ray) is running and local IDE/SSH reverse tunnel is active.',
                        'Switch to Direct Mode',
                        'Mute Session',
                        'Open Dashboard'
                    ).then((action: string | undefined) => {
                        if (action === 'Switch to Direct Mode') {
                            vscode.commands.executeCommand(CMD_BYPASS_TERMINAL_PROXY);
                        } else if (action === 'Mute Session') {
                            this.muteSession();
                            vscode.window.showInformationMessage('[AG-Wormhole] Unreachable warnings muted for this session. Link status is tracked in the status bar.');
                        } else if (action === 'Open Dashboard') {
                            vscode.commands.executeCommand(CMD_SHOW_STATUS_PANEL);
                        }
                    });
                } catch {
                    // Non-extension environment
                }
            }
        } else {
            // In local environment, attempt silent auto-sync of SSH config (respecting cooldown)
            const now = Date.now();
            const lastAttemptMs = this.metrics.lastRecoveryAttempt?.getTime() ?? 0;
            if (now - lastAttemptMs >= this.reclaimCooldownMs) {
                this.metrics.lastRecoveryAttempt = new Date();
                try {
                    await TunnelManager.syncLocalForwarding(true);
                } catch (err) {
                    logger.log(`Tunnel Watchdog auto-sync failed: ${err}`, true);
                }
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
