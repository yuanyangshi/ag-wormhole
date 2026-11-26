import * as assert from 'assert';
import * as net from 'net';
import { TunnelWatchdog } from '../core/watchdog';
import { IngressRelay } from '../core/ingressRelay';
import { setMockRemoteEnvironment } from '../shared/environment';

suite('TunnelWatchdog Unit Tests', () => {
    test('getInstance returns singleton instance', () => {
        const instance1 = TunnelWatchdog.getInstance();
        const instance2 = TunnelWatchdog.getInstance();
        assert.strictEqual(instance1, instance2);
    });

    test('watchdog emits state change events and maintains metrics', async function (this: Mocha.Context) {
        this.timeout(10000);
        const watchdog = TunnelWatchdog.getInstance();
        let receivedUpdate = false;

        const disposable = watchdog.onStateChange((metrics) => {
            receivedUpdate = true;
            assert.ok(metrics.lastChecked instanceof Date);
        });

        const metrics = await watchdog.probe();
        assert.ok(metrics !== undefined);
        assert.strictEqual(receivedUpdate, true);

        disposable.dispose();
    });

    test('watchdog correctly toggles session muting', () => {
        const watchdog = TunnelWatchdog.getInstance();
        assert.strictEqual(watchdog.isMuted(), false);
        watchdog.muteSession();
        assert.strictEqual(watchdog.isMuted(), true);
        watchdog.unmuteSession();
        assert.strictEqual(watchdog.isMuted(), false);
    });

    test('watchdog classifies clean-EOF upstream as proxy-unstable and preserves IngressRelay across transient instability', async function (this: Mocha.Context) {
        this.timeout(10000);
        const watchdog = TunnelWatchdog.getInstance();
        const relay = IngressRelay.getInstance();
        const eofSockets: net.Socket[] = [];
        const eofServer = net.createServer((sock) => {
            eofSockets.push(sock);
            sock.resume();
            setTimeout(() => {
                if (!sock.destroyed) {
                    sock.end();
                }
            }, 15);
        });

        await new Promise<void>((res) => eofServer.listen(0, '127.0.0.1', () => res()));
        const eofPort = (eofServer.address() as net.AddressInfo).port;

        const tmpListen = net.createServer();
        await new Promise<void>((res) => tmpListen.listen(0, '127.0.0.1', () => res()));
        const listenPort = (tmpListen.address() as net.AddressInfo).port;
        await new Promise<void>((res) => tmpListen.close(() => res()));

        try {
            const started = await relay.startRelay(listenPort, eofPort, [eofPort]);
            assert.strictEqual(started, true);

            setMockRemoteEnvironment(true);
            watchdog.resetState();

            const m1 = await watchdog.probe();
            assert.strictEqual(m1.state, 'DEGRADED');
            assert.strictEqual(m1.failureKind, 'proxy-unstable');
            assert.strictEqual(relay.isRelaying(), true);

            const m2 = await watchdog.probe();
            assert.strictEqual(m2.state, 'DEGRADED');
            assert.strictEqual(m2.failureKind, 'proxy-unstable');
            assert.strictEqual(m2.consecutiveFailures, 2);
            assert.strictEqual(relay.isRelaying(), true);
        } finally {
            watchdog.resetState();
            setMockRemoteEnvironment(undefined);
            await relay.stopRelay();
            for (const s of eofSockets) {
                s.destroy();
            }
            await new Promise<void>((res) => eofServer.close(() => res()));
        }
    });

    test('watchdog probes unrelayed activeTunnelPort on healthy ticks without thrashing occupied primary port', async function (this: Mocha.Context) {
        this.timeout(10000);
        const watchdog = TunnelWatchdog.getInstance();
        const relay = IngressRelay.getInstance();
        let probeHits = 0;
        const proxySockets: net.Socket[] = [];
        const fallbackProxyServer = net.createServer((sock) => {
            proxySockets.push(sock);
            sock.on('data', () => {
                probeHits++;
                sock.write('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
            });
        });

        await new Promise<void>((res) => fallbackProxyServer.listen(0, '127.0.0.1', () => res()));
        const fallbackPort = (fallbackProxyServer.address() as net.AddressInfo).port;

        const tmpListen = net.createServer();
        await new Promise<void>((res) => tmpListen.listen(0, '127.0.0.1', () => res()));
        const listenPort = (tmpListen.address() as net.AddressInfo).port;
        await new Promise<void>((res) => tmpListen.close(() => res()));

        try {
            assert.strictEqual(await relay.startRelay(listenPort, fallbackPort, [fallbackPort]), true);
            setMockRemoteEnvironment(true);
            watchdog.resetState();

            const m1 = await watchdog.probe();
            assert.strictEqual(m1.state, 'HEALTHY');
            assert.strictEqual(m1.activeTunnelPort, fallbackPort);

            // Stop relay to simulate unrelayed direct usage on the verified fallbackPort
            await relay.stopRelay();
            const hitsBeforeDirectProbe = probeHits;

            const m2 = await watchdog.probe();
            assert.strictEqual(m2.state, 'HEALTHY');
            assert.strictEqual(m2.isRelaying, false);
            assert.strictEqual(m2.activeTunnelPort, fallbackPort);
            assert.ok(probeHits > hitsBeforeDirectProbe);
        } finally {
            watchdog.resetState();
            setMockRemoteEnvironment(undefined);
            await relay.stopRelay();
            for (const s of proxySockets) {
                s.destroy();
            }
            await new Promise<void>((res) => fallbackProxyServer.close(() => res()));
        }
    });
});

