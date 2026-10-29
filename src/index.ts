/**
 * AG-Wormhole - Main Extension Entry Point
 * High-performance zero-privilege dual-plane proxy tunnel and syscall redirection sandbox
 */

import * as vscode from 'vscode';
import { logger } from './shared/logger';
import { isRunningLocally, isRunningRemotely, isLinuxPlatform } from './shared/environment';
import { ProxyStatus } from './shared/types';
import {
    CONFIG_SECTION,
    CFG_ENABLE_LOCAL_FORWARDING,
    CFG_LOCAL_PROXY_PORT,
    CFG_REMOTE_PROXY_HOST,
    CFG_REMOTE_PROXY_PORT,
    CFG_SHOW_STATUS_ON_STARTUP,
    CFG_PROXY_TYPE,
    DEFAULT_PROXY_PORT,
    DEFAULT_PROXY_HOST,
    DEFAULT_PROXY_TYPE,
    AUTO_REFRESH_INTERVAL_SEC,
    CMD_SETUP,
    CMD_ROLLBACK,
    CMD_ENABLE_FORWARDING,
    CMD_DISABLE_FORWARDING,
    CMD_TUNNEL_STATUS,
    CMD_CHECK_PROXY,
    CMD_SHOW_OUTPUT,
    CMD_SHOW_STATUS_PANEL,
    CMD_REFRESH_STATUS,
    CMD_DIAGNOSE,
    CMD_SHOW_TRAFFIC,
    CMD_RECLAIM_PORT,
    CMD_OPTIMIZE_SSH
} from './shared/constants';
import { SSHConfigManager } from './core/sshConfigManager';
import { TunnelManager } from './core/tunnelManager';
import { Provisioner } from './core/provisioner';
import { TrafficCollector } from './telemetry/trafficCollector';
import { StatusBarController } from './ui/statusBar';
import { StatusPanel } from './ui/statusPanel';
import { TunnelWatchdog } from './core/watchdog';

let statusBar: StatusBarController;
let trafficCollector: TrafficCollector;
let autoRefreshTimer: NodeJS.Timeout | undefined;

let currentStatus: ProxyStatus = {
    runningLocation: 'local',
    sshConfigEnabled: false,
    localProxyPort: DEFAULT_PROXY_PORT,
    remoteProxyPort: DEFAULT_PROXY_PORT,
    remoteProxyHost: DEFAULT_PROXY_HOST,
    localProxyReachable: false,
    remoteProxyReachable: false,
    lastUpdated: new Date()
};

