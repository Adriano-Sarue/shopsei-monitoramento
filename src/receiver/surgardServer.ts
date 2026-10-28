import { EventEmitter } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import { extractSurgardLines, parseSurgardLine, SURGARD_ACK, SURGARD_NAK, surgardToAlarmEvent } from '../protocols/surgard.js';
import type { AlarmEvent } from '../protocols/types.js';
import type { RawFrame } from './server.js';

export interface SurgardServerOptions {
  host?: string;
  port: number;
  idleTimeoutMs?: number;
}

// Recebe o feed Sur-Gard por TCP (a ponte do PC da empresa repassa a porta serial para cá).
// Responde 0x06 (ACK) a cada mensagem entendida e 0x15 (NAK) às demais.
// Eventos emitidos: "raw" (RawFrame) e "event" (AlarmEvent), como na Receiver DC-09.
export class SurgardServer extends EventEmitter {
  private server?: Server;

  constructor(private readonly opts: SurgardServerOptions) {
    super();
  }

  async start(): Promise<number | undefined> {
    this.server = createServer((socket) => this.onConnection(socket));
    await new Promise<void>((resolve) => this.server!.listen(this.opts.port, this.opts.host ?? '0.0.0.0', resolve));
    const addr = this.server.address();
    return typeof addr === 'object' && addr ? addr.port : undefined;
  }

  private onConnection(socket: Socket): void {
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    let pending: Buffer = Buffer.alloc(0);
    socket.setTimeout(this.opts.idleTimeoutMs ?? 300_000, () => socket.destroy());
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 64 * 1024) pending = Buffer.alloc(0);
      const { lines, rest } = extractSurgardLines(pending);
      pending = Buffer.from(rest);
      for (const line of lines) {
        const receivedAt = new Date();
        try {
          const event: AlarmEvent = surgardToAlarmEvent(parseSurgardLine(line), remote, receivedAt);
          this.emit('raw', { receivedAt: receivedAt.toISOString(), transport: 'tcp', remote, frame: line, ok: true } satisfies RawFrame);
          this.emit('event', event);
          socket.write(SURGARD_ACK);
        } catch (err) {
          this.emit('raw', {
            receivedAt: receivedAt.toISOString(), transport: 'tcp', remote, frame: line, ok: false, error: (err as Error).message,
          } satisfies RawFrame);
          socket.write(SURGARD_NAK);
        }
      }
    });
    socket.on('error', () => socket.destroy());
  }

  async stop(): Promise<void> {
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}
