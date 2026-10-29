/**
 * AG-Wormhole - Type Definitions & Interfaces
 */

export interface ProxyStatus {
    runningLocation: 'local' | 'remote';
    sshConfigEnabled: boolean;
    localProxyPort: number;
    remoteProxyPort: number;
    remoteProxyHost: string;
    localProxyReachable: boolean;
    remoteProxyReachable: boolean;
    lastUpdated: Date;
    languageServerConfigured?: boolean;
}

export type StatusUpdateCallback = (status: ProxyStatus) => void;
export type ConfigChangeCallback = () => Promise<void>;

export interface ProtocolTestResult {
    protocol: 'http' | 'socks5';
    success: boolean;
    httpCode?: string;
    error?: string;
    isCurrent: boolean;
}

export interface DiagnosticCheck {
    id: string;
    name: string;
    status: 'pending' | 'running' | 'success' | 'warning' | 'error';
    message?: string;
    suggestion?: string;
    protocolResults?: ProtocolTestResult[];
    currentProtocol?: string;
}

export interface DiagnosticReport {
    timestamp: Date;
    checks: DiagnosticCheck[];
    overallStatus: 'healthy' | 'degraded' | 'broken';
}

export interface TrafficStats {
    activeConnections: number;
    totalConnectionsSeen: number;
    sessionStartTime: Date;
    lastUpdated: Date;
    proxyReachable: boolean;
}

export interface LanguageServerProcessInfo {
    pid: number;
    isPersistent: boolean;
    isUsingProxy: boolean;
}

