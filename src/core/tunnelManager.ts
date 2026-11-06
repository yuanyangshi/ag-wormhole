/**
 * AG-Wormhole - Tunnel Manager
 * Handles local/remote port connectivity checks and tunnel synchronization
 */

import * as net from 'net';
import { exec, spawn, ChildProcess } from 'child_process';
import { promisify } from 'util';
import { SSHConfigManager } from './sshConfigManager';
import { logger } from '../shared/logger';
import { isRunningLocally } from '../shared/environment';
import {
    CONFIG_SECTION,
    CFG_ENABLE_LOCAL_FORWARDING,
    CFG_LOCAL_PROXY_PORT,
    CFG_REMOTE_PROXY_PORT,
    DEFAULT_PROXY_PORT
} from '../shared/constants';

const execAsync = promisify(exec);

export class TunnelManager {
    private static isSyncingKeepers = false;
    private static lastKeeperSyncMs = 0;
    private static localUnreachableWarned = false;
    private static activeKeeperChildren = new Map<string, ChildProcess>();
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
     * Includes dual-protocol adaptive fallback (HTTP <-> SOCKS5) to prevent false alerts.
     */
    public static async checkProxyL7(
        host: string,
        port: number,
        proxyType: string = 'http',
        timeoutMs: number = 3000
    ): Promise<{ ok: boolean; message: string }> {
        const primaryResult = await TunnelManager.checkProxyL7Single(host, port, proxyType, timeoutMs);
        if (primaryResult.ok) {
            return primaryResult;
        }

        // Adaptive protocol fallback: if primary protocol failed or misconfigured, try alternate
        const alternateType = proxyType.toLowerCase() === 'socks5' ? 'http' : 'socks5';
        const fallbackResult = await TunnelManager.checkProxyL7Single(host, port, alternateType, Math.min(timeoutMs, 1500));
        if (fallbackResult.ok) {
            return {
                ok: true,
                message: `${fallbackResult.message} (auto-adapted to ${alternateType.toUpperCase()})`
            };
        }

        return primaryResult;
    }

    private static async checkProxyL7Single(
        host: string,
        port: number,
        proxyType: string,
        timeoutMs: number
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
     * Scan candidate ports to automatically discover active local proxy listeners
     */
    public static async discoverLocalProxyPort(
        preferredPort: number,
        candidatePorts: number[] = [7890, 7897, 10809, 10808, 2080, 1080]
    ): Promise<number | null> {
        // 1. Try preferred port first
        if (await TunnelManager.checkPortAvailable('127.0.0.1', preferredPort, 800)) {
            const l7 = await TunnelManager.checkProxyL7('127.0.0.1', preferredPort, 'http', 1000);
            if (l7.ok) {
                return preferredPort;
            }
        }

        // 2. Scan remaining candidate ports
        for (const port of candidatePorts) {
            if (port === preferredPort) {
                continue;
            }
            const isAvail = await TunnelManager.checkPortAvailable('127.0.0.1', port, 500);
            if (isAvail) {
                const l7 = await TunnelManager.checkProxyL7('127.0.0.1', port, 'http', 800);
                if (l7.ok) {
                    return port;
                }
            }
        }

        return null;
    }

    /**
     * Synchronize local SSH port forwarding according to VS Code configuration
     */
    public static async syncLocalForwarding(silent: boolean = false): Promise<{ enabled: boolean; localPort: number; remotePort: number }> {
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

        let effectiveLocalPort = localPort;
        if (enabled) {
            // Autonomous local proxy detection: if configured local port is down, auto-discover active ports
            const discovered = await TunnelManager.discoverLocalProxyPort(localPort);
            if (discovered && discovered !== localPort) {
                logger.log(
                    `Autonomous Local Proxy Discovery: detected active proxy on 127.0.0.1:${discovered} (configured: ${localPort}). Auto-adapting SSH tunnel target.`,
                    true
                );
                effectiveLocalPort = discovered;
            }
        }

        logger.log(`Syncing local forwarding (enabled=${enabled}, localPort=${effectiveLocalPort}, remotePort=${remotePort})`, true);
        await SSHConfigManager.updateConfigFile(remotePort, effectiveLocalPort, enabled);

        if (enabled) {
            const isLocalReachable = await TunnelManager.checkPortAvailable('127.0.0.1', effectiveLocalPort);
            if (!isLocalReachable) {
                if (!silent && !TunnelManager.localUnreachableWarned) {
                    TunnelManager.localUnreachableWarned = true;
                    try {
                        const vscode = require('vscode');
                        vscode.window.showWarningMessage(
                            `[AG-Wormhole] Local proxy listener at 127.0.0.1:${effectiveLocalPort} is unreachable. Please verify your local proxy gateway is started.`
                        );
                    } catch {
                        // Non-VS Code environment
                    }
                }
            } else {
                TunnelManager.localUnreachableWarned = false;
                if (isRunningLocally()) {
                    await TunnelManager.ensureBackgroundTunnelKeepers(effectiveLocalPort, remotePort, true, true);
                }
            }
        } else if (isRunningLocally()) {
            await TunnelManager.ensureBackgroundTunnelKeepers(effectiveLocalPort, remotePort, false, true);
        }

        return { enabled, localPort: effectiveLocalPort, remotePort };
    }

    /**
     * Parse an SSH client command line to extract the destination host and identify keeper processes
     */
    public static parseSshCommandDestination(cmdLine: string): { host: string; isKeeper: boolean } | null {
        if (!cmdLine || !cmdLine.trim()) {
            return null;
        }

        const tokens: string[] = [];
        const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(cmdLine)) !== null) {
            tokens.push(match[1] ?? match[2] ?? match[3]);
        }

