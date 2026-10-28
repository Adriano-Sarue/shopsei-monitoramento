import assert from 'node:assert/strict';
import { once } from 'node:events';
import { connect } from 'node:net';
import { test } from 'node:test';
import type { AlarmEvent } from '../src/protocols/types.js';
import { SurgardServer } from '../src/receiver/surgardServer.js';

test('servidor Sur-Gard responde ACK/NAK e emite o evento', async () => {
  const server = new SurgardServer({ port: 0, host: '127.0.0.1' });
  const port = await server.start();
  const events: AlarmEvent[] = [];
  server.on('event', (e: AlarmEvent) => events.push(e));

  const socket = connect(port!, '127.0.0.1');
  await once(socket, 'connect');
  socket.write('5 1 011 18 1234 1130 01 003 8\x14');
  const [ack] = (await once(socket, 'data')) as [Buffer];
  assert.equal(ack[0], 0x06);
  socket.write('lixo\x14');
  const [nak] = (await once(socket, 'data')) as [Buffer];
  assert.equal(nak[0], 0x15);

  assert.equal(events.length, 1);
  assert.equal(events[0]!.account, '1234');
  socket.destroy();
  await server.stop();
});
