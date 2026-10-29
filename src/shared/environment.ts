/**
 * AG-Wormhole - Runtime Environment Detection
 */

import * as os from 'os';

let mockIsRemote: boolean | undefined;

export function setMockRemoteEnvironment(isRemote: boolean | undefined): void {
    mockIsRemote = isRemote;
}

export function isRunningLocally(): boolean {
    if (mockIsRemote !== undefined) {
        return !mockIsRemote;
    }
    try {
        const vscode = require('vscode');
        return !vscode.env.remoteName;
    } catch {
        return true;
    }
}

export function isRunningRemotely(): boolean {
    if (mockIsRemote !== undefined) {
        return mockIsRemote;
    }
    try {
        const vscode = require('vscode');
        return !!vscode.env.remoteName;
    } catch {
        return false;
    }
}

export function isLinuxPlatform(): boolean {
    return process.platform === 'linux';
}

export function getSystemArchitecture(): string {
    const arch = os.arch();
    switch (arch) {
        case 'x64':
        case 'amd64':
            return 'amd64';
        case 'arm64':
        case 'aarch64':
            return 'arm64';
        default:
            return arch;
    }
}
