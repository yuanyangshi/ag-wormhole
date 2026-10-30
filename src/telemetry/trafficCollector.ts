/**
 * AG-Wormhole - Traffic Collector & Metrics Engine
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { TrafficStats } from '../shared/types';
import { isRunningRemotely } from '../shared/environment';
import { TunnelWatchdog } from '../core/watchdog';
import {
    CONFIG_SECTION,
    CFG_REMOTE_PROXY_PORT,
    DEFAULT_PROXY_PORT
} from '../shared/constants';

const execAsync = promisify(exec);

export type StatsUpdateCallback = (stats: TrafficStats) => void;

export class TrafficCollector {
    private stats: TrafficStats;
    private refreshInterval: NodeJS.Timeout | undefined;
    private updateCallbacks: StatsUpdateCallback[] = [];
    private peakConnections: number = 0;
    private lastConnections: number = 0;
    private isCollecting: boolean = false;
    private readonly refreshIntervalMs: number = 5000;

    constructor() {
        this.stats = {
            activeConnections: 0,
            totalConnectionsSeen: 0,
            sessionStartTime: new Date(),
            lastUpdated: new Date(),
            proxyReachable: false,
            peakConnections: 0
        };
    }

    public start(): void {
        if (!isRunningRemotely()) {
            return;
        }

        this.stats.sessionStartTime = new Date();
        this.stop();

        this.collect();
        this.refreshInterval = setInterval(() => {
            this.collect();
        }, this.refreshIntervalMs);
    }

    public stop(): void {
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = undefined;
        }
    }

    public onUpdate(callback: StatsUpdateCallback): { dispose(): void } {
        this.updateCallbacks.push(callback);
        return {
            dispose: () => {
                const index = this.updateCallbacks.indexOf(callback);
                if (index >= 0) {
                    this.updateCallbacks.splice(index, 1);
                }
            }
        };
    }

    public dispose(): void {
        this.stop();
        this.updateCallbacks = [];
    }

    public getStats(): TrafficStats {
        return { ...this.stats };
    }

    public async refresh(): Promise<TrafficStats> {
        await this.collect();
        return this.getStats();
    }

    private async collect(): Promise<void> {
        if (this.isCollecting) {
            return;
        }
        this.isCollecting = true;

        try {
            let remoteProxyPort = DEFAULT_PROXY_PORT;
            try {
                const vscode = require('vscode');
                const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
                remoteProxyPort = config.get(CFG_REMOTE_PROXY_PORT, DEFAULT_PROXY_PORT);
            } catch {
                // Standalone test context
            }

            const watchdogMetrics = TunnelWatchdog.getInstance().getMetrics();
            const targetPort = watchdogMetrics.activeTunnelPort || remoteProxyPort;
            this.stats.proxyReachable = watchdogMetrics.state !== 'DISCONNECTED';

            const { activeConnections, avgRttMs } = await this.getConnectionMetrics(targetPort);

            if (activeConnections > this.lastConnections) {
                this.stats.totalConnectionsSeen += (activeConnections - this.lastConnections);
            }
            if (activeConnections > this.peakConnections) {
                this.peakConnections = activeConnections;
            }
            this.lastConnections = activeConnections;

            this.stats.activeConnections = activeConnections;
            this.stats.peakConnections = this.peakConnections;
            this.stats.avgRttMs = avgRttMs;
            this.stats.lastUpdated = new Date();

            for (const callback of this.updateCallbacks) {
                callback(this.getStats());
            }
        } finally {
            this.isCollecting = false;
        }
    }

    private async getConnectionMetrics(port: number): Promise<{ activeConnections: number; avgRttMs?: number }> {
        try {
            const { stdout } = await execAsync(
                `ss -tin state established '( dport = :${port} or sport = :${port} )' 2>/dev/null`,
                { timeout: 5000 }
            );
            const trimmed = stdout.trim();
            if (!trimmed) {
                return { activeConnections: 0 };
            }

            const lines = trimmed.split('\n');
            const socketLines = lines.filter(l => l.includes(`:${port}`));
            const activeConnections = socketLines.length;

            const rttMatches = stdout.match(/rtt:([\d.]+)/g);
            let avgRttMs: number | undefined;
            if (rttMatches && rttMatches.length > 0) {
                const totalRtt = rttMatches.reduce((acc, curr) => {
                    const val = parseFloat(curr.replace('rtt:', ''));
                    return acc + (isNaN(val) ? 0 : val);
                }, 0);
                avgRttMs = Math.round((totalRtt / rttMatches.length) * 10) / 10;
            }

            return { activeConnections, avgRttMs };
        } catch {
            return { activeConnections: 0 };
        }
    }

    public getSessionDuration(): string {
        const now = new Date();
        const diffMs = now.getTime() - this.stats.sessionStartTime.getTime();
        const diffSec = Math.floor(diffMs / 1000);

        const hours = Math.floor(diffSec / 3600);
        const minutes = Math.floor((diffSec % 3600) / 60);
        const seconds = diffSec % 60;

        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }
}

