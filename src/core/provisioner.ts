/**
 * AG-Wormhole - Remote Provisioning & Sandbox Engine
 */

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import * as net from 'net';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '../shared/logger';
import { LanguageServerProcessInfo, SshTunnelPortProbeState } from '../shared/types';
import { getSystemArchitecture } from '../shared/environment';
import { ALL_FALLBACK_PORT_OFFSETS } from '../shared/constants';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

export class Provisioner {
    private static cachedLsInfo: { info: LanguageServerProcessInfo; timestamp: number } | null = null;
    private static cachedMgraftcpRunning: { running: boolean; timestamp: number } | null = null;
    private static cachedAgyConfigured: { configured: boolean; timestamp: number } | null = null;

    /**
     * Ensure executable permissions for engine binaries
     */
    public static async ensureExecutablePermissions(extensionPath: string): Promise<void> {
        const arch = getSystemArchitecture();
        const binaryName = `mgraftcp-fakedns-linux-${arch}`;
        const binaryPath = path.join(extensionPath, 'resources', 'bin', binaryName);

        try {
            await fs.chmod(binaryPath, 0o755);
            logger.log(`Set executable flag on engine binary: ${binaryPath}`, false);
        } catch (error) {
            logger.log(`Notice: Could not chmod ${binaryPath}: ${error}`, false);
        }
    }

    /**
     * Probe whether mgraftcp is currently executing
     */
    public static async isMgraftcpRunning(forceRefresh: boolean = false): Promise<boolean> {
        const now = Date.now();
        if (!forceRefresh && Provisioner.cachedMgraftcpRunning && now - Provisioner.cachedMgraftcpRunning.timestamp < 30000) {
            return Provisioner.cachedMgraftcpRunning.running;
        }
        try {
            const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
            const pgrepArgs = uid !== undefined
                ? ['-u', String(uid), '-f', '[m]graftcp-fakedns']
                : ['-f', '[m]graftcp-fakedns'];
            const { stdout } = await execFileAsync('pgrep', pgrepArgs, { timeout: 2000 });
            const running = stdout.trim().length > 0;
            Provisioner.cachedMgraftcpRunning = { running, timestamp: now };
            return running;
        } catch {
            Provisioner.cachedMgraftcpRunning = { running: false, timestamp: now };
            return false;
        }
    }

    /**
     * Check whether modern Antigravity AGY runtime is installed and synchronized with AG-Wormhole
     */
    public static async isAgyRuntimeConfigured(forceRefresh: boolean = false): Promise<boolean> {
        const now = Date.now();
        if (!forceRefresh && Provisioner.cachedAgyConfigured && now - Provisioner.cachedAgyConfigured.timestamp < 30000) {
            return Provisioner.cachedAgyConfigured.configured;
        }
        const homeDir = os.homedir();
        const serverDirs = [
            path.join(homeDir, '.ag-wormhole'),
            path.join(homeDir, '.antigravity-ide-server'),
            path.join(homeDir, '.antigravity-server'),
            path.join(homeDir, '.vscode-server')
        ];

        for (const dir of serverDirs) {
            const stateFile = path.join(dir, '.wormhole-state.json');
            try {
                await fs.access(stateFile);
                Provisioner.cachedAgyConfigured = { configured: true, timestamp: now };
                return true;
            } catch {
                // Continue checking
            }
        }

        const agyBinary = path.join(homeDir, '.gemini', 'bin', 'agy');
        try {
            await fs.access(agyBinary);
            if (process.env.HTTP_PROXY || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.https_proxy) {
                Provisioner.cachedAgyConfigured = { configured: true, timestamp: now };
                return true;
            }
        } catch {
            // AGY binary not found
        }

        Provisioner.cachedAgyConfigured = { configured: false, timestamp: now };
        return false;
    }