async function refreshAllStatus(): Promise<ProxyStatus> {
    const isLocal = isRunningLocally();
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const localPort = config.get<number>(CFG_LOCAL_PROXY_PORT, DEFAULT_PROXY_PORT);
    const remoteHost = config.get<string>(CFG_REMOTE_PROXY_HOST, DEFAULT_PROXY_HOST);
    const remotePort = config.get<number>(CFG_REMOTE_PROXY_PORT, DEFAULT_PROXY_PORT);

    if (isLocal) {
        const sshStatus = await SSHConfigManager.getStatus();
        const localReachable = await TunnelManager.checkPortAvailable('127.0.0.1', localPort);

        currentStatus = {
            runningLocation: 'local',
            sshConfigEnabled: sshStatus.enabled,
            localProxyPort: localPort,
            remoteProxyPort: sshStatus.port ?? remotePort,
            remoteProxyHost: remoteHost,
            localProxyReachable: localReachable,
            remoteProxyReachable: false,
            lastUpdated: new Date()
        };
    } else {
        const remoteReachable = await TunnelManager.checkPortAvailable(remoteHost, remotePort);
        const lsProcess = await Provisioner.getLanguageServerProcess();
        const isMgraftcpRunning = await Provisioner.isMgraftcpRunning();

        currentStatus = {
            runningLocation: 'remote',
            sshConfigEnabled: false,
            localProxyPort: localPort,
            remoteProxyPort: remotePort,
            remoteProxyHost: remoteHost,
            localProxyReachable: false,
            remoteProxyReachable: remoteReachable,
            languageServerConfigured: lsProcess?.isUsingProxy || isMgraftcpRunning,
            lastUpdated: new Date()
        };
    }

    statusBar?.update(currentStatus);
    return currentStatus;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    logger.initialize(context);
    logger.log(`Activating AG-Wormhole... (Local: ${isRunningLocally()})`, isRunningLocally());

    statusBar = new StatusBarController();
    context.subscriptions.push(statusBar);

    trafficCollector = new TrafficCollector();
    context.subscriptions.push(trafficCollector);

    // Register Commands
    context.subscriptions.push(
        vscode.commands.registerCommand(CMD_SHOW_OUTPUT, () => {
            logger.show();
        }),

        vscode.commands.registerCommand(CMD_SHOW_STATUS_PANEL, () => {
            StatusPanel.createOrShow(
                context,
                currentStatus,
                isRunningRemotely() ? trafficCollector : undefined,
                async () => {
                    if (isRunningLocally()) {
                        await TunnelManager.syncLocalForwarding();
                    } else {
                        const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
                        const host = config.get<string>(CFG_REMOTE_PROXY_HOST, DEFAULT_PROXY_HOST);
                        const port = config.get<number>(CFG_REMOTE_PROXY_PORT, DEFAULT_PROXY_PORT);
                        const type = config.get<string>(CFG_PROXY_TYPE, DEFAULT_PROXY_TYPE);
                        await Provisioner.runSetupSilently(host, port, type, context.extensionUri.fsPath);
                    }
                    await refreshAllStatus();
                }
            );
        }),

        vscode.commands.registerCommand(CMD_REFRESH_STATUS, async () => {
            await refreshAllStatus();
        }),

        vscode.commands.registerCommand(CMD_DIAGNOSE, async () => {
            await vscode.commands.executeCommand(CMD_SHOW_STATUS_PANEL);
        }),

        vscode.commands.registerCommand(CMD_SHOW_TRAFFIC, () => {
            vscode.commands.executeCommand(CMD_SHOW_STATUS_PANEL);
        }),

        vscode.commands.registerCommand(CMD_RECLAIM_PORT, async () => {
            const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
            const port = config.get<number>(CFG_REMOTE_PROXY_PORT, DEFAULT_PROXY_PORT);
            const result = await Provisioner.reclaimPort(port);
            await refreshAllStatus();
            if (result.success) {
                vscode.window.showInformationMessage(`[AG-Wormhole] ${result.message}`);
            } else {
                vscode.window.showErrorMessage(`[AG-Wormhole] ${result.message}`);
            }
        }),

        vscode.commands.registerCommand(CMD_OPTIMIZE_SSH, async () => {
            const snippet = SSHConfigManager.getMultiplexingRecommendations();
            const action = await vscode.window.showInformationMessage(
                '[AG-Wormhole] Advanced SSH Keepalive & Multiplexing recommendations ready.',
                'Copy to Clipboard',
                'Open Status Dashboard'
            );
            if (action === 'Copy to Clipboard') {
                await vscode.env.clipboard.writeText(snippet);
                vscode.window.showInformationMessage('SSH multiplexing config copied to clipboard.');
            } else if (action === 'Open Status Dashboard') {
                await vscode.commands.executeCommand(CMD_SHOW_STATUS_PANEL);
            }
        })
    );

    if (isRunningLocally()) {
        await activateLocal(context);
    } else {
        await activateRemote(context);
    }

    // Start High-Availability Tunnel Watchdog
    const watchdog = TunnelWatchdog.getInstance();
    context.subscriptions.push(new vscode.Disposable(() => watchdog.stop()));
    watchdog.onStateChange(async () => {
        await refreshAllStatus();
    });
    watchdog.start();

    // Auto-refresh interval
    autoRefreshTimer = setInterval(async () => {
        await refreshAllStatus();
    }, AUTO_REFRESH_INTERVAL_SEC * 1000);

    await refreshAllStatus();
}

async function activateLocal(context: vscode.ExtensionContext): Promise<void> {
    logger.log('Initializing local control plane...', true);

    context.subscriptions.push(
        vscode.commands.registerCommand(CMD_ENABLE_FORWARDING, async () => {
            const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
            const lp = config.get<number>(CFG_LOCAL_PROXY_PORT, DEFAULT_PROXY_PORT);
            const rp = config.get<number>(CFG_REMOTE_PROXY_PORT, DEFAULT_PROXY_PORT);
            await SSHConfigManager.updateConfigFile(rp, lp, true);
            await refreshAllStatus();
            vscode.window.showInformationMessage(`[AG-Wormhole] SSH port forwarding enabled (Remote ${rp} -> Local ${lp}).`);
        }),

        vscode.commands.registerCommand(CMD_DISABLE_FORWARDING, async () => {
            await SSHConfigManager.updateConfigFile(0, 0, false);
            await refreshAllStatus();
            vscode.window.showInformationMessage('[AG-Wormhole] SSH port forwarding disabled.');
        }),

        vscode.commands.registerCommand(CMD_TUNNEL_STATUS, async () => {
            const status = await SSHConfigManager.getStatus();
            vscode.window.showInformationMessage(
                status.enabled
                    ? `[AG-Wormhole] Forwarding active on remote port ${status.port}`
                    : '[AG-Wormhole] SSH port forwarding is currently disabled.'
            );
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (e.affectsConfiguration(CONFIG_SECTION)) {
                await TunnelManager.syncLocalForwarding();
                await refreshAllStatus();
            }
        })
    );

    await TunnelManager.syncLocalForwarding();
}

