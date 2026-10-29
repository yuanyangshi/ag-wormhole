/**
 * AG-Wormhole - Traffic Collector & Metrics Engine
 */

import * as vscode from 'vscode';
import * as net from 'net';
import { exec } from 'child_process';
import { promisify } from 'util';
import { TrafficStats } from '../shared/types';
import { isRunningRemotely } from '../shared/environment';
import {
    CONFIG_SECTION,
    CFG_REMOTE_PROXY_HOST,
    CFG_REMOTE_PROXY_PORT,
    DEFAULT_PROXY_HOST,
    DEFAULT_PROXY_PORT
} from '../shared/constants';

const execAsync = promisify(exec);

export type StatsUpdateCallback = (stats: TrafficStats) => void;

export class TrafficCollector {
    private stats: TrafficStats;
    private refreshInterval: NodeJS.Timeout | undefined;
    private updateCallbacks: StatsUpdateCallback[] = [];
    private peakConnections: number = 0;
    private readonly refreshIntervalMs: number = 2000;

    constructor() {
        this.stats = {
            activeConnections: 0,
            totalConnectionsSeen: 0,
            sessionStartTime: new Date(),
            lastUpdated: new Date(),
            proxyReachable: false
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

    public onUpdate(callback: StatsUpdateCallback): vscode.Disposable {
        this.updateCallbacks.push(callback);
        return new vscode.Disposable(() => {
            const index = this.updateCallbacks.indexOf(callback);
            if (index >= 0) {
                this.updateCallbacks.splice(index, 1);
            }
        });
    }

    public getStats(): TrafficStats {
        return { ...this.stats };
    }

    public async refresh(): Promise<TrafficStats> {
        await this.collect();
        return this.getStats();
    }

    private async collect(): Promise<void> {
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
        const remoteProxyHost = config.get<string>(CFG_REMOTE_PROXY_HOST, DEFAULT_PROXY_HOST);
        const remoteProxyPort = config.get<number>(CFG_REMOTE_PROXY_PORT, DEFAULT_PROXY_PORT);

        this.stats.proxyReachable = await this.checkPort(remoteProxyHost, remoteProxyPort);
        const activeConnections = await this.getActiveConnections(remoteProxyPort);

        if (activeConnections > this.peakConnections) {
            this.stats.totalConnectionsSeen += (activeConnections - this.peakConnections);
            this.peakConnections = activeConnections;
        } else if (activeConnections < this.peakConnections) {
            this.stats.totalConnectionsSeen += this.peakConnections - activeConnections;
            this.peakConnections = activeConnections;
        }

        this.stats.activeConnections = activeConnections;
        this.stats.lastUpdated = new Date();

        for (const callback of this.updateCallbacks) {
            callback(this.getStats());
        }
    }

    private async getActiveConnections(port: number): Promise<number> {
        try {
            const { stdout } = await execAsync(
                `ss -tn state established '( dport = :${port} or sport = :${port} )' 2>/dev/null | tail -n +2 | wc -l`,
                { timeout: 5000 }
            );
            const count = parseInt(stdout.trim(), 10);
            return isNaN(count) ? 0 : count;
        } catch {
            return 0;
        }
    }

    private checkPort(host: string, port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const socket = new net.Socket();
            socket.setTimeout(2000);
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

    public getSessionDuration(): string {
        const now = new Date();
        const diffMs = now.getTime() - this.stats.sessionStartTime.getTime();
        const diffSec = Math.floor(diffMs / 1000);

        const hours = Math.floor(diffSec / 3600);
        const minutes = Math.floor((diffSec % 3600) / 60);
        const seconds = diffSec % 60;

        return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    }

    public dispose(): void {
        this.stop();
        this.updateCallbacks = [];
    }
}

