/**
 * AG-Wormhole - Ingress Relay & Reconnection Bridge
 * Provides zero-downtime TCP port bridging and dynamic multi-port hunting when
 * the primary port encounters SSH forward collisions or cold-start delays.
 */

import * as net from 'net';
import { logger } from '../shared/logger';
import { ALL_FALLBACK_PORT_OFFSETS } from '../shared/constants';

export class IngressRelay {
    private static instance: IngressRelay;
    private server?: net.Server;
    private standbyGuardServer?: net.Server;
    private standbyGuardPort?: number;
    private listeningPort?: number;
    private targetPort?: number;
    private candidatePorts: number[] = [];
    private transitionChain: Promise<void> = Promise.resolve();

    private readonly maxRounds = 25;
    private readonly baseRetryDelayMs = 150;
    private readonly maxPreBufferBytes = 65536;
    private readonly firstResponseTimeoutMs = 260;

    private constructor() {}

    public static getInstance(): IngressRelay {
        if (!IngressRelay.instance) {
            IngressRelay.instance = new IngressRelay();
        }
        return IngressRelay.instance;
    }

    public isRelaying(): boolean {
        return this.server !== undefined && this.server.listening;
    }

    public getRelayInfo(): { isRelaying: boolean; listeningPort?: number; targetPort?: number } {
        return {
            isRelaying: this.isRelaying(),
            listeningPort: this.listeningPort,
            targetPort: this.targetPort
        };
    }

    /**
     * Dynamically update the preferred target port without closing the listening socket
     */
    public updateTargetPort(newTargetPort: number): void {
        this.targetPort = newTargetPort;
        if (!this.candidatePorts.includes(newTargetPort)) {
            this.candidatePorts.unshift(newTargetPort);
        }
    }

    /**
     * Perform a fast application-level (L7) proxy verification against a candidate port
     * to reject dead zombie sshd sockets that accept TCP SYN-ACKs but hang or immediately EOF.
     */
    private verifyUpstreamCandidateL7(port: number, timeoutMs: number = 350): Promise<boolean> {
        return new Promise((resolve) => {
            const probeSocket = new net.Socket();
            let settled = false;

            const finish = (ok: boolean) => {
                if (settled) {
                    return;
                }
                settled = true;
                probeSocket.removeAllListeners();
                probeSocket.destroy();
                resolve(ok);
            };

            probeSocket.setNoDelay(true);
            probeSocket.setTimeout(timeoutMs);

            probeSocket.on('connect', () => {
                try {
                    probeSocket.write('HEAD / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');
                } catch {
                    finish(false);
                }
            });

            probeSocket.on('data', (chunk) => {
                if (chunk && chunk.length > 0) {
                    const text = chunk.toString('utf8');
                    const isHttpOrSocks = /^HTTP\/1\.[01]\s+\d+/i.test(text) || (chunk.length >= 2 && chunk[0] === 0x05);
                    finish(isHttpOrSocks);
                } else {
                    finish(false);
                }
            });

            probeSocket.on('timeout', () => {
                finish(false);
            });

            probeSocket.on('error', () => finish(false));
            probeSocket.on('close', () => finish(false));

            probeSocket.connect(port, '127.0.0.1');
        });
    }

    /**
     * Hold a temporary standby guard socket on a secondary fallback port (e.g., port+2)
     * while the primary fallback port (port+1) is free, preventing a single incoming sshd
     * session from greedily binding all fallback ports simultaneously.
     */
    public async ensureStandbyGuard(guardPort: number): Promise<boolean> {
        if (this.standbyGuardServer && this.standbyGuardPort === guardPort) {
            return true;
        }
        await this.releaseStandbyGuard();
        if (!guardPort || guardPort <= 0 || guardPort > 65535) {
            return false;
        }

        return new Promise((resolve) => {
            const guard = net.createServer((sock) => {
                sock.destroy();
            });
            guard.on('error', () => {
                this.standbyGuardServer = undefined;
                this.standbyGuardPort = undefined;
                resolve(false);
            });
            guard.listen(guardPort, '127.0.0.1', () => {
                this.standbyGuardServer = guard;
                this.standbyGuardPort = guardPort;
                resolve(true);
            });
        });
    }

