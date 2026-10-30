/**
 * AG-Wormhole - Global Constants & Configuration Keys
 */

export const EXTENSION_ID = 'ag-wormhole';
export const EXTENSION_NAME = 'AG-Wormhole';

// Commands
export const CMD_SETUP = 'ag-wormhole.setup';
export const CMD_ROLLBACK = 'ag-wormhole.rollback';
export const CMD_ENABLE_FORWARDING = 'ag-wormhole.enableForwarding';
export const CMD_DISABLE_FORWARDING = 'ag-wormhole.disableForwarding';
export const CMD_TUNNEL_STATUS = 'ag-wormhole.tunnelStatus';
export const CMD_CHECK_PROXY = 'ag-wormhole.checkProxy';
export const CMD_SHOW_OUTPUT = 'ag-wormhole.showOutput';
export const CMD_SHOW_STATUS_PANEL = 'ag-wormhole.showStatusPanel';
export const CMD_REFRESH_STATUS = 'ag-wormhole.refreshStatus';
export const CMD_DIAGNOSE = 'ag-wormhole.diagnose';
export const CMD_SHOW_TRAFFIC = 'ag-wormhole.showTrafficPanel';
export const CMD_RECLAIM_PORT = 'ag-wormhole.reclaimPort';
export const CMD_OPTIMIZE_SSH = 'ag-wormhole.optimizeSSH';

// Configuration Section & Keys
export const CONFIG_SECTION = 'ag-wormhole';
export const CFG_ENABLE_LOCAL_FORWARDING = 'enableLocalForwarding';
export const CFG_LOCAL_PROXY_PORT = 'localProxyPort';
export const CFG_REMOTE_PROXY_HOST = 'remoteProxyHost';
export const CFG_REMOTE_PROXY_PORT = 'remoteProxyPort';
export const CFG_SHOW_STATUS_ON_STARTUP = 'showStatusOnStartup';
export const CFG_PROXY_TYPE = 'proxyType';
export const CFG_WATCHDOG_INTERVAL = 'watchdogInterval';
export const CFG_AUTO_RECLAIM_PORT = 'autoReclaimPort';
export const CFG_AUTO_INJECT_TERMINAL_PROXY = 'autoInjectTerminalProxy';

// SSH Include Configuration
export const WORMHOLE_SSH_CONFIG_FILENAME = 'config.wormhole';
export const WORMHOLE_SSH_INCLUDE_LINE = `Include ${WORMHOLE_SSH_CONFIG_FILENAME}`;

// Remote Server Discovery Directories
export const SERVER_DIR_NAMES = [
    '.ag-wormhole',
    '.antigravity-ide-server',
    '.antigravity-server'
];

// Defaults
export const DEFAULT_PROXY_HOST = '127.0.0.1';
export const DEFAULT_PROXY_PORT = 7890;
export const DEFAULT_PROXY_TYPE = 'http';
export const DEFAULT_WATCHDOG_INTERVAL_SEC = 10;
export const AUTO_REFRESH_INTERVAL_SEC = 30;