async function activateRemote(context: vscode.ExtensionContext): Promise<void> {
    logger.log('Initializing remote data plane...', false);

    if (!isLinuxPlatform()) {
        logger.log(`Skipping remote sandbox injection: unsupported OS '${process.platform}' (Linux required)`, false);
        return;
    }

    const extensionPath = context.extensionUri.fsPath;
    await Provisioner.ensureExecutablePermissions(extensionPath);

    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    const remoteHost = config.get<string>(CFG_REMOTE_PROXY_HOST, DEFAULT_PROXY_HOST);
    const remotePort = config.get<number>(CFG_REMOTE_PROXY_PORT, DEFAULT_PROXY_PORT);
    const proxyType = config.get<string>(CFG_PROXY_TYPE, DEFAULT_PROXY_TYPE);

    context.subscriptions.push(
        vscode.commands.registerCommand(CMD_SETUP, async () => {
            const terminal = vscode.window.createTerminal('AG-Wormhole Setup');
            terminal.show();
            const script = await Provisioner.generateSetupScriptContent(remoteHost, remotePort, proxyType, extensionPath);
            terminal.sendText(`cat > /tmp/ag_wormhole_setup.sh << 'EOF'\n${script}\nEOF`);
            terminal.sendText('bash /tmp/ag_wormhole_setup.sh');
        }),

        vscode.commands.registerCommand(CMD_ROLLBACK, () => {
            const terminal = vscode.window.createTerminal('AG-Wormhole Rollback');
            terminal.show();
            terminal.sendText(Provisioner.generateRollbackScript());
            setTimeout(() => refreshAllStatus(), 2000);
        }),

        vscode.commands.registerCommand(CMD_CHECK_PROXY, async () => {
            const ok = await TunnelManager.checkPortAvailable(remoteHost, remotePort);
            await refreshAllStatus();
            vscode.window.showInformationMessage(
                ok ? `[AG-Wormhole] Ingress endpoint ${remoteHost}:${remotePort} is reachable.` : `[AG-Wormhole] Ingress endpoint ${remoteHost}:${remotePort} is UNREACHABLE.`
            );
        })
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (e.affectsConfiguration(CONFIG_SECTION)) {
                const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
                const h = cfg.get<string>(CFG_REMOTE_PROXY_HOST, DEFAULT_PROXY_HOST);
                const p = cfg.get<number>(CFG_REMOTE_PROXY_PORT, DEFAULT_PROXY_PORT);
                const t = cfg.get<string>(CFG_PROXY_TYPE, DEFAULT_PROXY_TYPE);
                await Provisioner.runSetupSilently(h, p, t, extensionPath);
                await refreshAllStatus();
            }
        })
    );

    // Auto-setup silently
    await Provisioner.runSetupSilently(remoteHost, remotePort, proxyType, extensionPath);
    trafficCollector.start();

    // Check startup status
    const showStartupNotification = config.get<boolean>(CFG_SHOW_STATUS_ON_STARTUP, true);
    if (showStartupNotification) {
        setTimeout(async () => {
            const reachable = await TunnelManager.checkPortAvailable(remoteHost, remotePort);
            if (reachable) {
                vscode.window.showInformationMessage(`[AG-Wormhole] Data plane active at ${remoteHost}:${remotePort} (${proxyType.toUpperCase()})`);
            } else {
                const action = await vscode.window.showWarningMessage(
                    `[AG-Wormhole] Ingress endpoint ${remoteHost}:${remotePort} is unreachable. Ensure your local window is open and the reverse tunnel is established.`,
                    'Open Dashboard',
                    'Dismiss'
                );
                if (action === 'Open Dashboard') {
                    vscode.commands.executeCommand(CMD_SHOW_STATUS_PANEL);
                }
            }
        }, 2000);
    }
}

export async function deactivate(): Promise<void> {
    if (autoRefreshTimer) {
        clearInterval(autoRefreshTimer);
    }
    TunnelWatchdog.getInstance().stop();
    trafficCollector?.stop();
    logger.log('AG-Wormhole deactivated.', isRunningLocally());
}