    /**
     * Pure helper to inspect `ps` output for active Language Server or AGY Hub processes
     * and verify whether legacy binaries are actually traced by a `mgraftcp-fakedns` ancestor.
     */
    public static parseLanguageServerFromPs(
        stdout: string,
        currentPid: number
    ): {
        legacyCandidate: { pid: number; ppid: number; isPersistent: boolean; isTracedByMgraftcp: boolean } | null;
        agyCandidate: { pid: number; ppid: number } | null;
        hasMgraftcpProcess: boolean;
    } {
        let hasMgraftcpProcess = false;
        const ppidMap = new Map<number, number>();
        const mgraftcpPids = new Set<number>();
        const rawLegacy: Array<{ pid: number; ppid: number; isPersistent: boolean; cmd: string }> = [];
        const agyCandidates: Array<{ pid: number; ppid: number }> = [];

        for (const rawLine of stdout.split('\n')) {
            const line = rawLine.trim();
            if (!line) {
                continue;
            }
            const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line);
            if (!match) {
                continue;
            }
            const pid = parseInt(match[1], 10);
            const ppid = parseInt(match[2], 10);
            const cmd = match[3];
            if (isNaN(pid) || pid <= 0 || isNaN(ppid)) {
                continue;
            }

            ppidMap.set(pid, ppid);

            if (cmd.includes('mgraftcp-fakedns')) {
                hasMgraftcpProcess = true;
                mgraftcpPids.add(pid);
                continue;
            }

            if (cmd.includes('language_server_linux')) {
                const isPersistent = cmd.includes('--persistent_mode') || cmd.includes('persistent_mode');
                rawLegacy.push({ pid, ppid, isPersistent, cmd });
            } else if (cmd.includes('/.gemini/bin/agy') || cmd.includes('agy --hub')) {
                agyCandidates.push({ pid, ppid });
            }
        }

        const hasMgraftcpAncestor = (startPid: number): boolean => {
            const visited = new Set<number>([startPid]);
            let curr = ppidMap.get(startPid);
            for (let depth = 0; depth < 6 && curr !== undefined && curr > 1; depth++) {
                if (mgraftcpPids.has(curr)) {
                    return true;
                }
                if (visited.has(curr)) {
                    break;
                }
                visited.add(curr);
                curr = ppidMap.get(curr);
            }
            return false;
        };

        const legacyCandidates = rawLegacy.map((c) => ({
            pid: c.pid,
            ppid: c.ppid,
            isPersistent: c.isPersistent,
            isTracedByMgraftcp: c.cmd.includes('mgraftcp') || hasMgraftcpAncestor(c.pid)
        }));

        legacyCandidates.sort((a, b) => {
            const aParentRank = a.ppid > 1 ? 0 : 1;
            const bParentRank = b.ppid > 1 ? 0 : 1;
            if (aParentRank !== bParentRank) {
                return aParentRank - bParentRank;
            }
            const aProxyRank = a.isTracedByMgraftcp ? 0 : 1;
            const bProxyRank = b.isTracedByMgraftcp ? 0 : 1;
            if (aProxyRank !== bProxyRank) {
                return aProxyRank - bProxyRank;
            }
            return b.pid - a.pid;
        });

        // Prioritize the agy process owned by the current Extension Host (ppid === currentPid),
        // followed by active parented sessions (ppid > 1), and lastly orphaned ppid === 1 processes.
        agyCandidates.sort((a, b) => {
            const rank = (c: { pid: number; ppid: number }): number => {
                if (c.ppid === currentPid) {
                    return 0;
                }
                if (c.ppid > 1) {
                    return 1;
                }
                return 2;
            };
            return rank(a) - rank(b) || b.pid - a.pid;
        });

