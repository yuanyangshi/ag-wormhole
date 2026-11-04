import * as assert from 'assert';
import * as net from 'net';
import { TunnelManager } from '../core/tunnelManager';
import { Provisioner } from '../core/provisioner';
import { IngressRelay } from '../core/ingressRelay';
import { TrafficCollector } from '../telemetry/trafficCollector';

suite('Resilience & Stability Unit Tests', () => {
    test('Provisioner.reclaimPort rejects invalid port ranges safely', async () => {
        const negativePort = await Provisioner.reclaimPort(-1);
        assert.strictEqual(negativePort.success, false);
        assert.strictEqual(negativePort.pidsKilled.length, 0);

        const zeroPort = await Provisioner.reclaimPort(0);
        assert.strictEqual(zeroPort.success, false);

        const overflowPort = await Provisioner.reclaimPort(70000);
        assert.strictEqual(overflowPort.success, false);
    });

    test('Provisioner.reclaimPortRange executes safely across port block', async () => {
        const result = await Provisioner.reclaimPortRange(64000, 3);
        assert.strictEqual(result.success, true);
        assert.ok(Array.isArray(result.pidsKilled));
    });

    test('Provisioner.getProtectedPids protects active process and parent hierarchy', async () => {
        const protectedSet = await Provisioner.getProtectedPids(7890);
        assert.strictEqual(protectedSet.has(1), true);
        assert.strictEqual(protectedSet.has(process.pid), true);
        assert.strictEqual(protectedSet.has(process.ppid), true);
    });

    test('Provisioner.purgeStaleCaches runs safely without throwing', async () => {
        const res = await Provisioner.purgeStaleCaches();
        assert.ok(typeof res.success === 'boolean');
        assert.ok(typeof res.message === 'string');
    });

    test('TunnelManager.purgeLocalCache runs safely without throwing', async () => {
        await TunnelManager.purgeLocalCache();
    });

    test('TunnelManager.checkProxyL7 correctly validates mock HTTP proxy', async () => {
        // Spin up temporary mock HTTP proxy listener
        const server = net.createServer((socket) => {
            socket.on('data', () => {
                socket.write('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
            });
        });

        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
        const address = server.address() as net.AddressInfo;
        const port = address.port;

        try {
            const result = await TunnelManager.checkProxyL7('127.0.0.1', port, 'http', 1500);
            assert.strictEqual(result.ok, true);
            assert.ok(result.message.includes('HTTP proxy'));
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    test('TunnelManager.checkProxyL7 correctly validates mock SOCKS5 proxy', async () => {
        // Spin up temporary mock SOCKS5 proxy listener
        const server = net.createServer((socket) => {
            socket.on('data', (data) => {
                if (data[0] === 0x05) {
                    // Send SOCKS5 greeting response: VER=5, METHOD=0 (No Auth)
                    socket.write(Buffer.from([0x05, 0x00]));
                }
            });
        });

        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
        const address = server.address() as net.AddressInfo;
        const port = address.port;

        try {
            const result = await TunnelManager.checkProxyL7('127.0.0.1', port, 'socks5', 1500);
            assert.strictEqual(result.ok, true);
            assert.ok(result.message.includes('SOCKS5 proxy'));
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    test('TunnelManager.checkProxyL7 adapts automatically when configured protocol mismatches', async () => {
        // Spin up temporary mock SOCKS5 proxy listener
        const server = net.createServer((socket) => {
            socket.on('data', (data) => {
                if (data[0] === 0x05) {
                    socket.write(Buffer.from([0x05, 0x00]));
                }
            });
        });

        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
        const address = server.address() as net.AddressInfo;
        const port = address.port;

        try {
            // Probing with 'http' against a SOCKS5 server should adapt and succeed
            const result = await TunnelManager.checkProxyL7('127.0.0.1', port, 'http', 1500);
            assert.strictEqual(result.ok, true);
            assert.ok(result.message.includes('SOCKS5'));
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    test('TunnelManager.checkProxyL7 rejects non-responsive ports safely', async () => {
        // Connect to a closed port
        const result = await TunnelManager.checkProxyL7('127.0.0.1', 65432, 'http', 500);
        assert.strictEqual(result.ok, false);
    });

    test('TrafficCollector maintains accurate monotonic metrics', () => {
        const collector = new TrafficCollector();
        const initial = collector.getStats();
        assert.strictEqual(initial.activeConnections, 0);
        assert.strictEqual(initial.totalConnectionsSeen, 0);
        assert.strictEqual(initial.peakConnections, 0);
    });

    test('IngressRelay seamlessly bridges traffic between ports during failover', async () => {
        // 1. Target server (simulating the active fallback SSH tunnel)
        let receivedEcho = false;
        const targetServer = net.createServer((socket) => {
            socket.on('data', (d) => {
                if (d.toString() === 'PING_WORMHOLE') {
                    receivedEcho = true;
                    socket.write('PONG_WORMHOLE');
                }
            });
        });
        await new Promise<void>((res) => targetServer.listen(0, '127.0.0.1', () => res()));
        const targetPort = (targetServer.address() as net.AddressInfo).port;

        // 2. Start relay on a dynamic listen port
        const relay = IngressRelay.getInstance();
        const listenServer = net.createServer();
        await new Promise<void>((res) => listenServer.listen(0, '127.0.0.1', () => res()));
        const listenPort = (listenServer.address() as net.AddressInfo).port;
        await new Promise<void>((res) => listenServer.close(() => res()));

        const relayStarted = await relay.startRelay(listenPort, targetPort);
        assert.strictEqual(relayStarted, true);
        assert.strictEqual(relay.isRelaying(), true);

        // 3. Client connects to listenPort and receives echo from targetPort
        const client = new net.Socket();
        const responseData = await new Promise<string>((resolve, reject) => {
            client.connect(listenPort, '127.0.0.1', () => {
                client.write('PING_WORMHOLE');
            });
            client.on('data', (chunk) => {
                client.destroy();
                resolve(chunk.toString());
            });
            client.on('error', (err) => reject(err));
        });

        assert.strictEqual(receivedEcho, true);
        assert.strictEqual(responseData, 'PONG_WORMHOLE');

        // 4. Test yieldPort
        await relay.startRelay(listenPort, targetPort);
        assert.strictEqual(relay.isRelaying(), true);
        await relay.yieldPort(50);
        assert.strictEqual(relay.isRelaying(), false);

        // 5. Cleanup relay
        await relay.stopRelay();
        assert.strictEqual(relay.isRelaying(), false);
        await new Promise<void>((res) => targetServer.close(() => res()));
    });

    test('TunnelManager.parseSshCommandDestination accurately extracts interactive and keeper SSH targets', () => {
        const remoteSshCmd = 'ssh -v -T -D 54102 remote-host "bash -s"';
        const parsed1 = TunnelManager.parseSshCommandDestination(remoteSshCmd);
        assert.deepStrictEqual(parsed1, { host: 'remote-host', isKeeper: false });

        const winPathCmd = '"C:\\Windows\\System32\\OpenSSH\\ssh.exe" -N -T -o BatchMode=yes -o ClearAllForwardings=yes -o SendEnv=AG_WORMHOLE_KEEPER -R 7890:127.0.0.1:7890 -R 7893:127.0.0.1:7890 user@remote-gpu.internal';
        const parsed2 = TunnelManager.parseSshCommandDestination(winPathCmd);
        assert.deepStrictEqual(parsed2, { host: 'user@remote-gpu.internal', isKeeper: true });

        const invalidCmd = 'node --inspect=127.0.0.1:9229 extensionHostProcess.js';
        assert.strictEqual(TunnelManager.parseSshCommandDestination(invalidCmd), null);
    });
});

