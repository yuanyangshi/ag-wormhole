/**
 * AG-Wormhole - Remote Provisioning & Sandbox Engine
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../shared/logger';
import { LanguageServerProcessInfo } from '../shared/types';
import { getSystemArchitecture } from '../shared/environment';

const execAsync = promisify(exec);

export class Provisioner {
    /**
     * Ensure executable permissions for engine binaries
     */
    public static async ensureExecutablePermissions(extensionPath: string): Promise<void> {
        const arch = getSystemArchitecture();
        const binaryName = `mgraftcp-fakedns-linux-${arch}`;
        const binaryPath = path.join(extensionPath, 'resources', 'bin', binaryName);

        try {
            await execAsync(`chmod +x "${binaryPath}"`);
            logger.log(`Set executable flag on engine binary: ${binaryPath}`, false);
        } catch (error) {
            logger.log(`Notice: Could not chmod ${binaryPath}: ${error}`, false);
        }
    }

    /**
     * Probe whether mgraftcp is currently executing
     */
    public static async isMgraftcpRunning(): Promise<boolean> {
        try {
            const { stdout } = await execAsync('pgrep -f mgraftcp');
            return stdout.trim().length > 0;
        } catch {
            return false;
        }
    }

    /**
     * Inspect active Language Server process state and wrapper status
     */
    public static async getLanguageServerProcess(): Promise<LanguageServerProcessInfo | null> {
        try {
            const { stdout } = await execAsync('ps aux | grep language_server_linux | grep -v grep');
            const lines = stdout.trim().split('\n').filter(l => l.length > 0);

            const hasMgraftcpWrapper = lines.some(line => line.includes('mgraftcp'));

            for (const line of lines) {
                if (line.includes('mgraftcp-fakedns')) {
                    continue;
                }
                if (line.includes('language_server_linux')) {
                    const parts = line.split(/\s+/);
                    if (parts.length >= 2) {
                        const pid = parseInt(parts[1], 10);
                        const isPersistent = line.includes('--persistent_mode') || line.includes('persistent_mode');
                        if (!isNaN(pid)) {
                            return {
                                pid,
                                isPersistent,
                                isUsingProxy: hasMgraftcpWrapper
                            };
                        }
                    }
                }
            }
        } catch {
            // Process not found or ps execution failed
        }
        return null;
    }

    /**
     * Terminate Language Server process to enforce wrapper adoption
     */
    public static async restartLanguageServer(): Promise<boolean> {
        const proc = await Provisioner.getLanguageServerProcess();
        if (!proc) {
            logger.log('No Language Server process found to restart', false);
            return false;
        }

        try {
            logger.log(`Terminating Language Server process (PID: ${proc.pid}, persistent: ${proc.isPersistent})`, false);
            await execAsync(`kill ${proc.pid}`);
            await new Promise(resolve => setTimeout(resolve, 1000));

            const stillRunning = await Provisioner.getLanguageServerProcess();
            if (stillRunning && stillRunning.pid === proc.pid) {
                logger.log('Process still active, issuing SIGKILL', false);
                await execAsync(`kill -9 ${proc.pid}`);
            }
            logger.log('Language Server terminated successfully', false);
            return true;
        } catch (error) {
            logger.log(`Failed to restart Language Server: ${error}`, false);
            return false;
        }
    }

    /**
     * Generate standalone setup script content
     */
    public static async generateSetupScriptContent(host: string, port: number, proxyType: string, extensionPath: string): Promise<string> {
        const scriptPath = path.join(extensionPath, 'scripts', 'setup-proxy.sh');
        let content = await fs.readFile(scriptPath, 'utf-8');
        content = content.replace(/__PROXY_HOST__/g, host);
        content = content.replace(/__PROXY_PORT__/g, String(port));
        content = content.replace(/__PROXY_TYPE__/g, proxyType);
        return content;
    }

    /**
     * Generate rollback script
     */
    public static generateRollbackScript(): string {
        return `#!/bin/bash
set -e
echo "[AG-Wormhole] Initiating configuration rollback..."

BAKS=""
for DIR in "$HOME/.ag-wormhole" "$HOME/.antigravity-ide-server" "$HOME/.antigravity-server"; do
    FOUND=$(find "$DIR" -path "*/extensions/antigravity/bin/*" -name "language_server_linux_*.bak" -type f 2>/dev/null)
    [ -n "$FOUND" ] && BAKS="$BAKS\n$FOUND"
done
BAKS=$(echo -e "$BAKS" | sed '/^$/d')

if [ -z "$BAKS" ]; then
    echo "[AG-Wormhole] Nothing to rollback."
    exit 0
fi

RESTORED=0
while IFS= read -r BAK; do
    [ -z "$BAK" ] && continue
    TARGET="\${BAK%.bak}"
    echo "Restoring: $TARGET"
    [ -f "$TARGET" ] && rm -f "$TARGET"
    mv "$BAK" "$TARGET"
    RESTORED=$((RESTORED + 1))
done <<< "$BAKS"

echo "[AG-Wormhole] Rollback complete: $RESTORED binary file(s) restored."
`;
    }

    /**
     * Execute setup script silently
     */
    public static async runSetupSilently(host: string, port: number, proxyType: string, extensionPath: string): Promise<boolean> {
        const scriptPath = path.join(extensionPath, 'scripts', 'setup-proxy.sh');

        try {
            await execAsync(`chmod +x "${scriptPath}"`);

            const packageJsonPath = path.join(extensionPath, 'package.json');
            let extensionVersion = '1.0.0';
            try {
                const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
                const pkg = JSON.parse(packageJsonContent);
                extensionVersion = pkg.version || '1.0.0';
            } catch {
                // Default version
            }

            const env = {
                ...process.env,
                PROXY_HOST: host,
                PROXY_PORT: String(port),
                PROXY_TYPE: proxyType,
                EXTENSION_PATH: extensionPath,
                EXTENSION_VERSION: extensionVersion
            };

            const { stdout, stderr } = await execAsync(`bash "${scriptPath}" 2>&1`, { env });
            const output = stdout || stderr || '';
            logger.log(`Setup execution output: ${output}`, false);

            const isNewConfig = output.includes('Setup complete') ||
                (output.includes('Configured:') && !output.includes('Skipped:'));

            if (isNewConfig) {
                const proc = await Provisioner.getLanguageServerProcess();
                if (proc && proc.isPersistent) {
                    await Provisioner.restartLanguageServer();
                }
                return true;
            } else if (output.includes('Already configured') || output.includes('already synchronized')) {
                const proc = await Provisioner.getLanguageServerProcess();
                if (proc && !proc.isUsingProxy && proc.isPersistent) {
                    await Provisioner.restartLanguageServer();
                }
                return true;
            }
            return false;
        } catch (error: unknown) {
            const err = error as { message?: string; stdout?: string; stderr?: string };
            logger.log(`Provisioning error: ${err.message || error}`, false);
            return false;
        }
    }

    /**
     * Terminate dead or zombie processes holding the remote proxy port
     */
    public static async reclaimPort(port: number): Promise<{ success: boolean; message: string; pidsKilled: number[] }> {
        if (!port || port <= 0 || port > 65535) {
            return { success: false, message: `Invalid port ${port}`, pidsKilled: [] };
        }

        const pidsKilled: number[] = [];
        try {
            let pidsRaw = '';
            // Strategy 1: lsof or fuser
            try {
                const { stdout } = await execAsync(`lsof -t -i :${port} 2>/dev/null || fuser ${port}/tcp 2>/dev/null || true`);
                pidsRaw = stdout.trim();
            } catch {
                // Ignore failure
            }

            // Strategy 2: Fallback to ss socket inspection (present in standard iproute2 on minimal containers)
            if (!pidsRaw) {
                try {
                    const { stdout } = await execAsync(`ss -lptn "sport = :${port}" 2>/dev/null || true`);
                    const matches = stdout.match(/pid=(\d+)/g);
                    if (matches) {
                        pidsRaw = matches.map(m => m.replace('pid=', '')).join(' ');
                    }
                } catch {
                    // Ignore ss failure
                }
            }

            if (!pidsRaw) {
                return { success: true, message: `No active process holding port ${port}`, pidsKilled: [] };
            }

            const pids = Array.from(new Set(
                pidsRaw.split(/\s+/).map(p => parseInt(p, 10)).filter(p => !isNaN(p) && p > 0)
            ));

            for (const pid of pids) {
                if (pid === process.pid || pid === process.ppid) {
                    continue;
                }
                try {
                    await execAsync(`kill -9 ${pid} 2>/dev/null || true`);
                    pidsKilled.push(pid);
                } catch {
                    // Ignore individual kill errors
                }
            }

            logger.log(`Port ${port} reclaimed. Terminated zombie PIDs: ${pidsKilled.join(', ')}`, false);
            return {
                success: true,
                message: pidsKilled.length > 0
                    ? `Successfully released port ${port} (terminated ${pidsKilled.length} process(es))`
                    : `No releasable processes holding port ${port}`,
                pidsKilled
            };
        } catch (err: unknown) {
            const e = err as { message?: string };
            logger.log(`Port reclaim failed: ${e.message}`, false);
            return {
                success: false,
                message: `Failed to reclaim port ${port}: ${e.message}`,
                pidsKilled
            };
        }
    }

    /**
     * Read remote Linux kernel TCP keepalive settings to diagnose dropped connections
     */
    public static async getLinuxKeepAliveSettings(): Promise<{ keepaliveTime?: number; keepaliveIntvl?: number; keepaliveProbes?: number } | null> {
        try {
            const timeRaw = await fs.readFile('/proc/sys/net/ipv4/tcp_keepalive_time', 'utf-8');
            const intvlRaw = await fs.readFile('/proc/sys/net/ipv4/tcp_keepalive_intvl', 'utf-8');
            const probesRaw = await fs.readFile('/proc/sys/net/ipv4/tcp_keepalive_probes', 'utf-8');

            return {
                keepaliveTime: parseInt(timeRaw.trim(), 10),
                keepaliveIntvl: parseInt(intvlRaw.trim(), 10),
                keepaliveProbes: parseInt(probesRaw.trim(), 10)
            };
        } catch {
            return null;
        }
    }
}

