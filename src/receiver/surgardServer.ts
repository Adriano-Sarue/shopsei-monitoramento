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
// Teste de linha (batimento) do Sur-Gard: "1" + receptora/linha, espaços e "@". A ponte da Shop Sei manda um a
// cada 30 s, para o servidor saber que a internet da base está de pé mesmo sem eventos. Não tem resposta: a
// ponte repassa ao Active Net tudo que o servidor responde, e um ACK a mais confundiria a receptora.
const BATIMENTO = /^1\d{2,6}\s+@\s*$/;

export class SurgardServer extends EventEmitter {
  private server?: Server;
  private readonly abertas = new Set<Socket>();
  // Quando chegou qualquer coisa da base (evento ou batimento).
  ultimoSinal?: Date;

  get conexoes(): number {
    return this.abertas.size;
  }

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
    this.abertas.add(socket);
    this.ultimoSinal = new Date();
    socket.on('close', () => this.abertas.delete(socket));
    socket.setTimeout(this.opts.idleTimeoutMs ?? 300_000, () => socket.destroy());
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 64 * 1024) pending = Buffer.alloc(0);
      const { lines, rest } = extractSurgardLines(pending);
      pending = Buffer.from(rest);
      for (const line of lines) {
        const receivedAt = new Date();
        this.ultimoSinal = receivedAt;
        if (BATIMENTO.test(line.trim())) continue;
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
    for (const s of this.abertas) s.destroy();
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}