        return {
            legacyCandidate: legacyCandidates[0] ?? null,
            agyCandidate: agyCandidates[0] ?? null,
            hasMgraftcpProcess
        };
    }

    private static async isProcessAliveNotZombie(pid: number): Promise<boolean> {
        try {
            const statContent = await fs.readFile(`/proc/${pid}/stat`, 'utf-8');
            const closeParenIdx = statContent.lastIndexOf(')');
            if (closeParenIdx === -1) {
                return false;
            }
            const fields = statContent.slice(closeParenIdx + 2).trim().split(/\s+/);
            const state = fields[0];
            return Boolean(state && state !== 'Z' && state !== 'X');
        } catch {
            return false;
        }
    }

    /**
     * Inspect active Language Server / AGY runtime process state and proxy status.
     * Uses zero-fork /proc/<pid>/stat liveness verification on cached PIDs to avoid spawning
     * shell/ps subprocesses on periodic status refreshes.
     */
    public static async getLanguageServerProcess(forceRefresh: boolean = false): Promise<LanguageServerProcessInfo | null> {
        const now = Date.now();
        if (
            !forceRefresh &&
            Provisioner.cachedLsInfo &&
            Provisioner.cachedLsInfo.info.isUsingProxy &&
            now - Provisioner.cachedLsInfo.timestamp < 60000
        ) {
            if (await Provisioner.isProcessAliveNotZombie(Provisioner.cachedLsInfo.info.pid)) {
                return Provisioner.cachedLsInfo.info;
            }
            Provisioner.cachedLsInfo = null;
        }

        try {
            const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
            const psArgs = uid !== undefined
                ? ['-u', String(uid), '-o', 'pid=,ppid=,args=']
                : ['-eo', 'pid=,ppid=,args='];
            const { stdout } = await execFileAsync('ps', psArgs, {
                timeout: 3000,
                maxBuffer: 512 * 1024
            });

            const parsed = Provisioner.parseLanguageServerFromPs(stdout, process.pid);
            Provisioner.cachedMgraftcpRunning = { running: parsed.hasMgraftcpProcess, timestamp: now };

            if (parsed.legacyCandidate) {
                const info: LanguageServerProcessInfo = {
                    pid: parsed.legacyCandidate.pid,
                    isPersistent: parsed.legacyCandidate.isPersistent,
                    isUsingProxy: parsed.legacyCandidate.isTracedByMgraftcp,
                    runtimeType: 'legacy'
                };
                Provisioner.cachedLsInfo = { info, timestamp: now };
                return info;
            }

            if (parsed.agyCandidate) {
                const chosen = parsed.agyCandidate;
                let envReadable = false;
                let hasProxyEnv = false;
                try {
                    const envRaw = await fs.readFile(`/proc/${chosen.pid}/environ`, 'utf-8');
                    envReadable = true;
                    hasProxyEnv = /HTTP_PROXY=|HTTPS_PROXY=|http_proxy=|https_proxy=|ALL_PROXY=|all_proxy=/i.test(envRaw);
                } catch {
                    // Fallback when /proc/<pid>/environ is restricted
                }
                const stateConfigured = await Provisioner.isAgyRuntimeConfigured();
                const info: LanguageServerProcessInfo = {
                    pid: chosen.pid,
                    isPersistent: false,
                    isUsingProxy: envReadable ? hasProxyEnv : stateConfigured,
                    runtimeType: 'agy'
                };
                Provisioner.cachedLsInfo = { info, timestamp: now };
                return info;
            }
        } catch {
            // Process scan failed or unsupported platform
        }

        Provisioner.cachedLsInfo = null;
        return null;
    }

    /**
     * Terminate Language Server process to enforce wrapper adoption
     */
    public static async restartLanguageServer(): Promise<boolean> {
        const proc = await Provisioner.getLanguageServerProcess(true);
        if (!proc) {
            logger.log('No Language Server process found to restart', false);
            return false;
        }

        Provisioner.cachedLsInfo = null;
        try {
            logger.log(`Terminating Language Server process (PID: ${proc.pid}, persistent: ${proc.isPersistent})`, false);
            try {
                process.kill(proc.pid, 'SIGTERM');
            } catch {
                // Already exited or inaccessible
            }
            await new Promise(resolve => setTimeout(resolve, 1000));

            const stillRunning = await Provisioner.getLanguageServerProcess(true);
            if (stillRunning && stillRunning.pid === proc.pid) {
                logger.log('Process still active, issuing SIGKILL', false);
                try {
                    process.kill(proc.pid, 'SIGKILL');
                } catch {
                    // Already exited
                }
            }
            Provisioner.cachedLsInfo = null;
            logger.log('Language Server terminated successfully', false);
            return true;
        } catch (error) {
            logger.log(`Failed to restart Language Server: ${error}`, false);
            return false;
        }
    }

    /**
     * Atomically synchronize ~/.ag-wormhole/proxy.env for external shells (tmux/screen/nohup)
     */
    public static async syncProxyEnvHelper(host: string, port: number, proxyType: string): Promise<void> {
        const envDir = path.join(os.homedir(), '.ag-wormhole');
        const envFile = path.join(envDir, 'proxy.env');
        const envTmp = `${envFile}.tmp.${process.pid}`;
        const proxyAddr = `${host}:${port}`;
        const content = [
            '# AG-Wormhole Environment Variables',
            '# Source this file in tmux, screen, nohup, or external terminal sessions:',
            '#   source ~/.ag-wormhole/proxy.env',
            `export http_proxy="http://${proxyAddr}"`,
            `export https_proxy="http://${proxyAddr}"`,
            `export HTTP_PROXY="http://${proxyAddr}"`,
            `export HTTPS_PROXY="http://${proxyAddr}"`,
            `export all_proxy="${proxyType}://${proxyAddr}"`,
            `export ALL_PROXY="${proxyType}://${proxyAddr}"`,
            'export no_proxy="localhost,127.0.0.1,::1"',
            'export NO_PROXY="localhost,127.0.0.1,::1"',
            ''
        ].join('\n');

        await fs.mkdir(envDir, { recursive: true });
        await fs.writeFile(envTmp, content, 'utf-8');
        await fs.rename(envTmp, envFile);
        await fs.chmod(envFile, 0o644).catch(() => {});
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
for DIR in "$HOME/.ag-wormhole" "$HOME/.antigravity-ide-server" "$HOME/.antigravity-server" "$HOME/.vscode-server"; do
    FOUND=$(find "$DIR" -path "*/extensions/antigravity/bin/*" -name "language_server_linux_*.bak" -type f 2>/dev/null || true)
    [ -n "$FOUND" ] && BAKS="$BAKS\\n$FOUND"
    rm -f "$DIR/.wormhole-state.json" "$DIR/.wormhole-state.json.tmp."* 2>/dev/null || true
done
BAKS=$(echo -e "$BAKS" | sed '/^$/d')

rm -f "$HOME/.ag-wormhole/proxy.env" "$HOME/.ag-wormhole/proxy.env.tmp."* 2>/dev/null || true
rm -rf /tmp/ag_wormhole_* /tmp/*wormhole*.sh /tmp/wormhole_* 2>/dev/null || true

RESTORED=0
if [ -n "$BAKS" ]; then
    while IFS= read -r BAK; do
        [ -z "$BAK" ] && continue
        TARGET="\${BAK%.bak}"
        echo "Restoring: $TARGET"
        [ -f "$TARGET" ] && rm -f "$TARGET"
        mv "$BAK" "$TARGET"
        RESTORED=$((RESTORED + 1))
    done <<< "$BAKS"
fi

echo "[AG-Wormhole] Rollback complete: $RESTORED binary file(s) restored, runtime state reset."
`;
    }

    /**
     * Execute setup script silently
     */
    public static async runSetupSilently(host: string, port: number, proxyType: string, extensionPath: string): Promise<boolean> {
        const scriptPath = path.join(extensionPath, 'scripts', 'setup-proxy.sh');

        try {
            await fs.chmod(scriptPath, 0o755).catch(() => {});

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

            const { stdout, stderr } = await execFileAsync('bash', [scriptPath], {
                env,
                timeout: 15000,
                maxBuffer: 1024 * 1024
            });
            const output = [stdout, stderr].filter(Boolean).join('\n');
            logger.log(`Setup execution output: ${output}`, false);

            const isNewConfig = output.includes('Setup complete') ||
                (output.includes('Configured:') && !output.includes('Skipped:'));
            const isAlreadyConfigured = output.includes('Already configured') || output.includes('already synchronized');

            if (isNewConfig || isAlreadyConfigured) {
                const proc = await Provisioner.getLanguageServerProcess(true);
                if (proc && proc.runtimeType !== 'agy') {
                    const endpointChanged =
                        output.includes('proxy_addr:') ||
                        output.includes('proxy_type:') ||
                        output.includes('new_install');
                    const needsWrapperRestart = isNewConfig
                        ? (!proc.isUsingProxy || (proc.isPersistent && endpointChanged))
                        : !proc.isUsingProxy;

                    if (needsWrapperRestart) {
                        if (await Provisioner.hasAnyHealthyTunnelPort(port)) {
                            await Provisioner.restartLanguageServer();
                        } else {
                            logger.log('Skipping Language Server restart: no active proxy tunnel detected (Direct Mode preserved)', false);
                        }
                    }
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
     * Retrieve socket inode numbers associated with a listening TCP port from /proc/net/tcp{,6}
     */
    public static async getListeningSocketInodes(port: number): Promise<Set<string>> {
        const inodes = new Set<string>();
        if (!port || port <= 0 || port > 65535) {
            return inodes;
        }
        const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
        const files = ['/proc/net/tcp', '/proc/net/tcp6'];

        for (const file of files) {
            try {
                const content = await fs.readFile(file, 'utf-8');
                const lines = content.split('\n');
                for (let i = 1; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (!line) {
                        continue;
                    }
                    const parts = line.split(/\s+/);
                    if (parts.length >= 10 && parts[3] === '0A') {
                        const localAddr = parts[1];
                        if (localAddr && localAddr.endsWith(`:${hexPort}`)) {
                            const inode = parts[9];
                            if (inode && inode !== '0') {
                                inodes.add(inode);
                            }
                        }
                    }
                }
            } catch {
                // Ignore read errors
            }
        }
        return inodes;
    }

    /**
     * Verify whether a process holds a socket descriptor matching any of the specified inodes
     */
    public static async processHoldsSocketInode(pid: number, targetInodes: Set<string>): Promise<boolean> {
        if (targetInodes.size === 0) {
            return false;
        }
        try {
            const fdDir = `/proc/${pid}/fd`;
            const fds = await fs.readdir(fdDir);
            for (const fd of fds) {
                try {
                    const link = await fs.readlink(path.join(fdDir, fd));
                    const match = /^socket:\[(\d+)\]$/.exec(link);
                    if (match && targetInodes.has(match[1])) {
                        return true;
                    }
                } catch {
                    // Ignore inaccessible fd
                }
            }
        } catch {
            // Process might have terminated or /proc is restricted
        }
        return false;
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
     * Fast L7 probe to verify whether a local port is actively responding to HTTP or SOCKS5 proxy handshakes.
     * Prevents reclaiming healthy active tunnels or background keepers.
     */
    public static async isPortHealthyL7(port: number, timeoutMs: number = 800): Promise<boolean> {
        if (!port || port <= 0 || port > 65535) {
            return false;
        }

        const probeHttp = (): Promise<boolean> =>
            new Promise((resolve) => {
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
                s.setTimeout(timeoutMs);
                s.on('connect', () => {
                    try {
                        s.write('HEAD / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
                    } catch {
                        finish(false);
                    }
                });
                s.on('data', (chunk) => {
                    const text = chunk ? chunk.toString('utf8') : '';
                    finish(/^HTTP\/\d/i.test(text));
                });
                s.on('timeout', () => finish(false));
                s.on('error', () => finish(false));
                s.on('close', () => finish(false));
                s.connect(port, '127.0.0.1');
            });

        if (await probeHttp()) {
            return true;
        }

        const probeSocks5 = (): Promise<boolean> =>
            new Promise((resolve) => {
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
                s.setTimeout(timeoutMs);
                s.on('connect', () => {
                    try {
                        s.write(Buffer.from([0x05, 0x01, 0x00]));
                    } catch {
                        finish(false);
                    }
                });
                s.on('data', (chunk) => {
                    finish(Boolean(chunk && chunk.length >= 2 && chunk[0] === 0x05));
                });
                s.on('timeout', () => finish(false));
                s.on('error', () => finish(false));
                s.on('close', () => finish(false));
                s.connect(port, '127.0.0.1');
            });

        return probeSocks5();
    }

    /**
     * Check whether the primary proxy port or any cluster fallback port is healthy at L7.
     */
    public static async hasAnyHealthyTunnelPort(basePort: number, timeoutMs: number = 500): Promise<boolean> {
        if (!basePort || basePort <= 0 || basePort > 65535) {
            return false;
        }
        const candidates = [basePort, ...ALL_FALLBACK_PORT_OFFSETS.map(o => basePort + o)];
        for (const p of candidates) {
            if (p > 0 && p <= 65535 && await Provisioner.isPortHealthyL7(p, timeoutMs)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Classify a local SSH forwarded port into three states:
     * - 'healthy': responds to HTTP or SOCKS5 proxy handshakes
     * - 'ssh-alive-proxy-down': TCP connects and sshd returns clean EOF (`SSH2_MSG_CHANNEL_OPEN_FAILURE`)
     *   because the local proxy is temporarily down/restarting while the SSH tunnel itself is live
     * - 'dead': closed (`ECONNREFUSED`) or hung blackhole zombie (`timeout`)
     */
    public static async probeSshTunnelPort(port: number, timeoutMs: number = 600): Promise<SshTunnelPortProbeState> {
        if (!port || port <= 0 || port > 65535) {
            return 'dead';
        }

        const probeSingle = (
            mode: 'http' | 'socks5',
            budgetMs: number
        ): Promise<'healthy' | 'eof' | 'reset-after-connect' | 'dead'> =>
            new Promise((resolve) => {
                const s = new net.Socket();
                let settled = false;
                let connected = false;
                let sawErrorOrTimeout = false;

                const finish = (state: 'healthy' | 'eof' | 'reset-after-connect' | 'dead') => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    s.removeAllListeners();
                    s.destroy();
                    resolve(state);
                };

                s.setTimeout(budgetMs);
                s.on('connect', () => {
                    connected = true;
                    try {
                        if (mode === 'socks5') {
                            s.write(Buffer.from([0x05, 0x01, 0x00]));
                        } else {
                            s.write('HEAD / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
                        }
                    } catch {
                        sawErrorOrTimeout = true;
                        finish('dead');
                    }
                });
                s.on('data', (chunk) => {
                    if (!chunk || chunk.length === 0) {
                        return;
                    }
                    if (mode === 'socks5') {
                        finish(chunk.length >= 2 && chunk[0] === 0x05 ? 'healthy' : 'reset-after-connect');
                    } else {
                        const text = chunk.toString('utf8');
                        finish(/^HTTP\/\d/i.test(text) ? 'healthy' : 'reset-after-connect');
                    }
                });
                s.on('end', () => {
                    finish(connected && !sawErrorOrTimeout ? 'eof' : 'dead');
                });
                s.on('timeout', () => {
                    sawErrorOrTimeout = true;
                    finish('dead');
                });
                s.on('error', () => {
                    sawErrorOrTimeout = true;
                    finish(connected ? 'reset-after-connect' : 'dead');
                });
                s.on('close', () => {
                    if (!settled) {
                        finish(connected && !sawErrorOrTimeout ? 'eof' : 'dead');
                    }
                });
                s.connect(port, '127.0.0.1');
            });

        const httpRes = await probeSingle('http', timeoutMs);
        if (httpRes === 'healthy') {
            return 'healthy';
        }
        if (httpRes === 'dead') {
            return 'dead';
        }

        const socksRes = await probeSingle('socks5', Math.min(timeoutMs, 500));
        if (socksRes === 'healthy') {
            return 'healthy';
        }
        if (httpRes === 'eof' && socksRes === 'eof') {
            return 'ssh-alive-proxy-down';
        }
        return 'dead';
    }

    /**
     * Verify whether a keeper port (`basePort + 3`) represents an active SSH tunnel session:
     * returns `true` if it responds to L7 proxy handshakes OR if TCP connects and cleanly sends EOF (`FIN`),
     * which occurs when the local `ssh.exe` keeper is alive and immediately returns
     * `SSH2_MSG_CHANNEL_OPEN_FAILURE` while the local proxy is briefly restarting.
     * Hung/blackhole sockets (dead peer) and `ECONNREFUSED` return `false`.
     */
    public static async isKeeperSshSessionAlive(port: number, timeoutMs: number = 500): Promise<boolean> {
        const state = await Provisioner.probeSshTunnelPort(port, timeoutMs);
        return state === 'healthy' || state === 'ssh-alive-proxy-down';
    }

    /**
     * Collect all ancestor PIDs of the current Extension Host up to PID 1
     * to prevent terminating the active SSH daemon or remote IDE server tree.
     */
    public static async getProtectedPids(port: number, basePort?: number): Promise<Set<number>> {
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

        // 2. Protect active dedicated background keeper listener on (basePort ?? port) + 3 when its SSH session is alive.
        // Using basePort ensures reclaiming fallback ports (e.g. 7891, 7892) still protects the keeper on 7893.
        const effectiveBasePort = basePort ?? port;
        const keeperPort = effectiveBasePort + 3;
        if (keeperPort > 0 && keeperPort <= 65535) {
            const isKeeperPortAlive = await Provisioner.isKeeperSshSessionAlive(keeperPort, 500);

            if (isKeeperPortAlive) {
                const keeperPids = await Provisioner.getListeningPids(keeperPort);
                for (const pid of keeperPids) {
                    protectedPids.add(pid);
                }
                // Under unprivileged Linux accounts, `ss -lptn` hides `sshd` PIDs.
                // First try exact /proc/net/tcp{,6} socket inode matching for keeperPort;
                // only fall back to protecting the newest childless `sshd` if inode lookup is unavailable.
                if (keeperPids.length === 0) {
                    const keeperInodes = await Provisioner.getListeningSocketInodes(keeperPort);
                    const userSshdPids = await Provisioner.getUnprivilegedUserSshdPids();
                    let matchedByInode = false;
                    if (keeperInodes.size > 0) {
                        for (const sshdPid of userSshdPids) {
                            if (await Provisioner.processHoldsSocketInode(sshdPid, keeperInodes)) {
                                protectedPids.add(sshdPid);
                                matchedByInode = true;
                            }
                        }
                    }
                    if (!matchedByInode) {
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
            // Only an sshd with zero child processes (and not in protectedPids) is an orphaned tunnel session.
            // Never kill an sshd that still has live child processes (e.g. `sh` or `bash -s`), because
            // Remote-SSH routinely maintains multiple concurrent sshd sessions across windows/multiplexed channels.
            if (cmdLine.includes('sshd')) {
                const { stdout: childrenOut } = await execAsync(`pgrep -P ${pid} 2>/dev/null || true`);
                if (childrenOut.trim().length === 0) {
                    return true;
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
    public static async reclaimPort(
        port: number,
        basePort?: number
    ): Promise<{ success: boolean; message: string; pidsKilled: number[] }> {
        if (!port || port <= 0 || port > 65535) {
            return { success: false, message: `Invalid port ${port}`, pidsKilled: [] };
        }

        const pidsKilled: number[] = [];
        try {
            // Fast-path SSH/L7 guard: never reclaim a port that is healthy at L7 OR backed by a live
            // SSH tunnel returning clean EOF while the local proxy is temporarily restarting.
            const tunnelState = await Provisioner.probeSshTunnelPort(port, 800);
            if (tunnelState === 'healthy') {
                return {
                    success: true,
                    message: `Port ${port} is healthy at L7 (reclamation skipped)`,
                    pidsKilled: []
                };
            }
            if (tunnelState === 'ssh-alive-proxy-down') {
                logger.log(`Port ${port} has an active SSH tunnel (local proxy temporarily down); reclamation skipped`, false);
                return {
                    success: true,
                    message: `Port ${port} has an active SSH tunnel (local proxy temporarily unreachable; reclamation skipped)`,
                    pidsKilled: []
                };
            }

            let pids = await Provisioner.getListeningPids(port);
            // Under unprivileged Linux accounts, `lsof` and `ss -lptn` hide the PID of setuid-dropped `sshd`
            // workers even when the port is actively bound in LISTEN state by a zombie `sshd` session.
            // Match against socket inodes in /proc/net/tcp{,6} to avoid terminating unrelated sshd processes.
            if (pids.length === 0 && await Provisioner.isPortListeningUnprivileged(port)) {
                const listeningInodes = await Provisioner.getListeningSocketInodes(port);
                const candidateSshdPids = await Provisioner.getUnprivilegedUserSshdPids();
                if (listeningInodes.size > 0) {
                    for (const candidatePid of candidateSshdPids) {
                        if (await Provisioner.processHoldsSocketInode(candidatePid, listeningInodes)) {
                            pids.push(candidatePid);
                        }
                    }
                }
            }
            if (pids.length === 0) {
                return { success: true, message: `No active process holding port ${port}`, pidsKilled: [] };
            }

            const protectedPids = await Provisioner.getProtectedPids(port, basePort);

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
                const res = await Provisioner.reclaimPort(p, basePort);
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
     * Determine which PPid=1 runtime processes are genuinely orphaned and safe to reap.
     * Protects active `agy --hub` processes when any IDE server/extension host is alive,
     * and protects `mgraftcp-fakedns` processes that still host active child processes.
     */
    public static findSafeOrphanPids(psStdout: string, currentPid: number, activeLsPid?: number): number[] {
        interface ProcEntry {
            pid: number;
            ppid: number;
            cmd: string;
        }
        const entries: ProcEntry[] = [];
        const childCounts = new Map<number, number>();
        let hasActiveIdeServer = false;

        for (const rawLine of psStdout.split('\n')) {
            const line = rawLine.trim();
            if (!line) {
                continue;
            }
            const match = /^(\d+)\s+(\d+)\s+(.*)$/.exec(line);
            if (!match) {
                continue;
            }
            const pid = parseInt(match[1], 10);
            const ppid = parseInt(match[2], 10);
            const cmd = match[3];
            if (isNaN(pid) || pid <= 1 || isNaN(ppid)) {
                continue;
            }
            entries.push({ pid, ppid, cmd });
            childCounts.set(ppid, (childCounts.get(ppid) || 0) + 1);

            if (
                cmd.includes('antigravity-server') ||
                cmd.includes('antigravity-ide-server') ||
                cmd.includes('vscode-server') ||
                cmd.includes('language_server_linux')
            ) {
                hasActiveIdeServer = true;
            }
        }

        const safeToReap: number[] = [];
        for (const entry of entries) {
            if (entry.ppid !== 1 || entry.pid === currentPid || (activeLsPid !== undefined && entry.pid === activeLsPid)) {
                continue;
            }
            if (entry.cmd.includes('notify-send --wait --app-name=Antigravity')) {
                safeToReap.push(entry.pid);
            } else if (entry.cmd.includes('mgraftcp-fakedns')) {
                // Only reap mgraftcp-fakedns when its wrapped child has already exited
                if ((childCounts.get(entry.pid) || 0) === 0) {
                    safeToReap.push(entry.pid);
                }
            } else if (/\/\.gemini\/bin\/agy\b/.test(entry.cmd) && entry.cmd.includes('--hub')) {
                // Never kill an agy --hub daemon while an IDE server session is active
                if (!hasActiveIdeServer && (childCounts.get(entry.pid) || 0) === 0) {
                    safeToReap.push(entry.pid);
                }
            }
        }
        return safeToReap;
    }

    /**
     * Reap genuinely orphaned PPid=1 runtime processes (e.g. hung `notify-send` or exited `mgraftcp-fakedns` shells)
     * without terminating active `agy --hub` or live wrapped Language Server instances.
     */
    public static async reapOrphanProcesses(): Promise<number[]> {
        if (process.platform !== 'linux') {
            return [];
        }
        const reaped: number[] = [];
        try {
            const activeLs = await Provisioner.getLanguageServerProcess();
            const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
            const args = uid !== undefined
                ? ['-u', String(uid), '-o', 'pid=,ppid=,args=']
                : ['-eo', 'pid=,ppid=,args='];
            const { stdout } = await execFileAsync('ps', args, { timeout: 3000, maxBuffer: 512 * 1024 });
            const candidates = Provisioner.findSafeOrphanPids(stdout, process.pid, activeLs?.pid);

            for (const pid of candidates) {
                try {
                    process.kill(pid, 'SIGKILL');
                    reaped.push(pid);
                } catch {
                    // Ignore EPERM/ESRCH
                }
            }
            if (reaped.length > 0) {
                logger.log(`Reaped ${reaped.length} orphaned PPid=1 runtime process(es): ${reaped.join(', ')}`, false);
            }
        } catch {
            // Ignore process scan errors
        }
        return reaped;
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
                path.join(homeDir, '.antigravity-server'),
                path.join(homeDir, '.vscode-server')
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

            // 3. Reap orphaned PPID=1 runtime processes (agy --hub, mgraftcp-fakedns, notify-send)
            await Provisioner.reapOrphanProcesses();
            Provisioner.cachedLsInfo = null;
            Provisioner.cachedMgraftcpRunning = null;
            Provisioner.cachedAgyConfigured = null;

            logger.log('Purged stale remote wormhole caches and temporary files.', false);
            return { success: true, message: 'Remote stale caches and orphaned processes purged.' };
        } catch (err: unknown) {
            const e = err as { message?: string };
            logger.log(`Notice during cache purge: ${e.message}`, false);
            return { success: false, message: `Cache purge completed with notice: ${e.message}` };
        }
    }
}

