/**
 * AG-Wormhole - Remote Provisioning & Sandbox Engine
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as net from 'net';
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
            const { stdout } = await execAsync('pgrep -f "[m]graftcp-fakedns"');
            return stdout.trim().length > 0;
        } catch {
            return false;
        }
    }

    /**
     * Check whether modern Antigravity AGY runtime is installed and synchronized with AG-Wormhole
     */
    public static async isAgyRuntimeConfigured(): Promise<boolean> {
        const homeDir = os.homedir();
        const serverDirs = [
            path.join(homeDir, '.ag-wormhole'),
            path.join(homeDir, '.antigravity-ide-server'),
            path.join(homeDir, '.antigravity-server')
        ];

        for (const dir of serverDirs) {
            const stateFile = path.join(dir, '.wormhole-state.json');
            try {
                await fs.access(stateFile);
                return true;
            } catch {
                // Continue checking
            }
        }

        const agyBinary = path.join(homeDir, '.gemini', 'bin', 'agy');
        try {
            await fs.access(agyBinary);
            if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy) {
                return true;
            }
        } catch {
            // AGY binary not found
        }

        return false;
    }

    /**
     * Inspect active Language Server / AGY runtime process state and proxy status
     */
    public static async getLanguageServerProcess(): Promise<LanguageServerProcessInfo | null> {
        try {
            const { stdout } = await execAsync('ps auxww | grep language_server_linux | grep -v grep');
            const lines = stdout.trim().split('\n').filter(l => l.length > 0);

            const hasMgraftcpWrapper = lines.some(line => line.includes('mgraftcp')) || await Provisioner.isMgraftcpRunning();

            for (const line of lines) {
                if (line.includes('mgraftcp-fakedns')) {
                    continue;
                }
                if (line.includes('language_server_linux')) {
                    const parts = line.split(/\s+/);
                    if (parts.length >= 2) {
                        const pid = parseInt(parts[1], 10);
                        const isPersistent = line.includes('--persistent_mode') || line.includes('persistent_mode');
                        const isBakBinary = line.includes('.bak');
                        if (!isNaN(pid)) {
                            return {
                                pid,
                                isPersistent,
                                isUsingProxy: hasMgraftcpWrapper || isBakBinary
                            };
                        }
                    }
                }
            }
        } catch {
            // Legacy process not found, check modern AGY runtime next
        }

        // Modern Antigravity 2.6+ AGY Hub Runtime (~/.gemini/bin/agy --hub)
        try {
            const { stdout } = await execAsync('ps auxww | grep -E "/\\.gemini/bin/agy|agy --hub" | grep -v grep');
            const lines = stdout.trim().split('\n').filter(l => l.length > 0);
            for (const line of lines) {
                const parts = line.split(/\s+/);
                if (parts.length >= 2) {
                    const pid = parseInt(parts[1], 10);
                    if (!isNaN(pid) && pid > 0) {
                        let hasProxyEnv = Boolean(
                            process.env.HTTP_PROXY ||
                            process.env.HTTPS_PROXY ||
                            process.env.http_proxy ||
                            process.env.https_proxy
                        );
                        try {
                            const envRaw = await fs.readFile(`/proc/${pid}/environ`, 'utf-8');
                            if (/HTTP_PROXY=|HTTPS_PROXY=|http_proxy=|https_proxy=|ALL_PROXY=|all_proxy=/i.test(envRaw)) {
                                hasProxyEnv = true;
                            }
                        } catch {
                            // Ignore /proc read restriction
                        }
                        const stateConfigured = await Provisioner.isAgyRuntimeConfigured();
                        return {
                            pid,
                            isPersistent: false,
                            isUsingProxy: hasProxyEnv || stateConfigured
                        };
                    }
                }
            }
        } catch {
            // AGY process not running
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
                if (proc && (!proc.isUsingProxy || proc.isPersistent)) {
                    await Provisioner.restartLanguageServer();
                }
                return true;
            } else if (output.includes('Already configured') || output.includes('already synchronized')) {
                const proc = await Provisioner.getLanguageServerProcess();
                if (proc && !proc.isUsingProxy) {
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
     * Retrieve PIDs actively listening (LISTEN state only) on a given TCP port
     */
    public static async getListeningPids(port: number): Promise<number[]> {
        if (!port || port <= 0 || port > 65535) {
            return [];
        }

        let pidsRaw = '';
        // Strategy 1: lsof filtered strictly to TCP LISTEN state (never match client connections)
        try {
            const { stdout } = await execAsync(`lsof -nP -t -iTCP:${port} -sTCP:LISTEN 2>/dev/null || true`);
            pidsRaw = stdout.trim();
        } catch {
            // Ignore failure
        }

        // Strategy 2: Fallback to ss listening socket inspection (-l restricts to LISTEN)
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
            return [];
        }

        return Array.from(new Set(
            pidsRaw.split(/\s+/).map(p => parseInt(p, 10)).filter(p => !isNaN(p) && p > 0)
        ));
    }

    /**
     * Check whether a local TCP port is actively in LISTEN state even when the kernel
     * hides the owning PID (e.g. non-root inspection of setuid/non-dumpable sshd workers).
     */
    public static async isPortListeningUnprivileged(port: number): Promise<boolean> {
        if (!port || port <= 0 || port > 65535) {
            return false;
        }
        try {
            const { stdout } = await execAsync(`ss -ltn "sport = :${port}" 2>/dev/null || true`);
            if (/\bLISTEN\b/.test(stdout)) {
                return true;
            }
        } catch {
            // Ignore ss failure
        }
        return false;
    }

    /**
     * Pure helper: sum the Send-Q column of `ss -tn` output rows in ESTABLISHED state.
     * A large persistent Send-Q on SSH connections indicates a dead peer (zombie session).
     */
    public static parseStuckSendQueueBytes(ssOutput: string): number {
        let total = 0;
        for (const line of ssOutput.split(/\r?\n/)) {
            const cols = line.trim().split(/\s+/);
            // Expected: State Recv-Q Send-Q Local Peer
            if (cols.length >= 5 && cols[0] === 'ESTAB') {
                const sendQ = parseInt(cols[2], 10);
                if (!isNaN(sendQ) && sendQ > 0) {
                    total += sendQ;
                }
            }
        }
        return total;
    }

    /**
     * Diagnostic: total bytes queued on ESTABLISHED sshd connections (port 22) that the peer is not draining.
     */
    public static async getStuckSendQueueBytes(): Promise<number> {
        try {
            const { stdout } = await execAsync('ss -tn "( sport = :22 )" 2>/dev/null || true');
            return Provisioner.parseStuckSendQueueBytes(stdout);
        } catch {
            return 0;
        }
    }

    /**
     * Enumerate all sshd processes owned by the current unprivileged user.
     */
    public static async getUnprivilegedUserSshdPids(): Promise<number[]> {
        try {
            const { stdout } = await execAsync('pgrep -u $(id -u) sshd 2>/dev/null || true');
            return Array.from(new Set(
                stdout.trim().split(/\s+/).map(p => parseInt(p, 10)).filter(p => !isNaN(p) && p > 0)
            ));
        } catch {
            return [];
        }
    }

    /**
     * Pure helper to determine whether a candidate interactive sshd session (with start time `candidateStart`)
     * has been superseded by a newer persistent interactive sshd session (excluding transient `bash -c` commands).
     * Returns the superseding PID if superseded, or null if the candidate is still the active session.
     */
    public static findSupersedingSshdPid(
        candidateStart: number,
        otherSessions: Array<{ pid: number; startTicks: number; childArgs: string }>
    ): number | null {
        for (const other of otherSessions) {
            if (other.startTicks <= candidateStart) {
                continue;
            }
            const lines = other.childArgs
                .split(/\r?\n/)
                .map(l => l.trim())
                .filter(Boolean);
            if (lines.length === 0) {
                continue;
            }
            // Ignore transient one-off commands (e.g. `bash -c ...` or `sh -c ...`) so ad-hoc CLI
            // invocations never cause the persistent Remote-SSH session (`bash -s`) to be reclaimed.
            const hasPersistentChild = lines.some(line => !/\s-c(\s|$)/.test(line));
            if (hasPersistentChild) {
                return other.pid;
            }
        }
        return null;
    }

    /**
     * Collect all ancestor PIDs of the current Extension Host up to PID 1
     * to prevent terminating the active SSH daemon or remote IDE server tree.
     */
    public static async getProtectedPids(port: number): Promise<Set<number>> {
        const protectedPids = new Set<number>([1, process.pid, process.ppid]);

        // 1. Walk ancestor chain via /proc or ps
        let currentPid = process.pid;
        for (let depth = 0; depth < 16 && currentPid > 1; depth++) {
            protectedPids.add(currentPid);
            try {
                const statContent = await fs.readFile(`/proc/${currentPid}/stat`, 'utf-8');
                const closeParenIdx = statContent.lastIndexOf(')');
                if (closeParenIdx !== -1) {
                    const fields = statContent.slice(closeParenIdx + 2).trim().split(/\s+/);
                    const ppid = parseInt(fields[1], 10);
                    if (!isNaN(ppid) && ppid > 0 && !protectedPids.has(ppid)) {
                        currentPid = ppid;
                        continue;
                    }
                }
                break;
            } catch {
                break;
            }
        }

        // 2. Protect active dedicated background keeper listener on port+3 ONLY if verified alive at L7.
        // If the keeper port has an orphaned listener that fails L7, allow it to be reclaimed.
        const keeperPort = port + 3;
        if (keeperPort > 0 && keeperPort <= 65535 && keeperPort !== port) {
            const isKeeperPortAlive = await new Promise<boolean>((resolve) => {
                const s = new net.Socket();
                let done = false;
                const finish = (ok: boolean) => {
                    if (done) {
                        return;
                    }
                    done = true;
                    s.removeAllListeners();
                    s.destroy();
                    resolve(ok);
                };
                s.setTimeout(500);
                s.on('connect', () => {
                    try {
                        s.write('HEAD / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
                    } catch {
                        finish(false);
                    }
                });
                s.on('data', (chunk) => finish(Boolean(chunk && chunk.length > 0)));
                s.on('timeout', () => finish(false));
                s.on('error', () => finish(false));
                s.on('close', () => finish(false));
                s.connect(keeperPort, '127.0.0.1');
            });

            if (isKeeperPortAlive) {
                const keeperPids = await Provisioner.getListeningPids(keeperPort);
                for (const pid of keeperPids) {
                    protectedPids.add(pid);
                }
                // Under unprivileged Linux accounts, `ss -lptn` hides `sshd` PIDs.
                // Protect the newest childless `sshd` (the active `ssh -N` background keeper).
                if (keeperPids.length === 0) {
                    const userSshdPids = await Provisioner.getUnprivilegedUserSshdPids();
                    let newestKeeperPid: number | null = null;
                    let newestKeeperStart = -1;
                    for (const sshdPid of userSshdPids) {
                        try {
                            const { stdout: childrenOut } = await execAsync(`pgrep -P ${sshdPid} 2>/dev/null || true`);
                            if (childrenOut.trim().length === 0) {
                                const startTicks = await Provisioner.getProcessStartTimeTicks(sshdPid);
                                if (startTicks !== null && startTicks > newestKeeperStart) {
                                    newestKeeperStart = startTicks;
                                    newestKeeperPid = sshdPid;
                                }
                            }
                        } catch {
                            // Ignore individual process inspection error
                        }
                    }
                    if (newestKeeperPid !== null) {
                        protectedPids.add(newestKeeperPid);
                    }
                }
            }
        }

        return protectedPids;
    }

    /**
     * Read process start time (clock ticks since system boot) from /proc/<pid>/stat
     */
    private static async getProcessStartTimeTicks(pid: number): Promise<number | null> {
        try {
            const statContent = await fs.readFile(`/proc/${pid}/stat`, 'utf-8');
            const closeParenIdx = statContent.lastIndexOf(')');
            if (closeParenIdx === -1) {
                return null;
            }
            const fields = statContent.slice(closeParenIdx + 2).trim().split(/\s+/);
            // Field 22 in /proc/[pid]/stat is starttime (index 19 after the comm field)
            const startTicks = parseInt(fields[19], 10);
            return isNaN(startTicks) ? null : startTicks;
        } catch {
            return null;
        }
    }

    /**
     * Check whether a candidate PID is a safe-to-reclaim orphaned or superseded zombie tunnel process
     */
    private static async isSafeZombieCandidate(pid: number, protectedPids: Set<number>): Promise<boolean> {
        if (protectedPids.has(pid)) {
            return false;
        }

        try {
            const { stdout: cmdOut } = await execAsync(`ps -p ${pid} -o comm=,args= 2>/dev/null || true`);
            const cmdLine = cmdOut.trim().toLowerCase();
            if (!cmdLine) {
                return false;
            }

            // Never terminate IDE server, extension host, or proxy wrapper processes
            if (
                cmdLine.includes('node') ||
                cmdLine.includes('code') ||
                cmdLine.includes('antigravity') ||
                cmdLine.includes('language_server') ||
                cmdLine.includes('mgraftcp')
            ) {
                return false;
            }

            // If it is an sshd process:
            // 1. An sshd with zero child processes (not in protectedPids) is an orphaned tunnel session -> safe to reclaim.
            // 2. In Remote-SSH ("bash -s"), a dead disconnected sshd may still have an old shell child
            //    until TCP keepalive expires; if a newer persistent interactive sshd session for the same user
            //    already exists, this older sshd holding a dead proxy port is a superseded zombie session.
            if (cmdLine.includes('sshd')) {
                const { stdout: childrenOut } = await execAsync(`pgrep -P ${pid} 2>/dev/null || true`);
                if (childrenOut.trim().length === 0) {
                    return true;
                }

                const candidateStart = await Provisioner.getProcessStartTimeTicks(pid);
                if (candidateStart !== null) {
                    const otherPids = (await Provisioner.getUnprivilegedUserSshdPids()).filter(p => p !== pid);
                    const otherSessions: Array<{ pid: number; startTicks: number; childArgs: string }> = [];

                    for (const otherPid of otherPids) {
                        const { stdout: otherChildren } = await execAsync(`pgrep -P ${otherPid} 2>/dev/null || true`);
                        if (otherChildren.trim().length > 0) {
                            const otherStart = await Provisioner.getProcessStartTimeTicks(otherPid);
                            if (otherStart !== null && otherStart > candidateStart) {
                                const { stdout: childArgs } = await execAsync(`ps --ppid ${otherPid} -o args= 2>/dev/null || true`);
                                otherSessions.push({
                                    pid: otherPid,
                                    startTicks: otherStart,
                                    childArgs
                                });
                            }
                        }
                    }

                    const supersedingPid = Provisioner.findSupersedingSshdPid(candidateStart, otherSessions);
                    if (supersedingPid !== null) {
                        logger.log(
                            `Identified superseded stale sshd session (PID ${pid}, older than active sshd PID ${supersedingPid}) for reclamation`,
                            false
                        );
                        return true;
                    }
                }

                logger.log(`Skipping active sshd session (PID ${pid}) with live child processes`, false);
                return false;
            }

            return true;
        } catch {
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
            let pids = await Provisioner.getListeningPids(port);
            // Under unprivileged Linux accounts, `lsof` and `ss -lptn` hide the PID of setuid-dropped `sshd`
            // workers even when the port is actively bound in LISTEN state by a zombie `sshd` session.
            if (pids.length === 0 && await Provisioner.isPortListeningUnprivileged(port)) {
                pids = await Provisioner.getUnprivilegedUserSshdPids();
            }
            if (pids.length === 0) {
                return { success: true, message: `No active process holding port ${port}`, pidsKilled: [] };
            }

            const protectedPids = await Provisioner.getProtectedPids(port);

            for (const pid of pids) {
                const isSafe = await Provisioner.isSafeZombieCandidate(pid, protectedPids);
                if (!isSafe) {
                    logger.log(`Protected active process PID ${pid} on port ${port} from termination`, false);
                    continue;
                }
                try {
                    await execAsync(`kill -15 ${pid} 2>/dev/null || true`);
                    // Poll rapidly (up to 120ms) for graceful exit before issuing SIGKILL
                    for (let i = 0; i < 6; i++) {
                        await new Promise(resolve => setTimeout(resolve, 20));
                        try {
                            await fs.access(`/proc/${pid}`);
                        } catch {
                            break;
                        }
                    }
                    await execAsync(`kill -9 ${pid} 2>/dev/null || true`);
                    pidsKilled.push(pid);
                } catch {
                    // Ignore individual kill errors
                }
            }

            if (pidsKilled.length > 0) {
                logger.log(`Port ${port} reclaimed. Terminated zombie PIDs: ${pidsKilled.join(', ')}`, false);
                // Verify the kernel actually released the listener; the kernel may take a moment to tear down sockets.
                let stillListening = true;
                for (let i = 0; i < 10 && stillListening; i++) {
                    await new Promise(resolve => setTimeout(resolve, 50));
                    stillListening = await Provisioner.isPortListeningUnprivileged(port);
                }
                if (stillListening) {
                    const backlog = await Provisioner.getStuckSendQueueBytes();
                    logger.log(
                        `Port ${port} is still in LISTEN state after reclaiming PIDs ${pidsKilled.join(', ')}` +
                        (backlog > 0 ? ` (stuck ESTABLISHED Send-Q backlog: ${backlog} bytes)` : ''),
                        false
                    );
                }
            }
            return {
                success: true,
                message: pidsKilled.length > 0
                    ? `Successfully released port ${port} (terminated ${pidsKilled.length} zombie process(es))`
                    : `No zombie processes holding port ${port} (active session protected)`,
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
     * Terminate dead or zombie processes holding any port in a contiguous range
     * (e.g. primary port and fallback ports)
     */
    public static async reclaimPortRange(
        basePort: number,
        count: number = 4
    ): Promise<{ success: boolean; message: string; pidsKilled: number[] }> {
        const allKilled: number[] = [];
        for (let i = 0; i < count; i++) {
            const p = basePort + i;
            if (p > 0 && p <= 65535) {
                const res = await Provisioner.reclaimPort(p);
                for (const pid of res.pidsKilled) {
                    if (!allKilled.includes(pid)) {
                        allKilled.push(pid);
                    }
                }
            }
        }
        return {
            success: true,
            message: allKilled.length > 0
                ? `Successfully cleared ports ${basePort}-${basePort + count - 1} (terminated ${allKilled.length} zombie process(es))`
                : `No zombie processes found on ports ${basePort}-${basePort + count - 1}`,
            pidsKilled: allKilled
        };
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

    /**
     * Purge residual caches, temporary wrapper artifacts, and orphaned states across remote workspaces
     */
    public static async purgeStaleCaches(): Promise<{ success: boolean; message: string }> {
        try {
            const homeDir = os.homedir();
            const serverDirs = [
                path.join(homeDir, '.ag-wormhole'),
                path.join(homeDir, '.antigravity-ide-server'),
                path.join(homeDir, '.antigravity-server')
            ];

            // 1. Remove temporary setup and state artifacts
            await execAsync('rm -rf /tmp/ag_wormhole_* /tmp/*wormhole*.sh /tmp/wormhole_* 2>/dev/null || true');

            // 2. Clean temporary files in server workspaces
            for (const dir of serverDirs) {
                try {
                    await execAsync(`find "${dir}" -maxdepth 3 -name "*.tmp.*" -type f -delete 2>/dev/null || true`);
                } catch {
                    // Ignore workspace missing
                }
            }

            // 3. Terminate any orphaned mgraftcp processes
            await execAsync('pkill -f "[m]graftcp-fakedns" 2>/dev/null || true');

            logger.log('Purged stale remote wormhole caches and temporary files.', false);
            return { success: true, message: 'Remote stale caches and orphaned processes purged.' };
        } catch (err: unknown) {
            const e = err as { message?: string };
            logger.log(`Notice during cache purge: ${e.message}`, false);
            return { success: false, message: `Cache purge completed with notice: ${e.message}` };
        }
    }
}

