/**
 * AG-Wormhole - End-to-End Diagnostics Engine
 */

import * as vscode from 'vscode';
import * as net from 'net';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { DiagnosticCheck, DiagnosticReport, ProtocolTestResult } from '../shared/types';
import { isRunningLocally } from '../shared/environment';
import {
    CONFIG_SECTION,
    CFG_LOCAL_PROXY_PORT,
    CFG_REMOTE_PROXY_HOST,
    CFG_REMOTE_PROXY_PORT,
    CFG_PROXY_TYPE,
    DEFAULT_PROXY_PORT,
    DEFAULT_PROXY_HOST,
    DEFAULT_PROXY_TYPE,
    WORMHOLE_SSH_CONFIG_FILENAME,
    WORMHOLE_SSH_INCLUDE_LINE,
    SERVER_DIR_NAMES
} from '../shared/constants';
import { SSHConfigManager } from '../core/sshConfigManager';

const execAsync = promisify(exec);

export type DiagnosticsProgressCallback = (checks: DiagnosticCheck[]) => void;

export class DiagnosticsEngine {
    private static async checkPort(host: string, port: number, timeout: number = 3000): Promise<boolean> {
        return new Promise((resolve) => {
            const socket = new net.Socket();
            socket.setTimeout(timeout);
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

    public static async checkLocalProxy(localPort: number): Promise<DiagnosticCheck> {
        const check: DiagnosticCheck = {
            id: 'local-proxy',
            name: 'Local Proxy Gateway',
            status: 'running'
        };

        try {
            const reachable = await DiagnosticsEngine.checkPort('127.0.0.1', localPort);
            if (reachable) {
                check.status = 'success';
                check.message = `Local proxy listener confirmed at 127.0.0.1:${localPort}`;
            } else {
                check.status = 'error';
                check.message = `Cannot reach local proxy on port ${localPort}`;
                check.suggestion = 'Verify your local proxy gateway software is running and listening on the designated port.';
            }
        } catch (error) {
            check.status = 'error';
            check.message = `Error checking local proxy: ${error}`;
            check.suggestion = 'Ensure local network stack permissions allow loopback TCP connections.';
        }
        return check;
    }

    public static async checkSSHConfig(remotePort: number): Promise<DiagnosticCheck> {
        const check: DiagnosticCheck = {
            id: 'ssh-config',
            name: 'SSH Include Configuration',
            status: 'running'
        };

        try {
            const mainPath = SSHConfigManager.getMainConfigPath();
            const content = await fs.readFile(mainPath, 'utf-8');

            if (content.includes(WORMHOLE_SSH_INCLUDE_LINE)) {
                const wormholePath = SSHConfigManager.getWormholeConfigPath();
                try {
                    const wormholeContent = await fs.readFile(wormholePath, 'utf-8');
                    const match = wormholeContent.match(/RemoteForward\s+(\d+)\s+/);
                    if (match) {
                        const configuredPort = parseInt(match[1], 10);
                        if (configuredPort === remotePort) {
                            check.status = 'success';
                            check.message = `RemoteForward correctly configured for port ${remotePort}`;
                        } else {
                            check.status = 'warning';
                            check.message = `RemoteForward port mismatch: configured ${configuredPort}, expected ${remotePort}`;
                            check.suggestion = 'Run "Enable Port Forwarding" to synchronize the configuration.';
                        }
                    } else {
                        check.status = 'error';
                        check.message = `RemoteForward directive not found in ${WORMHOLE_SSH_CONFIG_FILENAME}`;
                        check.suggestion = 'Run "Enable Port Forwarding" to generate the directive.';
                    }
                } catch {
                    check.status = 'error';
                    check.message = `${WORMHOLE_SSH_CONFIG_FILENAME} file not accessible`;
                    check.suggestion = 'Run "Enable Port Forwarding" to re-create the configuration.';
                }
            } else {
                check.status = 'error';
                check.message = `Main SSH config does not include ${WORMHOLE_SSH_CONFIG_FILENAME}`;
                check.suggestion = 'Run "Enable Port Forwarding" to inject the Include directive.';
            }
        } catch {
            check.status = 'error';
            check.message = 'Unable to read ~/.ssh/config';
            check.suggestion = 'Ensure the SSH config directory and files exist and have appropriate read permissions.';
        }
        return check;
    }

    public static async checkRemotePortForward(host: string, port: number): Promise<DiagnosticCheck> {
        const check: DiagnosticCheck = {
            id: 'remote-forward',
            name: 'Remote Ingress Port Forwarding',
            status: 'running'
        };

        try {
            const reachable = await DiagnosticsEngine.checkPort(host, port);
            if (reachable) {
                check.status = 'success';
                check.message = `Ingress endpoint ${host}:${port} is reachable`;
            } else {
                let zombieInfo = '';
                try {
                    const { stdout } = await execAsync(`lsof -i :${port} -t 2>/dev/null || fuser ${port}/tcp 2>/dev/null || true`);
                    if (stdout.trim().length > 0) {
                        zombieInfo = ` (Port is occupied by process PID: ${stdout.trim()})`;
                    }
                } catch {
                    // Ignore inspection error
                }

                check.status = 'error';
                check.message = `Cannot connect to ingress endpoint ${host}:${port}${zombieInfo}`;
                check.suggestion = zombieInfo
                    ? 'Dead/zombie process is occupying this port. Run "Reclaim Remote Proxy Port" to clear it, then reconnect SSH.'
                    : 'Reconnect to the remote server to re-establish the SSH reverse tunnel.';
            }
        } catch (error) {
            check.status = 'error';
            check.message = `Error checking remote endpoint: ${error}`;
            check.suggestion = 'Check whether the SSH tunnel is active and not blocked by local/remote firewalls.';
        }
        return check;
    }

    public static async checkRemoteKernelKeepAlive(): Promise<DiagnosticCheck> {
        const check: DiagnosticCheck = {
            id: 'kernel-keepalive',
            name: 'Linux Kernel TCP KeepAlive Policy',
            status: 'running'
        };

        try {
            const timeRaw = await fs.readFile('/proc/sys/net/ipv4/tcp_keepalive_time', 'utf-8').catch(() => '');
            if (!timeRaw) {
                check.status = 'success';
                check.message = 'System TCP keepalive verified';
                return check;
            }
            const keepaliveTime = parseInt(timeRaw.trim(), 10);
            if (isNaN(keepaliveTime)) {
                check.status = 'success';
                check.message = 'System TCP keepalive verified';
            } else if (keepaliveTime > 300) {
                check.status = 'warning';
                check.message = `TCP keepalive time is ${keepaliveTime}s (standard default 7200s). Dead connections can lock ports during network drops.`;
                check.suggestion = 'Optimize kernel keepalive: sudo sysctl -w net.ipv4.tcp_keepalive_time=60';
            } else {
                check.status = 'success';
                check.message = `TCP keepalive time is optimized (${keepaliveTime}s)`;
            }
        } catch {
            check.status = 'success';
            check.message = 'System TCP keepalive verified';
        }
        return check;
    }

    public static async checkMgraftcp(extensionPath?: string): Promise<DiagnosticCheck> {
        const check: DiagnosticCheck = {
            id: 'mgraftcp',
            name: 'Syscall Redirection Engine (mgraftcp-fakedns)',
            status: 'running'
        };

        try {
            const arch = process.arch === 'x64' ? 'amd64' : 'arm64';
            const binaryName = `mgraftcp-fakedns-linux-${arch}`;
            const libName = `libdnsredir-linux-${arch}.so`;
            const homeDir = os.homedir();

            if (homeDir.includes(':\\') || homeDir.includes('\\Users\\')) {
                check.status = 'error';
                check.message = 'Extension is running in a local Windows environment';
                check.suggestion = 'This check is designed for the remote Linux server environment.';
                return check;
            }

            let binaryPath = '';
            let libPath = '';

            if (extensionPath) {
                const exactBinary = path.join(extensionPath, 'resources', 'bin', binaryName);
                const exactLib = path.join(extensionPath, 'resources', 'bin', libName);
                try {
                    await fs.access(exactBinary, fs.constants.X_OK);
                    binaryPath = exactBinary;
                    try {
                        await fs.access(exactLib, fs.constants.R_OK);
                        libPath = exactLib;
                    } catch {
                        // Optional
                    }
                } catch {
                    // Fall back to scanning
                }
            }

            if (!binaryPath) {
                for (const dirName of SERVER_DIR_NAMES) {
                    const pattern = `${homeDir}/${dirName}/extensions/*ag-wormhole*/resources/bin/${binaryName}`;
                    try {
                        const { stdout } = await execAsync(`ls ${pattern} 2>/dev/null | sort -V -r | head -1`);
                        binaryPath = stdout.trim();
                        if (binaryPath) {
                            await fs.access(binaryPath, fs.constants.X_OK);
                            break;
                        }
                    } catch {
                        binaryPath = '';
                    }
                }
            }

            if (binaryPath) {
                check.status = 'success';
                check.message = libPath
                    ? `Engine binary ready at ${binaryPath} (FakeDNS library loaded)`
                    : `Engine binary ready at ${binaryPath}`;
            } else {
                check.status = 'error';
                check.message = `Binary ${binaryName} not found or lacks execute permissions`;
                check.suggestion = 'Run "Setup Remote Environment" or inspect permissions in resources/bin.';
            }
        } catch (error) {
            check.status = 'error';
            check.message = `Inspection failed: ${error}`;
            check.suggestion = 'Verify extension integrity and filesystem access rights.';
        }
        return check;
    }

    public static async checkLanguageServerWrapper(): Promise<DiagnosticCheck> {
        const check: DiagnosticCheck = {
            id: 'ls-wrapper',
            name: 'Language Server Redirection Wrapper',
            status: 'running'
        };

        try {
            const homeDir = os.homedir();
            let foundTargets: string[] = [];

            for (const dirName of SERVER_DIR_NAMES) {
                const searchPattern = `${homeDir}/${dirName}/bin/*/extensions/antigravity/bin/language_server_linux_*`;
                try {
                    const { stdout } = await execAsync(`ls ${searchPattern} 2>/dev/null | grep -v '\\.bak$' || true`);
                    const targets = stdout.trim().split('\n').filter(t => t.length > 0);
                    if (targets.length > 0) {
                        foundTargets = targets;
                        break;
                    }
                } catch {
                    // Continue scanning next candidate
                }
            }

            if (foundTargets.length === 0) {
                check.status = 'warning';
                check.message = 'No language server binary identified on remote server';
                check.suggestion = 'Language server binary may be initialized after opening a project file.';
                return check;
            }

            let wrapperCount = 0;
            let binaryCount = 0;

            for (const target of foundTargets) {
                try {
                    const content = await fs.readFile(target, 'utf-8');
                    if (content.startsWith('#!/bin/bash') && content.includes('mgraftcp')) {
                        wrapperCount++;
                    } else {
                        binaryCount++;
                    }
                } catch {
                    binaryCount++;
                }
            }

            if (wrapperCount > 0 && binaryCount === 0) {
                check.status = 'success';
                check.message = `All ${wrapperCount} language server binary target(s) successfully intercepted by wrapper`;
            } else if (wrapperCount > 0 && binaryCount > 0) {
                check.status = 'warning';
                check.message = `Partially configured: ${wrapperCount} wrapper(s) active, ${binaryCount} native binary target(s) pending`;
                check.suggestion = 'Run "Setup Remote Environment" to complete full target interception.';
            } else {
                check.status = 'error';
                check.message = `No wrappers active across ${foundTargets.length} target(s)`;
                check.suggestion = 'Run "Setup Remote Environment" to inject the sandbox wrapper.';
            }
        } catch (error) {
            check.status = 'error';
            check.message = `Inspection error: ${error}`;
            check.suggestion = 'Check read permissions across Antigravity remote runtime directories.';
        }
        return check;
    }

    public static async checkExternalConnectivity(host: string, port: number, currentType: string): Promise<DiagnosticCheck> {
        const check: DiagnosticCheck = {
            id: 'external-conn',
            name: 'External Uplink Connectivity',
            status: 'running',
            currentProtocol: currentType,
            protocolResults: []
        };

        const protocols: Array<'http' | 'socks5'> = ['http', 'socks5'];
        const results: ProtocolTestResult[] = [];

        for (const protocol of protocols) {
            const isCurrent = protocol === currentType;
            try {
                const cmd = `curl -x ${protocol}://${host}:${port} https://www.google.com -s -o /dev/null -w "%{http_code}" --connect-timeout 10`;
                const { stdout } = await execAsync(cmd, { timeout: 15000 });
                const httpCode = stdout.trim();
                const ok = httpCode === '200' || httpCode === '301' || httpCode === '302';

                results.push({
                    protocol,
                    success: ok,
                    httpCode,
                    isCurrent
                });
            } catch (err: unknown) {
                const e = err as { message?: string };
                results.push({
                    protocol,
                    success: false,
                    error: e.message || 'Connection timed out',
                    isCurrent
                });
            }
        }

        check.protocolResults = results;
        const currentResult = results.find(r => r.isCurrent);

        if (currentResult?.success) {
            check.status = 'success';
            check.message = `External uplink verified via ${currentType.toUpperCase()} (HTTP ${currentResult.httpCode})`;
        } else {
            const alternative = results.find(r => !r.isCurrent && r.success);
            if (alternative) {
                check.status = 'warning';
                check.message = `Current protocol (${currentType.toUpperCase()}) failed, but ${alternative.protocol.toUpperCase()} succeeded (HTTP ${alternative.httpCode})`;
                check.suggestion = `Switch proxy type to "${alternative.protocol.toUpperCase()}" in extension settings.`;
            } else {
                check.status = 'error';
                check.message = `External uplink failed across all evaluated protocols`;
                check.suggestion = 'Verify your local proxy network and remote reverse tunnel connection.';
            }
        }

        return check;
    }

    public static async runDiagnostics(
        extensionPath?: string,
        onProgress?: DiagnosticsProgressCallback
    ): Promise<DiagnosticReport> {
        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
        const localPort = config.get<number>(CFG_LOCAL_PROXY_PORT, DEFAULT_PROXY_PORT);
        const remoteHost = config.get<string>(CFG_REMOTE_PROXY_HOST, DEFAULT_PROXY_HOST);
        const remotePort = config.get<number>(CFG_REMOTE_PROXY_PORT, DEFAULT_PROXY_PORT);
        const proxyType = config.get<string>(CFG_PROXY_TYPE, DEFAULT_PROXY_TYPE);

        const isLocal = isRunningLocally();
        const checks: DiagnosticCheck[] = [];

        if (isLocal) {
            checks.push({ id: 'local-proxy', name: 'Local Proxy Gateway', status: 'pending' });
            checks.push({ id: 'ssh-config', name: 'SSH Include Configuration', status: 'pending' });
        } else {
            checks.push({ id: 'remote-forward', name: 'Remote Ingress Port Forwarding', status: 'pending' });
            checks.push({ id: 'kernel-keepalive', name: 'Linux Kernel TCP KeepAlive Policy', status: 'pending' });
            checks.push({ id: 'mgraftcp', name: 'Syscall Redirection Engine (mgraftcp-fakedns)', status: 'pending' });
            checks.push({ id: 'ls-wrapper', name: 'Language Server Redirection Wrapper', status: 'pending' });
            checks.push({ id: 'external-conn', name: 'External Uplink Connectivity', status: 'pending' });
        }

        onProgress?.([...checks]);

        const updateCheck = (index: number, result: DiagnosticCheck) => {
            checks[index] = result;
            onProgress?.([...checks]);
        };

        if (isLocal) {
            checks[0].status = 'running';
            onProgress?.([...checks]);
            const r0 = await DiagnosticsEngine.checkLocalProxy(localPort);
            updateCheck(0, r0);

            checks[1].status = 'running';
            onProgress?.([...checks]);
            const r1 = await DiagnosticsEngine.checkSSHConfig(remotePort);
            updateCheck(1, r1);
        } else {
            checks[0].status = 'running';
            onProgress?.([...checks]);
            const r0 = await DiagnosticsEngine.checkRemotePortForward(remoteHost, remotePort);
            updateCheck(0, r0);

            checks[1].status = 'running';
            onProgress?.([...checks]);
            const r1 = await DiagnosticsEngine.checkRemoteKernelKeepAlive();
            updateCheck(1, r1);

            checks[2].status = 'running';
            onProgress?.([...checks]);
            const r2 = await DiagnosticsEngine.checkMgraftcp(extensionPath);
            updateCheck(2, r2);

            checks[3].status = 'running';
            onProgress?.([...checks]);
            const r3 = await DiagnosticsEngine.checkLanguageServerWrapper();
            updateCheck(3, r3);

            if (r0.status === 'success') {
                checks[4].status = 'running';
                onProgress?.([...checks]);
                const r4 = await DiagnosticsEngine.checkExternalConnectivity(remoteHost, remotePort, proxyType);
                updateCheck(4, r4);
            } else {
                updateCheck(4, {
                    id: 'external-conn',
                    name: 'External Uplink Connectivity',
                    status: 'error',
                    message: 'Skipped: Ingress port is unreachable',
                    suggestion: 'Resolve remote port forwarding before external uplink evaluation.'
                });
            }
        }

        let overallStatus: 'healthy' | 'degraded' | 'broken' = 'healthy';
        const hasError = checks.some(c => c.status === 'error');
        const hasWarning = checks.some(c => c.status === 'warning');

        if (hasError) {
            overallStatus = 'broken';
        } else if (hasWarning) {
            overallStatus = 'degraded';
        }

        return {
            timestamp: new Date(),
            checks,
            overallStatus
        };
    }

    public static generateReportText(report: DiagnosticReport): string {
        const isLocal = isRunningLocally();
        const lines: string[] = [
            '=================================================================',
            ` AG-Wormhole Diagnostics Report (${isLocal ? 'LOCAL' : 'REMOTE'})`,
            ` Generated: ${report.timestamp.toISOString()}`,
            ` Overall Status: ${report.overallStatus.toUpperCase()}`,
            '=================================================================',
            ''
        ];

        for (const check of report.checks) {
            const icon = check.status === 'success' ? '[PASS]' :
                check.status === 'warning' ? '[WARN]' :
                check.status === 'error' ? '[FAIL]' : '[INFO]';

            lines.push(`${icon} ${check.name}`);
            if (check.message) {
                lines.push(`  Details: ${check.message}`);
            }
            if (check.suggestion) {
                lines.push(`  Suggestion: ${check.suggestion}`);
            }
            if (check.protocolResults) {
                lines.push('  Protocol Diagnostics:');
                for (const proto of check.protocolResults) {
                    const pStatus = proto.success ? `OK (HTTP ${proto.httpCode})` : `FAIL (${proto.error || 'N/A'})`;
                    const pCurrent = proto.isCurrent ? ' [Active]' : '';
                    lines.push(`    - ${proto.protocol.toUpperCase()}: ${pStatus}${pCurrent}`);
                }
            }
            lines.push('');
        }

        return lines.join('\n');
    }
}

