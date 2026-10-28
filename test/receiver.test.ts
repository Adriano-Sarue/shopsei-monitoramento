import assert from 'node:assert/strict';
import { createSocket } from 'node:dgram';
import { once } from 'node:events';
import { connect } from 'node:net';
import { test } from 'node:test';
import { buildFrame, extractFrames, parseFrame } from '../src/protocols/dc09.js';
import type { AlarmEvent } from '../src/protocols/types.js';
import { Receiver } from '../src/receiver/server.js';

const KEY = Buffer.from('00112233445566778899AABBCCDDEEFF', 'hex');

test('receptora TCP responde ACK e emite o evento, inclusive criptografado', async () => {
  const receiver = new Receiver({ tcpPort: 0, host: '127.0.0.1', keyFor: (acct) => (acct === '5678' ? KEY : undefined) });
  const { tcpPort } = await receiver.start();
  const events: AlarmEvent[] = [];
  receiver.on('event', (e: AlarmEvent) => events.push(e));

  const socket = connect(tcpPort!, '127.0.0.1');
  await once(socket, 'connect');
  const plain = buildFrame({ id: 'ADM-CID', sequence: '0001', line: '0', account: '1234', data: '#1234|1130 01 003' });
  const enc = buildFrame({ id: 'ADM-CID', sequence: '0002', line: '0', account: '5678', data: '#5678|1120 01 000' }, { key: KEY });
  // Envia os dois quadros partidos em pedaços para testar a remontagem.
  const all = plain + enc;
  socket.write(all.slice(0, 7));
  socket.write(all.slice(7));

  let buffer = '';
  while (extractFrames(buffer).frames.length < 2) {
    const [chunk] = (await once(socket, 'data')) as [Buffer];
    buffer += chunk.toString('latin1');
  }
  const replies = extractFrames(buffer).frames.map((f) => parseFrame(f, () => KEY));
  assert.deepEqual(replies.map((r) => [r.id, r.sequence]), [['ACK', '0001'], ['ACK', '0002']]);
  assert.equal(replies[1]!.encrypted, true);

  assert.equal(events.length, 2);
  assert.equal(events[0]!.category, 'alarm');
  assert.equal(events[1]!.description, 'Pânico');
  assert.equal(events[1]!.encrypted, true);

  socket.destroy();
  await receiver.stop();
});

test('receptora UDP responde NAK para quadro inválido', async () => {
  const receiver = new Receiver({ udpPort: 0, host: '127.0.0.1' });
  const { udpPort } = await receiver.start();
  const client = createSocket('udp4');
  client.send(Buffer.from('\n00000005"NULL"\r', 'latin1'), udpPort!, '127.0.0.1');
  const [msg] = (await once(client, 'message')) as [Buffer];
  assert.equal(parseFrame(msg.toString('latin1')).id, 'NAK');
  client.close();
  await receiver.stop();
});
