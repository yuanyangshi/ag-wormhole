import * as assert from 'assert';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { SSHConfigManager } from '../core/sshConfigManager';
import { WORMHOLE_SSH_CONFIG_FILENAME, WORMHOLE_SSH_INCLUDE_LINE } from '../shared/constants';

suite('SSHConfigManager Unit Tests', () => {
    let tempDir: string;

    suiteSetup(async () => {
        tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-wormhole-test-'));
        SSHConfigManager.setCustomSSHDir(tempDir);
    });

    suiteTeardown(async () => {
        SSHConfigManager.setCustomSSHDir(undefined);
        try {
            await fs.rm(tempDir, { recursive: true, force: true });
        } catch {
            // Ignore cleanup failure
        }
    });

    test('should correctly enable wormhole forwarding in SSH config', async () => {
        const remotePort = 17890;
        const localPort = 7890;

        await SSHConfigManager.updateConfigFile(remotePort, localPort, true);

        const wormholePath = path.join(tempDir, WORMHOLE_SSH_CONFIG_FILENAME);
        const mainPath = path.join(tempDir, 'config');

        const wormholeExists = await fs.stat(wormholePath).then(() => true).catch(() => false);
        const mainExists = await fs.stat(mainPath).then(() => true).catch(() => false);

        assert.strictEqual(wormholeExists, true, 'Sub-config file should exist');
        assert.strictEqual(mainExists, true, 'Main config file should exist');

        const wormholeContent = await fs.readFile(wormholePath, 'utf-8');
        const mainContent = await fs.readFile(mainPath, 'utf-8');

        assert.ok(wormholeContent.includes(`RemoteForward ${remotePort} 127.0.0.1:${localPort}`));
        assert.ok(wormholeContent.includes('ServerAliveInterval 15'), 'Must enforce ServerAliveInterval');
        assert.ok(wormholeContent.includes('TCPKeepAlive yes'), 'Must enforce TCPKeepAlive');
        assert.ok(wormholeContent.includes('ConnectTimeout 15'), 'Must enforce ConnectTimeout');
        assert.ok(wormholeContent.includes('ConnectionAttempts 3'), 'Must enforce ConnectionAttempts');
        assert.ok(wormholeContent.includes('StreamLocalBindUnlink yes'), 'Must enforce StreamLocalBindUnlink');
        assert.ok(wormholeContent.includes('Compression no'), 'Must disable compression for TLS streams');
        assert.ok(wormholeContent.includes('Ciphers chacha20-poly1305@openssh.com,aes128-gcm@openssh.com'), 'Must configure optimized ciphers');
        assert.ok(mainContent.includes(WORMHOLE_SSH_INCLUDE_LINE));
    });

    test('should provide multiplexing recommendations snippet', () => {
        const snippet = SSHConfigManager.getMultiplexingRecommendations();
        assert.ok(snippet.includes('ControlMaster auto'));
        assert.ok(snippet.includes('ControlPersist 10m'));
    });

    test('should be idempotent and not duplicate Include directive', async () => {
        await SSHConfigManager.updateConfigFile(17890, 7890, true);

        const mainPath = path.join(tempDir, 'config');
        const mainContent = await fs.readFile(mainPath, 'utf-8');

        const occurrences = (mainContent.match(new RegExp(WORMHOLE_SSH_INCLUDE_LINE, 'g')) || []).length;
        assert.strictEqual(occurrences, 1, 'Include directive should only appear once');
    });

    test('should cleanly disable wormhole forwarding and remove sub-config', async () => {
        await SSHConfigManager.updateConfigFile(17890, 7890, false);

        const wormholePath = path.join(tempDir, WORMHOLE_SSH_CONFIG_FILENAME);
        const mainPath = path.join(tempDir, 'config');

        const wormholeExists = await fs.stat(wormholePath).then(() => true).catch(() => false);
        assert.strictEqual(wormholeExists, false, 'Sub-config file should be removed');

        const mainContent = await fs.readFile(mainPath, 'utf-8');
        assert.ok(!mainContent.includes(WORMHOLE_SSH_INCLUDE_LINE), 'Include directive should be removed from main config');
    });
});