        if (tokens.length < 2) {
            return null;
        }

        const exe = tokens[0].toLowerCase().replace(/\\/g, '/');
        if (exe !== 'ssh' && exe !== 'ssh.exe' && !exe.endsWith('/ssh') && !exe.endsWith('/ssh.exe')) {
            return null;
        }

        const isKeeper =
            cmdLine.includes('AG_WORMHOLE_KEEPER') ||
            (cmdLine.includes('ClearAllForwardings=yes') && tokens.includes('-N'));

        const argFlags = new Set([
            '-B', '-b', '-c', '-D', '-E', '-e', '-F', '-I', '-i', '-J',
            '-L', '-l', '-m', '-O', '-o', '-p', '-Q', '-R', '-S', '-W', '-w'
        ]);

        for (let i = 1; i < tokens.length; i++) {
            const token = tokens[i];
            if (argFlags.has(token)) {
                i++; // Skip option argument
                continue;
            }
            if (token.startsWith('-')) {
                continue;
            }
            if (/^[a-zA-Z0-9._@-]+$/.test(token) && token !== 'localhost' && token !== '127.0.0.1') {
                const lowerHost = token.toLowerCase();
                // Ignore Git SSH operations (e.g. git@github.com, git-upload-pack) and file transfer utilities
                if (
                    lowerHost.startsWith('git@') ||
                    /(^|\.)(github\.com|gitlab\.com|bitbucket\.org|gitee\.com|ssh\.dev\.azure\.com)$/.test(lowerHost)
                ) {
                    return null;
                }
                const trailingCmd = tokens.slice(i + 1).join(' ').toLowerCase();
                if (/\b(git-upload-pack|git-receive-pack|git-lfs-authenticate|scp|sftp)\b/.test(trailingCmd)) {
                    return null;
                }
                return { host: token, isKeeper };
            }
            break;
        }

