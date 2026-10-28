import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import { createServer, type Server, type Socket } from 'node:net';
import { buildAck, buildNak, extractFrames, parseFrame, type KeyLookup } from '../protocols/dc09.js';
import { toAlarmEvent } from '../protocols/normalize.js';
import type { AlarmEvent } from '../protocols/types.js';

export interface RawFrame {
  receivedAt: string;
  transport: 'tcp' | 'udp';
  remote: string;
  frame: string;
  ok: boolean;
  error?: string;
}

export interface ReceiverOptions {
  host?: string;
  tcpPort?: number;
  udpPort?: number;
  keyFor?: KeyLookup;
  // Fecha conexões TCP paradas por mais que isso (ms).
  idleTimeoutMs?: number;
}

// Eventos emitidos: "raw" (RawFrame), "event" (AlarmEvent), "listening".
export class Receiver extends EventEmitter {
  private tcp?: Server;
  private udp?: UdpSocket;
  private readonly keyFor: KeyLookup;

  constructor(private readonly opts: ReceiverOptions = {}) {
    super();
    this.keyFor = opts.keyFor ?? (() => undefined);
  }

  // Processa um quadro e devolve a resposta (ACK ou NAK) a enviar para a central.
  handleFrame(frame: string, transport: 'tcp' | 'udp', remote: string): string {
    const receivedAt = new Date();
    try {
      const msg = parseFrame(frame, this.keyFor);
      this.emit('raw', { receivedAt: receivedAt.toISOString(), transport, remote, frame, ok: true } satisfies RawFrame);
      const event: AlarmEvent = toAlarmEvent(msg, { transport, remote, raw: frame, receivedAt });
      this.emit('event', event);
      return buildAck(msg, msg.encrypted ? this.keyFor(msg.account) : undefined);
    } catch (err) {
      this.emit('raw', {
        receivedAt: receivedAt.toISOString(), transport, remote, frame, ok: false, error: (err as Error).message,
      } satisfies RawFrame);
      return buildNak();
    }
  }

  async start(): Promise<{ tcpPort?: number; udpPort?: number }> {
    const host = this.opts.host ?? '0.0.0.0';
    const result: { tcpPort?: number; udpPort?: number } = {};

    if (this.opts.tcpPort !== undefined) {
      this.tcp = createServer((socket) => this.onTcp(socket));
      await new Promise<void>((resolve) => this.tcp!.listen(this.opts.tcpPort, host, resolve));
      const addr = this.tcp.address();
      result.tcpPort = typeof addr === 'object' && addr ? addr.port : undefined;
    }

    if (this.opts.udpPort !== undefined) {
      const udp = createSocket('udp4');
      this.udp = udp;
      udp.on('message', (buf, rinfo) => {
        const remote = `${rinfo.address}:${rinfo.port}`;
        for (const frame of extractFrames(buf.toString('latin1')).frames) {
          udp.send(Buffer.from(this.handleFrame(frame, 'udp', remote), 'latin1'), rinfo.port, rinfo.address);
        }
      });
      await new Promise<void>((resolve) => udp.bind(this.opts.udpPort, host, resolve));
      result.udpPort = udp.address().port;
    }

    this.emit('listening', result);
    return result;
  }

  private onTcp(socket: Socket): void {
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    let buffer = '';
    socket.setTimeout(this.opts.idleTimeoutMs ?? 120_000, () => socket.destroy());
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      // Proteção contra lixo sem fim de quadro.
      if (buffer.length > 64 * 1024) buffer = '';
      const { frames, rest } = extractFrames(buffer);
      buffer = rest;
      for (const frame of frames) {
        socket.write(Buffer.from(this.handleFrame(frame, 'tcp', remote), 'latin1'));
      }
    });
    socket.on('error', () => socket.destroy());
  }

  async stop(): Promise<void> {
    await Promise.all([
      this.tcp ? new Promise<void>((resolve) => this.tcp!.close(() => resolve())) : undefined,
      this.udp ? new Promise<void>((resolve) => this.udp!.close(() => resolve())) : undefined,
    ]);
  }
}
