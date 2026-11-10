import * as assert from 'assert';
import * as net from 'net';
import { TunnelManager } from '../core/tunnelManager';
import { Provisioner } from '../core/provisioner';
import { IngressRelay } from '../core/ingressRelay';
import { TrafficCollector } from '../telemetry/trafficCollector';

suite('Resilience & Stability Unit Tests', function (this: Mocha.Suite) {
    this.timeout(10000);
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

    test('IngressRelay buffers connection and successfully recovers when upstream target is delayed', async () => {
        const relay = IngressRelay.getInstance();
        const dummyServer = net.createServer();
        await new Promise<void>((res) => dummyServer.listen(0, '127.0.0.1', () => res()));
        const listenPort = (dummyServer.address() as net.AddressInfo).port;
        await new Promise<void>((res) => dummyServer.close(() => res()));

        const targetDummy = net.createServer();
        await new Promise<void>((res) => targetDummy.listen(0, '127.0.0.1', () => res()));
        const targetPort = (targetDummy.address() as net.AddressInfo).port;
        await new Promise<void>((res) => targetDummy.close(() => res()));

        // Start relay before target is actually listening
        await relay.startRelay(listenPort, targetPort);

        // Bring target up after 180ms delay
        setTimeout(() => {
            const upstream = net.createServer((sock) => {
                sock.on('data', (d) => sock.write(`ECHO_${d.toString()}`));
            });
            upstream.listen(targetPort, '127.0.0.1');
            setTimeout(() => {
                upstream.close();
            }, 1000);
        }, 180);

        // Client connects immediately; retry buffer holds connection until upstream is ready
        const client = new net.Socket();
        const responseData = await new Promise<string>((resolve, reject) => {
            client.connect(listenPort, '127.0.0.1', () => {
                client.write('BUFFER_TEST');
            });
            client.on('data', (chunk) => {
                client.destroy();
                resolve(chunk.toString());
            });
            client.on('error', (err) => reject(err));
        });

        assert.strictEqual(responseData, 'ECHO_BUFFER_TEST');
        await relay.stopRelay();
    });

    test('IngressRelay dynamically hunts across candidate fallback ports when primary target is down', async () => {
        const relay = IngressRelay.getInstance();

        // Allocate 3 dynamic ephemeral ports: listenPort, deadCandidatePort, liveCandidatePort
        const getFreePort = async (): Promise<number> => {
            const s = net.createServer();
            await new Promise<void>((res) => s.listen(0, '127.0.0.1', () => res()));
            const p = (s.address() as net.AddressInfo).port;
            await new Promise<void>((res) => s.close(() => res()));
            return p;
        };

        const listenPort = await getFreePort();
        const deadPort = await getFreePort();

        // Start a live upstream server on livePort
        const liveServer = net.createServer((sock) => {
            sock.on('data', (d) => sock.write(`HUNT_OK_${d.toString()}`));
        });
        await new Promise<void>((res) => liveServer.listen(0, '127.0.0.1', () => res()));
        const livePort = (liveServer.address() as net.AddressInfo).port;

        try {
            // Start relay pointing to deadPort as primary target, but with [deadPort, livePort] in candidates
            const started = await relay.startRelay(listenPort, deadPort, [deadPort, livePort]);
            assert.strictEqual(started, true);

            const client = new net.Socket();
            const responseData = await new Promise<string>((resolve, reject) => {
                client.connect(listenPort, '127.0.0.1', () => {
                    client.write('PAYLOAD');
                });
                client.on('data', (chunk) => {
                    client.destroy();
                    resolve(chunk.toString());
                });
                client.on('error', (err) => reject(err));
            });

            assert.strictEqual(responseData, 'HUNT_OK_PAYLOAD');
            // Verify IngressRelay automatically locked onto the live candidate port
            assert.strictEqual(relay.getRelayInfo().targetPort, livePort);
        } finally {
            await relay.stopRelay();
            await new Promise<void>((res) => liveServer.close(() => res()));
        }
    });

    test('IngressRelay bypasses zombie candidate that immediately closes after TCP connect and fails over to live candidate', async () => {
        const relay = IngressRelay.getInstance();

        const getFreePort = async (): Promise<number> => {
            const s = net.createServer();
            await new Promise<void>((res) => s.listen(0, '127.0.0.1', () => res()));
            const p = (s.address() as net.AddressInfo).port;
            await new Promise<void>((res) => s.close(() => res()));
            return p;
        };

        const listenPort = await getFreePort();

        // Zombie server: accepts TCP connection and immediately closes (simulating dead sshd RemoteForward)
        const zombieServer = net.createServer((sock) => {
            sock.destroy();
        });
        await new Promise<void>((res) => zombieServer.listen(0, '127.0.0.1', () => res()));
        const zombiePort = (zombieServer.address() as net.AddressInfo).port;

        // Live server: responds properly
        const liveServer = net.createServer((sock) => {
            sock.on('data', (d) => sock.write(`ZOMBIE_BYPASSED_${d.toString()}`));
        });
        await new Promise<void>((res) => liveServer.listen(0, '127.0.0.1', () => res()));
        const livePort = (liveServer.address() as net.AddressInfo).port;

        try {
            const started = await relay.startRelay(listenPort, zombiePort, [zombiePort, livePort]);
            assert.strictEqual(started, true);

            const client = new net.Socket();
            const responseData = await new Promise<string>((resolve, reject) => {
                client.connect(listenPort, '127.0.0.1', () => {
                    client.write('OAUTH_TOKEN_REQ');
                });
                client.on('data', (chunk) => {
                    client.destroy();
                    resolve(chunk.toString());
                });
                client.on('error', (err) => reject(err));
            });

            assert.strictEqual(responseData, 'ZOMBIE_BYPASSED_OAUTH_TOKEN_REQ');
            assert.strictEqual(relay.getRelayInfo().targetPort, livePort);
        } finally {
            await relay.stopRelay();
            await new Promise<void>((res) => zombieServer.close(() => res()));
            await new Promise<void>((res) => liveServer.close(() => res()));
        }
    });

    test('IngressRelay replays buffered initial payload when half-open blackhole zombie swallows request without responding', async () => {
        const relay = IngressRelay.getInstance();

        const getFreePort = async (): Promise<number> => {
            const s = net.createServer();
            await new Promise<void>((res) => s.listen(0, '127.0.0.1', () => res()));
            const p = (s.address() as net.AddressInfo).port;
            await new Promise<void>((res) => s.close(() => res()));
            return p;
        };

        const listenPort = await getFreePort();

        // Delayed-close zombie: accepts TCP, reads the request, waits 60ms (WAN RTT), and closes without replying
        const delayedZombieSockets: net.Socket[] = [];
        const delayedZombieServer = net.createServer((sock) => {
            delayedZombieSockets.push(sock);
            sock.on('data', () => {
                setTimeout(() => sock.destroy(), 60);
            });
        });
        await new Promise<void>((res) => delayedZombieServer.listen(0, '127.0.0.1', () => res()));
        const delayedZombiePort = (delayedZombieServer.address() as net.AddressInfo).port;

        // Silent blackhole zombie: accepts TCP, reads the request, and hangs silently forever
        const blackholeSockets: net.Socket[] = [];
        const blackholeServer = net.createServer((sock) => {
            blackholeSockets.push(sock);
            sock.on('data', () => {
                // Intentionally never respond and never close (half-open dead sshd blackhole)
            });
        });
        await new Promise<void>((res) => blackholeServer.listen(0, '127.0.0.1', () => res()));
        const blackholePort = (blackholeServer.address() as net.AddressInfo).port;

        // Live server: responds properly
        const liveServer = net.createServer((sock) => {
            sock.on('data', (d) => sock.write(`REPLAY_OK_${d.toString()}`));
        });
        await new Promise<void>((res) => liveServer.listen(0, '127.0.0.1', () => res()));
        const livePort = (liveServer.address() as net.AddressInfo).port;

        try {
            const started = await relay.startRelay(
                listenPort,
                delayedZombiePort,
                [delayedZombiePort, blackholePort, livePort]
            );
            assert.strictEqual(started, true);

            const client = new net.Socket();
            const responseData = await new Promise<string>((resolve, reject) => {
                client.connect(listenPort, '127.0.0.1', () => {
                    client.write('OAUTH_REPLAY_PAYLOAD');
                });
                client.on('data', (chunk) => {
                    client.destroy();
                    resolve(chunk.toString());
                });
                client.on('error', (err) => reject(err));
            });

            assert.strictEqual(responseData, 'REPLAY_OK_OAUTH_REPLAY_PAYLOAD');
            assert.strictEqual(relay.getRelayInfo().targetPort, livePort);
        } finally {
            await relay.stopRelay();
            for (const s of [...delayedZombieSockets, ...blackholeSockets]) {
                s.destroy();
            }
            await new Promise<void>((res) => delayedZombieServer.close(() => res()));
            await new Promise<void>((res) => blackholeServer.close(() => res()));
            await new Promise<void>((res) => liveServer.close(() => res()));
        }
    });

    test('IngressRelay standby guard reserves fallback port and releases cleanly', async () => {
        const relay = IngressRelay.getInstance();
        const s = net.createServer();
        await new Promise<void>((res) => s.listen(0, '127.0.0.1', () => res()));
        const guardPort = (s.address() as net.AddressInfo).port;
        await new Promise<void>((res) => s.close(() => res()));

        const guarded = await relay.ensureStandbyGuard(guardPort);
        assert.strictEqual(guarded, true);

        const isBoundWhileGuarded = await TunnelManager.checkPortAvailable('127.0.0.1', guardPort, 300);
        assert.strictEqual(isBoundWhileGuarded, true);

        await relay.releaseStandbyGuard();
        const isBoundAfterRelease = await TunnelManager.checkPortAvailable('127.0.0.1', guardPort, 300);
        assert.strictEqual(isBoundAfterRelease, false);
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

        const gitCmd1 = 'ssh.exe git@github.com "git-upload-pack \'example/repo.git\'"';
        assert.strictEqual(TunnelManager.parseSshCommandDestination(gitCmd1), null);

        const gitCmd2 = 'ssh user@internal-git.local git-receive-pack /srv/git/repo.git';
        assert.strictEqual(TunnelManager.parseSshCommandDestination(gitCmd2), null);
    });

    test('TunnelManager.sanitizeKeeperSshConfig strips wormhole include and conflicting RemoteForward directives', () => {
        const rawConfig = [
            'Include config.wormhole',
            'Match host remote-host,remote-host-alt exec "cmd.exe /c ping -n 1 -w 200 192.0.2.10 >nul 2>&1"',
            '    HostName 192.0.2.10',
            '',
            'Host remote-host remote-host-alt',
            '    HostName 192.0.2.20',
            '    User remote-host',
            '    ExitOnForwardFailure no',
            '    RemoteForward 7890 127.0.0.1:7890'
        ].join('\n');

        const sanitized = TunnelManager.sanitizeKeeperSshConfig(rawConfig);
        assert.strictEqual(sanitized.includes('config.wormhole'), false);
        assert.strictEqual(sanitized.includes('RemoteForward'), false);
        assert.strictEqual(sanitized.includes('ExitOnForwardFailure'), false);
        assert.strictEqual(sanitized.includes('HostName 192.0.2.10'), true);
        assert.strictEqual(sanitized.includes('HostName 192.0.2.20'), true);
        assert.strictEqual(sanitized.includes('User remote-host'), true);
    });

    test('Provisioner.findSupersedingSshdPid identifies newer persistent Remote-SSH sessions while ignoring transient bash -c commands', () => {
        // 1. Candidate (startTicks=1000) should NOT be superseded by a newer transient one-off CLI command (`bash -c ...`)
        const transientOnly = [
            { pid: 3001, startTicks: 2000, childArgs: 'bash -c ps -ef | grep sshd' }
        ];
        assert.strictEqual(Provisioner.findSupersedingSshdPid(1000, transientOnly), null);

        // 2. Candidate (startTicks=1000) SHOULD be superseded by a newer persistent Remote-SSH session (`bash -s`)
        const withPersistent = [
            { pid: 3001, startTicks: 1500, childArgs: 'bash -c ls -la' },
            { pid: 3002, startTicks: 1800, childArgs: 'bash -s' }
        ];
        assert.strictEqual(Provisioner.findSupersedingSshdPid(1000, withPersistent), 3002);

        // 3. Active newest session (startTicks=2500) should NOT be superseded by older persistent sessions
        assert.strictEqual(Provisioner.findSupersedingSshdPid(2500, withPersistent), null);
    });

    test('parseStuckSendQueueBytes sums Send-Q of ESTAB rows only', () => {
        const out = [
            'State  Recv-Q Send-Q Local Address:Port Peer Address:Port',
            'ESTAB  0      138644 192.0.2.10:22 198.51.100.5:50001',
            'ESTAB  0      0      192.0.2.10:22 198.51.100.5:50002',
            'ESTAB  0      100    192.0.2.10:22 198.51.100.5:50003',
            'LISTEN 0      4096   0.0.0.0:22 0.0.0.0:*'
        ].join('\n');
        assert.strictEqual(Provisioner.parseStuckSendQueueBytes(out), 138744);
        assert.strictEqual(Provisioner.parseStuckSendQueueBytes(''), 0);
    });

    test('Provisioner.isPortHealthyL7 and reclaimPort skip healthy L7 proxy listeners', async () => {
        const server = net.createServer((socket) => {
            socket.on('data', () => {
                socket.write('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
            });
        });

        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
        const port = (server.address() as net.AddressInfo).port;

        try {
            const healthy = await Provisioner.isPortHealthyL7(port, 800);
            assert.strictEqual(healthy, true);

            const reclaimRes = await Provisioner.reclaimPort(port, port);
            assert.strictEqual(reclaimRes.success, true);
            assert.strictEqual(reclaimRes.pidsKilled.length, 0);
            assert.ok(reclaimRes.message.includes('healthy at L7'));
        } finally {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    test('Provisioner.isPortHealthyL7 returns false for zombie TCP listeners that do not speak HTTP/SOCKS5', async () => {
        const zombieServer = net.createServer((socket) => {
            socket.destroy();
        });

        await new Promise<void>((resolve) => zombieServer.listen(0, '127.0.0.1', () => resolve()));
        const port = (zombieServer.address() as net.AddressInfo).port;

        try {
            const healthy = await Provisioner.isPortHealthyL7(port, 400);
            assert.strictEqual(healthy, false);
        } finally {
            await new Promise<void>((resolve) => zombieServer.close(() => resolve()));
        }
    });

    test('IngressRelay preserves slow HTTP CONNECT requests (>400ms dial) when upstream candidate passes L7 probe', async () => {
        const relay = IngressRelay.getInstance();

        const getFreePort = async (): Promise<number> => {
            const s = net.createServer();
            await new Promise<void>((res) => s.listen(0, '127.0.0.1', () => res()));
            const p = (s.address() as net.AddressInfo).port;
            await new Promise<void>((res) => s.close(() => res()));
            return p;
        };

        const listenPort = await getFreePort();

        // Simulate a real HTTP proxy: responds immediately to local L7 HEAD probe,
        // but takes 450ms (> firstResponseTimeoutMs) to dial an external CONNECT destination.
        const proxySockets: net.Socket[] = [];
        const slowConnectProxy = net.createServer((sock) => {
            proxySockets.push(sock);
            sock.on('data', (d) => {
                const req = d.toString('utf8');
                if (req.startsWith('HEAD / HTTP/1.1')) {
                    sock.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
                    sock.end();
                } else if (req.startsWith('CONNECT ')) {
                    setTimeout(() => {
                        if (!sock.destroyed) {
                            sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
                        }
                    }, 450);
                }
            });
        });
        await new Promise<void>((res) => slowConnectProxy.listen(0, '127.0.0.1', () => res()));
        const proxyPort = (slowConnectProxy.address() as net.AddressInfo).port;

        try {
            const started = await relay.startRelay(listenPort, proxyPort, [proxyPort]);
            assert.strictEqual(started, true);

            const client = new net.Socket();
            const responseData = await new Promise<string>((resolve, reject) => {
                client.connect(listenPort, '127.0.0.1', () => {
                    client.write('CONNECT api.example.com:443 HTTP/1.1\r\nHost: api.example.com:443\r\n\r\n');
                });
                client.on('data', (chunk) => {
                    client.destroy();
                    resolve(chunk.toString('utf8'));
                });
                client.on('error', (err) => reject(err));
            });

            assert.ok(responseData.includes('200 Connection Established'));
        } finally {
            await relay.stopRelay();
            for (const s of proxySockets) {
                s.destroy();
            }
            await new Promise<void>((res) => slowConnectProxy.close(() => res()));
        }
    });

    test('Provisioner.getListeningSocketInodes handles safe execution across platforms', async () => {
        // Safe cross-platform invocation should return a Set without throwing
        const inodes = await Provisioner.getListeningSocketInodes(7890);
        assert.ok(inodes instanceof Set);
    });
});