    /**
     * Release the standby guard socket so the next reconnecting sshd session can bind it
     */
    public async releaseStandbyGuard(): Promise<void> {
        if (this.standbyGuardServer) {
            const g = this.standbyGuardServer;
            this.standbyGuardServer = undefined;
            this.standbyGuardPort = undefined;
            await new Promise<void>((resolve) => {
                g.close(() => resolve());
            });
        }
    }

    /**
     * Temporarily suspend the relay for a brief duration (yielding the listening port)
     * and allow inspection or takeover by the native SSH daemon.
     */
    public async yieldPort(durationMs: number = 250): Promise<void> {
        if (!this.isRelaying()) {
            return;
        }
        await this.stopRelay();
        if (durationMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, durationMs));
        }
    }

    /**
     * Build ordered list of upstream candidate ports to probe when connecting
     */
    private getOrderedCandidatePorts(defaultTarget: number, listenPort: number): number[] {
        const currentTarget = this.targetPort || defaultTarget;
        const set = new Set<number>();
        if (currentTarget !== listenPort && currentTarget > 0 && currentTarget <= 65535) {
            set.add(currentTarget);
        }
        for (const p of this.candidatePorts) {
            if (p !== listenPort && p > 0 && p <= 65535) {
                set.add(p);
            }
        }
        // Automatically include standard cluster fallback offsets relative to listenPort
        for (const offset of ALL_FALLBACK_PORT_OFFSETS) {
            const fp = listenPort + offset;
            if (fp !== listenPort && fp > 0 && fp <= 65535) {
                set.add(fp);
            }
        }
        if (set.size === 0 && defaultTarget > 0 && defaultTarget <= 65535) {
            set.add(defaultTarget);
        }
        return Array.from(set);
    }

    /**
     * Start local TCP bridge forwarding all traffic from listenPort to active targetPort.
     * Incorporates dynamic multi-port hunting, First-Response-Verified Replay Buffering,
     * zombie/blackhole socket detection, and extended connection holding (~6.0s window)
     * to completely absorb cold-start races and transient network flickers without ever
     * returning ECONNREFUSED or dropping initial OAuth2/HTTP payloads.
     */
    public async startRelay(listenPort: number, targetPort: number, candidates?: number[]): Promise<boolean> {
        let result = false;
        this.transitionChain = this.transitionChain.then(async () => {
            result = await this.startRelayInternal(listenPort, targetPort, candidates);
        }).catch(() => {
            result = false;
        });
        await this.transitionChain;
        return result;
    }

    private async startRelayInternal(listenPort: number, targetPort: number, candidates?: number[]): Promise<boolean> {
        if (candidates && candidates.length > 0) {
            this.candidatePorts = [...candidates];
        } else {
            this.candidatePorts = [targetPort, ...ALL_FALLBACK_PORT_OFFSETS.map(o => listenPort + o)].filter(
                (p, idx, arr) => p !== listenPort && p > 0 && p <= 65535 && arr.indexOf(p) === idx
            );
        }

        if (this.isRelaying() && this.listeningPort === listenPort) {
            this.targetPort = targetPort;
            return true;
        }

        await this.stopRelayInternal();

        for (let bindAttempt = 0; bindAttempt < 6; bindAttempt++) {
            const bound = await this.tryBindRelayServer(listenPort, targetPort);
            if (bound) {
                return true;
            }
            if (bindAttempt < 5) {
                await new Promise((r) => setTimeout(r, 25));
            }
        }
        return false;
    }

    private tryBindRelayServer(listenPort: number, targetPort: number): Promise<boolean> {
        return new Promise((resolve) => {
            const server = net.createServer({ pauseOnConnect: true, allowHalfOpen: true }, (clientSocket) => {
                clientSocket.setNoDelay(true);
                clientSocket.setKeepAlive(true, 15000);

                let round = 0;
                let activeTargetSocket: net.Socket | null = null;
                let isPiped = false;
                let isConnectedToCandidate = false;
                let totalBufferedBytes = 0;
                const clientPreBuffer: Buffer[] = [];
                let firstResponseTimer: NodeJS.Timeout | null = null;

                const clearResponseTimer = () => {
                    if (firstResponseTimer) {
                        clearTimeout(firstResponseTimer);
                        firstResponseTimer = null;
                    }
                };

                // Capture initial client request bytes into replay buffer until upstream candidate responds
                const onClientInitialData = (chunk: Buffer) => {
                    if (isPiped) {
                        return;
                    }
                    if (totalBufferedBytes + chunk.length <= this.maxPreBufferBytes) {
                        clientPreBuffer.push(Buffer.from(chunk));
                        totalBufferedBytes += chunk.length;
                    }
                    if (isConnectedToCandidate && activeTargetSocket && !activeTargetSocket.destroyed) {
                        try {
                            activeTargetSocket.write(chunk);
                        } catch {
                            // Handled by targetSocket error/close
                        }
                    }
                };

                clientSocket.on('data', onClientInitialData);
                clientSocket.resume();

                const tryHuntAndConnect = (candidateIdx: number) => {
                    if (clientSocket.destroyed || isPiped) {
                        return;
                    }

                    const orderedPorts = this.getOrderedCandidatePorts(targetPort, listenPort);
                    if (candidateIdx >= orderedPorts.length) {
                        round++;
                        if (round < this.maxRounds && !clientSocket.destroyed) {
                            const delay = Math.min(350, this.baseRetryDelayMs + round * 15);
                            setTimeout(() => tryHuntAndConnect(0), delay);
                        } else if (!clientSocket.destroyed) {
                            clientSocket.destroy();
                        }
                        return;
                    }

                    const candidatePort = orderedPorts[candidateIdx];
                    if (this.standbyGuardPort === candidatePort) {
                        tryHuntAndConnect(candidateIdx + 1);
                        return;
                    }

                    const targetSocket = new net.Socket();
                    activeTargetSocket = targetSocket;
                    isConnectedToCandidate = false;
                    targetSocket.setNoDelay(true);
                    targetSocket.setKeepAlive(true, 15000);
                    targetSocket.setTimeout(700);

                    let graceTimer: NodeJS.Timeout | null = null;

                    const commitVerifiedPipe = (initialUpstreamChunk?: Buffer) => {
                        if (isPiped || clientSocket.destroyed || targetSocket.destroyed) {
                            return;
                        }
                        if (graceTimer) {
                            clearTimeout(graceTimer);
                            graceTimer = null;
                        }
                        clearResponseTimer();
                        targetSocket.setTimeout(300000);
                        clientSocket.setTimeout(300000);
                        if (!isConnectedToCandidate && clientPreBuffer.length > 0) {
                            try {
                                targetSocket.write(Buffer.concat(clientPreBuffer));
                            } catch {
                                onCandidateFail();
                                return;
                            }
                        }
                        isConnectedToCandidate = true;
                        isPiped = true;
                        this.targetPort = candidatePort;

                        clientSocket.removeListener('data', onClientInitialData);
                        clientPreBuffer.length = 0;

                        if (initialUpstreamChunk && initialUpstreamChunk.length > 0) {
                            clientSocket.write(initialUpstreamChunk);
                        }
                        clientSocket.pipe(targetSocket);
                        targetSocket.pipe(clientSocket);
                    };

                    const onCandidateFail = () => {
                        if (graceTimer) {
                            clearTimeout(graceTimer);
                            graceTimer = null;
                        }
                        clearResponseTimer();
                        isConnectedToCandidate = false;
                        targetSocket.removeAllListeners();
                        targetSocket.destroy();
                        if (isPiped) {
                            if (!clientSocket.destroyed) {
                                clientSocket.destroy();
                            }
                            return;
                        }
                        if (!clientSocket.destroyed) {
                            // Immediately try the next candidate port in the cluster and replay clientPreBuffer
                            tryHuntAndConnect(candidateIdx + 1);
                        }
                    };

                    targetSocket.connect(candidatePort, '127.0.0.1', () => {
                        // Guard against zombie sshd ports that complete TCP 3-way handshake
                        // and then either immediately send FIN/RST or swallow the request as a half-open blackhole.
                        graceTimer = setTimeout(() => {
                            if (isPiped || clientSocket.destroyed || targetSocket.destroyed) {
                                return;
                            }
                            isConnectedToCandidate = true;
                            if (clientPreBuffer.length > 0) {
                                try {
                                    targetSocket.write(Buffer.concat(clientPreBuffer));
                                } catch {
                                    onCandidateFail();
                                    return;
                                }
                            }
                            // Wait for the first upstream response byte; if candidate does not respond within
                            // firstResponseTimeoutMs, verify L7 proxy liveness out-of-band so slow outbound
                            // HTTP CONNECT dials (>400ms) are committed safely while half-open blackhole sshd
                            // sockets fail over and replay clientPreBuffer to the next port.
                            clearResponseTimer();
                            firstResponseTimer = setTimeout(() => {
                                if (isPiped || clientSocket.destroyed || targetSocket.destroyed) {
                                    return;
                                }
                                if (totalBufferedBytes === 0) {
                                    commitVerifiedPipe();
                                    return;
                                }
                                this.verifyUpstreamCandidateL7(candidatePort, 220).then((l7Alive) => {
                                    if (isPiped || clientSocket.destroyed || targetSocket.destroyed) {
                                        return;
                                    }
                                    if (l7Alive) {
                                        commitVerifiedPipe();
                                    } else {
                                        onCandidateFail();
                                    }
                                }).catch(() => {
                                    if (!isPiped) {
                                        onCandidateFail();
                                    }
                                });
                            }, this.firstResponseTimeoutMs);
                        }, 15);
                    });

                    targetSocket.on('data', (chunk: Buffer) => {
                        if (!isPiped) {
                            commitVerifiedPipe(chunk);
                        }
                    });

                    targetSocket.on('timeout', () => {
                        if (!isPiped) {
                            onCandidateFail();
                        } else {
                            targetSocket.destroy();
                            if (!clientSocket.destroyed) {
                                clientSocket.destroy();
                            }
                        }
                    });
                    targetSocket.on('error', onCandidateFail);
                    targetSocket.on('end', () => {
                        if (!isPiped) {
                            onCandidateFail();
                        } else if (!clientSocket.destroyed) {
                            clientSocket.end();
                        }
                    });
                    targetSocket.on('close', () => {
                        if (!isPiped) {
                            onCandidateFail();
                        } else if (!clientSocket.destroyed) {
                            clientSocket.destroy();
                        }
                    });
                };

                const cleanupClient = () => {
                    clearResponseTimer();
                    clientPreBuffer.length = 0;
                    if (activeTargetSocket && !activeTargetSocket.destroyed) {
                        activeTargetSocket.destroy();
                    }
                };
                clientSocket.on('timeout', () => {
                    cleanupClient();
                    if (!clientSocket.destroyed) {
                        clientSocket.destroy();
                    }
                });
                clientSocket.on('error', cleanupClient);
                clientSocket.on('close', cleanupClient);

                tryHuntAndConnect(0);
            });

            server.on('error', (err: { message?: string }) => {
                logger.log(`IngressRelay bind attempt on port ${listenPort}: ${err.message}`, false);
                resolve(false);
            });

            server.listen(listenPort, '127.0.0.1', () => {
                this.server = server;
                this.listeningPort = listenPort;
                this.targetPort = targetPort;
                logger.log(`IngressRelay activated: holding 127.0.0.1:${listenPort} -> hunting cluster [primary target: ${targetPort}]`, false);
                resolve(true);
            });
        });
    }

    /**
     * Stop active relay and release the listening port
     */
    public async stopRelay(): Promise<void> {
        this.transitionChain = this.transitionChain.then(async () => {
            await this.stopRelayInternal();
        }).catch(() => {});
        await this.transitionChain;
    }

    private async stopRelayInternal(): Promise<void> {
        await this.releaseStandbyGuard();
        if (this.server) {
            const s = this.server;
            this.server = undefined;
            this.listeningPort = undefined;
            this.targetPort = undefined;
            await new Promise<void>((resolve) => {
                s.close(() => resolve());
            });
            logger.log('IngressRelay stopped.', false);
        }
    }
}