        return null;
    }

    /**
     * Discover active interactive SSH sessions and background keeper processes on the local machine
     */
    public static async discoverActiveSshSessions(): Promise<{
        interactiveHosts: string[];
        keeperPidsByHost: Map<string, number[]>;
    }> {
        const interactiveHosts = new Set<string>();
        const keeperPidsByHost = new Map<string, number[]>();

        try {
            let stdout = '';
            if (process.platform === 'win32') {
                const psCmd = 'powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Filter \\"Name = \'ssh.exe\'\\" | ForEach-Object { \\"$($_.ProcessId)`t$($_.CommandLine)\\" }"';
                const res = await execAsync(psCmd, { timeout: 4000, windowsHide: true });
                stdout = res.stdout;
            } else {
                const res = await execAsync('ps -eo pid=,args= | grep -E "[s]sh " || true', { timeout: 3000 });
                stdout = res.stdout;
            }

            const lines = stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
            for (const line of lines) {
                const firstSpaceIdx = line.search(/\s/);
                if (firstSpaceIdx === -1) {
                    continue;
                }
                const pid = parseInt(line.slice(0, firstSpaceIdx).trim(), 10);
                const cmdLine = line.slice(firstSpaceIdx + 1).trim();
                if (isNaN(pid) || pid <= 0) {
                    continue;
                }

                const parsed = TunnelManager.parseSshCommandDestination(cmdLine);
                if (!parsed) {
                    continue;
                }

                if (parsed.isKeeper) {
                    const list = keeperPidsByHost.get(parsed.host) || [];
                    list.push(pid);
                    keeperPidsByHost.set(parsed.host, list);
                } else {
                    interactiveHosts.add(parsed.host);
                }
            }
        } catch {
            // Ignore process listing errors
        }

        return {
            interactiveHosts: Array.from(interactiveHosts),
            keeperPidsByHost
        };
    }

    private static async terminateKeeperProcess(pid: number): Promise<void> {
        try {
            if (process.platform === 'win32') {
                await execAsync(`taskkill /F /PID ${pid} 2>nul || exit 0`, { windowsHide: true }).catch(() => {});
            } else {
                process.kill(pid);
            }
        } catch {
            // Ignore termination errors
        }
    }

    /**
     * Strip wormhole includes and conflicting forwarding directives from a raw SSH config
     * so the dedicated background keeper process only binds its assigned keeper port (remotePort + 3).
     */
    public static sanitizeKeeperSshConfig(rawConfig: string): string {
        return rawConfig
            .split(/\r?\n/)
            .filter((line: string) => {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#')) {
                    return true;
                }
                if (line.includes('config.wormhole')) {
                    return false;
                }
                if (/^(RemoteForward|ClearAllForwardings|ExitOnForwardFailure)\b/i.test(trimmed)) {
                    return false;
                }
                return true;
            })
            .join('\n');
    }

    /**
     * Maintain detached background SSH reverse tunnel keepers for active remote hosts.
     * Prevents tunnel starvation when multiple Remote-SSH windows are open and the primary window closes
     * or switches to a local workspace.
     */
    public static async ensureBackgroundTunnelKeepers(
        localPort: number,
        remotePort: number,
        enabled: boolean = true,
        force: boolean = false
    ): Promise<void> {
        if (TunnelManager.isSyncingKeepers) {
            return;
        }
        const now = Date.now();
        // Fast-path: if we already have live in-memory tracked keeper child process(es),
        // avoid spawning PowerShell/ps unless 5 minutes have elapsed or force=true.
        const hasLiveTrackedKeepers =
            TunnelManager.activeKeeperChildren.size > 0 &&
            Array.from(TunnelManager.activeKeeperChildren.values()).every(
                (c) => c.exitCode === null && !c.killed
            );
        const minIntervalMs = hasLiveTrackedKeepers ? 300000 : 120000;
        if (!force && enabled && now - TunnelManager.lastKeeperSyncMs < minIntervalMs) {
            return;
        }
        TunnelManager.isSyncingKeepers = true;
        TunnelManager.lastKeeperSyncMs = now;

        try {
            const { interactiveHosts, keeperPidsByHost } = await TunnelManager.discoverActiveSshSessions();

            if (!enabled) {
                await TunnelManager.stopAllKeepers();
                for (const pids of keeperPidsByHost.values()) {
                    for (const pid of pids) {
                        await TunnelManager.terminateKeeperProcess(pid);
                    }
                }
                return;
            }

            // Terminate keeper processes for hosts that no longer have any active interactive Remote-SSH session
            for (const [host, pids] of keeperPidsByHost.entries()) {
                if (!interactiveHosts.includes(host)) {
                    const tracked = TunnelManager.activeKeeperChildren.get(host);
                    if (tracked) {
                        try {
                            tracked.kill();
                        } catch {
                            // Ignore
                        }
                        TunnelManager.activeKeeperChildren.delete(host);
                    }
                    for (const pid of pids) {
                        await TunnelManager.terminateKeeperProcess(pid);
                        logger.log(`Terminated idle background tunnel keeper (PID ${pid}) for disconnected host '${host}'`, true);
                    }
                } else if (pids.length > 1) {
                    // Deduplicate redundant keeper processes for the same host to prevent memory/zombie accumulation
                    for (const extraPid of pids.slice(1)) {
                        await TunnelManager.terminateKeeperProcess(extraPid);
                        logger.log(`Terminated duplicate background tunnel keeper (PID ${extraPid}) for host '${host}'`, true);
                    }
                }
            }

            if (interactiveHosts.length === 0) {
                return;
            }

            const localReachable = await TunnelManager.checkPortAvailable('127.0.0.1', localPort, 1000);
            if (!localReachable) {
                return;
            }

            for (const host of interactiveHosts) {
                const existingKeepers = keeperPidsByHost.get(host) || [];
                const trackedChild = TunnelManager.activeKeeperChildren.get(host);
                if (existingKeepers.length > 0 || (trackedChild && trackedChild.exitCode === null && !trackedChild.killed)) {
                    continue;
                }

                try {
                    const mainConfig = SSHConfigManager.getMainConfigPath();
                    const sshDir = SSHConfigManager.getSSHDir();
                    let configParam: string[] = [];
                    try {
                        const fs = require('fs');
                        const path = require('path');
                        if (fs.existsSync(mainConfig)) {
                            // Build a dedicated keeper SSH config without 'Include config.wormhole'
                            // or any user-hardcoded RemoteForward/ExitOnForwardFailure directives,
                            // so the background keeper ONLY binds remotePort+3 (with ExitOnForwardFailure=yes)
                            // and never collides with primary/fallback ports (remotePort..remotePort+2).
                            const rawMain = fs.readFileSync(mainConfig, 'utf-8') as string;
                            const keeperCfgContent = TunnelManager.sanitizeKeeperSshConfig(rawMain);
                            const keeperCfgPath = path.join(sshDir, 'config.wormhole.keeper');
                            fs.writeFileSync(keeperCfgPath, keeperCfgContent, 'utf-8');
                            configParam = ['-F', keeperCfgPath];
                        }
                    } catch {
                        // ignore fs check error
                    }

                    const args = [
                        ...configParam,
                        '-N',
                        '-T',
                        '-o', 'BatchMode=yes',
                        '-o', 'ExitOnForwardFailure=yes',
                        '-o', 'ServerAliveInterval=15',
                        '-o', 'ServerAliveCountMax=3',
                        '-o', 'TCPKeepAlive=yes',
                        '-o', 'ConnectTimeout=10',
                        '-o', 'ConnectionAttempts=2',
                        '-o', 'StreamLocalBindUnlink=yes',
                        '-o', 'SendEnv=AG_WORMHOLE_KEEPER',
                        '-R', `${remotePort + 3}:127.0.0.1:${localPort}`,
                        host
                    ];

                    // On Windows, use detached: false + windowsHide: true so CreateProcessW sets CREATE_NO_WINDOW
                    // rather than DETACHED_PROCESS. This prevents child processes (such as `Match ... exec "cmd.exe ..."`
                    // in ~/.ssh/config) from allocating a visible console window on the desktop.
                    const sshExe = process.platform === 'win32' ? 'ssh.exe' : 'ssh';
                    const child = spawn(sshExe, args, {
                        detached: process.platform !== 'win32',
                        stdio: 'ignore',
                        windowsHide: true
                    });
                    TunnelManager.activeKeeperChildren.set(host, child);
                    const cleanupChild = () => {
                        if (TunnelManager.activeKeeperChildren.get(host) === child) {
                            TunnelManager.activeKeeperChildren.delete(host);
                        }
                        child.removeAllListeners();
                    };
                    child.once('exit', cleanupChild);
                    child.once('error', cleanupChild);
                    child.unref();

                    logger.log(
                        `Spawned autonomous HA tunnel keeper for remote host '${host}' (ports ${remotePort}, ${remotePort + 3} -> 127.0.0.1:${localPort})`,
                        true
                    );
                } catch (err) {
                    logger.log(`Failed to spawn tunnel keeper for host '${host}': ${err}`, true);
                }
            }
        } finally {
            TunnelManager.isSyncingKeepers = false;
        }
    }

    /**
     * Cleanly terminate all in-memory tracked keeper child processes on shutdown
     */
    public static async stopAllKeepers(): Promise<void> {
        for (const [host, child] of TunnelManager.activeKeeperChildren.entries()) {
            try {
                child.removeAllListeners();
                if (child.pid && child.exitCode === null && !child.killed) {
                    child.kill();
                }
            } catch {
                // Ignore termination error
            }
            TunnelManager.activeKeeperChildren.delete(host);
        }
    }

    /**
     * Purge local temporary SSH config artifacts and recycle stale background keeper processes
     */
    public static async purgeLocalCache(): Promise<void> {
        try {
            const sshDir = SSHConfigManager.getSSHDir();
            const fs = require('fs/promises');
            const path = require('path');
            const tmpFile = path.join(sshDir, 'config.wormhole.tmp');
            try {
                await fs.unlink(tmpFile);
            } catch {
                // Ignore missing file
            }

            await TunnelManager.stopAllKeepers();

            // Recycle existing keeper processes
            const { keeperPidsByHost } = await TunnelManager.discoverActiveSshSessions();
            for (const pids of keeperPidsByHost.values()) {
                for (const pid of pids) {
                    await TunnelManager.terminateKeeperProcess(pid);
                }
            }
            logger.log('Purged local temporary SSH artifacts and recycled background keepers.', true);
        } catch (err) {
            logger.log(`Notice during local cache purge: ${err}`, true);
        }
    }
}
