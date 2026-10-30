/**
 * AG-Wormhole - Ingress Relay & Reconnection Bridge
 * Provides zero-downtime TCP port bridging when the primary port encounters
 * SSH forward collisions upon network disconnect and reconnection.
 */

import * as net from 'net';
import { logger } from '../shared/logger';

export class IngressRelay {
    private static instance: IngressRelay;
    private server?: net.Server;
    private listeningPort?: number;
    private targetPort?: number;

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
     * Start local TCP bridge forwarding all traffic from listenPort to active targetPort
     */
    public async startRelay(listenPort: number, targetPort: number): Promise<boolean> {
        if (this.isRelaying() && this.listeningPort === listenPort && this.targetPort === targetPort) {
            return true;
        }

        await this.stopRelay();

        return new Promise((resolve) => {
            const server = net.createServer({ pauseOnConnect: true }, (clientSocket) => {
                const targetSocket = new net.Socket();
                clientSocket.setNoDelay(true);
                clientSocket.setKeepAlive(true, 15000);
                targetSocket.setNoDelay(true);
                targetSocket.setKeepAlive(true, 15000);

                targetSocket.connect(targetPort, '127.0.0.1', () => {
                    clientSocket.pipe(targetSocket);
                    targetSocket.pipe(clientSocket);
                    clientSocket.resume();
                });

                const cleanup = () => {
                    if (!clientSocket.destroyed) {
                        clientSocket.destroy();
                    }
                    if (!targetSocket.destroyed) {
                        targetSocket.destroy();
                    }
                };

                clientSocket.on('error', cleanup);
                targetSocket.on('error', cleanup);
                clientSocket.on('close', cleanup);
                targetSocket.on('close', cleanup);
            });

            server.on('error', (err: { message?: string }) => {
                logger.log(`IngressRelay failed on port ${listenPort}: ${err.message}`, false);
                this.server = undefined;
                this.listeningPort = undefined;
                this.targetPort = undefined;
                resolve(false);
            });

            server.listen(listenPort, '127.0.0.1', () => {
                this.server = server;
                this.listeningPort = listenPort;
                this.targetPort = targetPort;
                logger.log(`IngressRelay activated: bridging local 127.0.0.1:${listenPort} -> live tunnel 127.0.0.1:${targetPort}`, false);
                resolve(true);
            });
        });
    }

    /**
     * Stop active relay and release the listening port
     */
    public async stopRelay(): Promise<void> {
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

