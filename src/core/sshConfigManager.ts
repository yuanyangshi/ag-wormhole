/**
 * AG-Wormhole - SSH Config Manager
 * Manages the atomic Include directive in ~/.ssh/config and ~/.ssh/config.wormhole
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import {
    WORMHOLE_SSH_CONFIG_FILENAME,
    WORMHOLE_SSH_INCLUDE_LINE
} from '../shared/constants';
import { logger } from '../shared/logger';

export class SSHConfigManager {
    private static customSSHDir?: string;

    public static setCustomSSHDir(dir?: string): void {
        SSHConfigManager.customSSHDir = dir;
    }

    public static getSSHDir(): string {
        return SSHConfigManager.customSSHDir || path.join(os.homedir(), '.ssh');
    }

    public static getMainConfigPath(): string {
        return path.join(SSHConfigManager.getSSHDir(), 'config');
    }

    public static getWormholeConfigPath(): string {
        return path.join(SSHConfigManager.getSSHDir(), WORMHOLE_SSH_CONFIG_FILENAME);
    }

    /**
     * Atomically update the SSH config files using the Include directive.
     */
    public static async updateConfigFile(remotePort: number, localPort: number, enable: boolean): Promise<void> {
        const mainConfigPath = SSHConfigManager.getMainConfigPath();
        const wormholeConfigPath = SSHConfigManager.getWormholeConfigPath();
        const sshDir = SSHConfigManager.getSSHDir();

        try {
            await fs.mkdir(sshDir, { recursive: true });

            if (enable) {
                // 1. Write the dedicated wormhole sub-config with high-availability keepalive parameters
                // Forward primary port and fallback ports (remotePort + 1, remotePort + 2) to eliminate
                // reconnection failure when primary port is temporarily held by dead zombie sockets.
                const forwardLines = [
                    `    RemoteForward ${remotePort} 127.0.0.1:${localPort}`,
                    `    RemoteForward ${remotePort + 1} 127.0.0.1:${localPort}`,
                    `    RemoteForward ${remotePort + 2} 127.0.0.1:${localPort}`,
                ];

                const content = [
                    '# AG-Wormhole High-Availability SSH Tunnel Configuration',
                    `# Generated at: ${new Date().toISOString()}`,
                    'Match all',
                    ...forwardLines,
                    '    ServerAliveInterval 15',
                    '    ServerAliveCountMax 3',
                    '    TCPKeepAlive yes',
                    '    IPQoS lowdelay throughput',
                    '    ConnectTimeout 15',
                    '    ConnectionAttempts 3',
                    '    StreamLocalBindUnlink yes',
                    '    ExitOnForwardFailure no',
                    '    VisualHostKey no',
                    '    Compression no',
                    '    Ciphers chacha20-poly1305@openssh.com,aes128-gcm@openssh.com',
                    '',
                ].join('\n');

                const tempConfigPath = `${wormholeConfigPath}.tmp`;
                await fs.writeFile(tempConfigPath, content, 'utf-8');
                await fs.rename(tempConfigPath, wormholeConfigPath);
                logger.log(`Updated sub-config: ${wormholeConfigPath}`, true);

                // 2. Ensure Include line is present in the main ssh config
                let mainContent = '';
                try {
                    mainContent = await fs.readFile(mainConfigPath, 'utf-8');
                } catch {
                    // File may not exist yet, which is fine
                }

                if (!mainContent.includes(WORMHOLE_SSH_INCLUDE_LINE)) {
                    mainContent = `${WORMHOLE_SSH_INCLUDE_LINE}\n${mainContent}`;
                    const tempMainPath = `${mainConfigPath}.tmp`;
                    await fs.writeFile(tempMainPath, mainContent, 'utf-8');
                    await fs.rename(tempMainPath, mainConfigPath);
                    logger.log(`Appended Include directive to ${mainConfigPath}`, true);
                }
            } else {
                // 1. Remove Include line from main config
                try {
                    let mainContent = await fs.readFile(mainConfigPath, 'utf-8');
                    if (mainContent.includes(WORMHOLE_SSH_INCLUDE_LINE)) {
                        mainContent = mainContent.replace(`${WORMHOLE_SSH_INCLUDE_LINE}\n`, '');
                        mainContent = mainContent.replace(WORMHOLE_SSH_INCLUDE_LINE, '');
                        const tempMainPath = `${mainConfigPath}.tmp`;
                        await fs.writeFile(tempMainPath, mainContent, 'utf-8');
                        await fs.rename(tempMainPath, mainConfigPath);
                        logger.log(`Removed Include directive from ${mainConfigPath}`, true);
                    }
                } catch {
                    // Ignore missing main config
                }

                // 2. Delete the wormhole config file
                try {
                    await fs.unlink(wormholeConfigPath);
                    logger.log(`Removed sub-config ${wormholeConfigPath}`, true);
                } catch {
                    // Ignore if already deleted
                }
            }
        } catch (error) {
            logger.log(`Error updating SSH config: ${error}`, true);
            throw error;
        }
    }

    /**
     * Check current SSH configuration state
     */
    public static async getStatus(): Promise<{ enabled: boolean; port?: number }> {
        try {
            const mainContent = await fs.readFile(SSHConfigManager.getMainConfigPath(), 'utf-8');
            if (mainContent.includes(WORMHOLE_SSH_INCLUDE_LINE)) {
                const subContent = await fs.readFile(SSHConfigManager.getWormholeConfigPath(), 'utf-8');
                const match = subContent.match(/RemoteForward\s+(\d+)\s+(?:localhost|127\.0\.0\.1):/);
                if (match) {
                    return { enabled: true, port: parseInt(match[1], 10) };
                }
            }
        } catch {
            // Missing configuration files
        }
        return { enabled: false };
    }

    /**
     * Provide recommended SSH multiplexing configuration guidelines
     */
    public static getMultiplexingRecommendations(): string {
        return [
            '# Optional: Advanced SSH Multiplexing (Keeps master socket alive across window reloads)',
            'Host *',
            '    ControlMaster auto',
            '    ControlPath ~/.ssh/sockets/%r@%h-%p',
            '    ControlPersist 10m'
        ].join('\n');
    }
}

