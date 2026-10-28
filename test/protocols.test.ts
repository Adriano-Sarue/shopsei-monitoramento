import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseContactId } from '../src/protocols/contactId.js';
import { crc16 } from '../src/protocols/crc16.js';
import { buildAck, buildFrame, buildNak, decryptPayload, encryptPayload, extractFrames, parseFrame } from '../src/protocols/dc09.js';
import { toAlarmEvent } from '../src/protocols/normalize.js';
import { parseSia } from '../src/protocols/sia.js';

const KEY = Buffer.from('000102030405060708090A0B0C0D0E0F', 'hex');
const origin = { transport: 'tcp' as const, remote: 'teste', raw: '' };

test('CRC-16/ARC confere com o valor de verificação padrão', () => {
  assert.equal(crc16('123456789'), 0xbb3d);
});

test('Contact ID: disparo, restauração e arme/desarme', () => {
  const alarm = parseContactId('1130 01 003');
  assert.equal(alarm.qualifier, 'new');
  assert.equal(alarm.category, 'alarm');
  assert.equal(alarm.zoneOrUser, '003');
  assert.equal(alarm.partition, '01');

  const restore = parseContactId('313001003');
  assert.equal(restore.qualifier, 'restore');
  assert.match(restore.description, /Restauração/);
  assert.equal(restore.priority, 5);

  assert.match(parseContactId('1401 01 005').description, /^Desarme/);
  assert.match(parseContactId('3401 01 005').description, /^Arme/);
  assert.throws(() => parseContactId('abc'));
});

test('SIA: código com partição e zona', () => {
  const ev = parseSia('Nri1/BA015');
  assert.equal(ev.code, 'BA');
  assert.equal(ev.partition, '1');
  assert.equal(ev.zoneOrUser, '015');
  assert.equal(ev.category, 'alarm');
});

test('DC-09: monta e lê um quadro sem criptografia', () => {
  const frame = buildFrame(
    { id: 'ADM-CID', sequence: '0007', receiver: '1', line: '2', account: '1234', data: '#1234|1130 01 003' },
    { timestamp: new Date(Date.UTC(2026, 9, 28, 12, 0, 0)) },
  );
  assert.ok(frame.startsWith('\n') && frame.endsWith('\r'));
  const msg = parseFrame(frame);
  assert.equal(msg.id, 'ADM-CID');
  assert.equal(msg.sequence, '0007');
  assert.equal(msg.receiver, '1');
  assert.equal(msg.line, '2');
  assert.equal(msg.account, '1234');
  assert.equal(msg.data, '#1234|1130 01 003');
  assert.equal(msg.timestamp, '12:00:00,10-28-2026');
});

test('DC-09: rejeita CRC e comprimento errados', () => {
  const frame = buildFrame({ id: 'NULL', sequence: '0001', line: '0', account: '1234', data: '' });
  const badCrc = `\n0000${frame.slice(5)}`;
  assert.throws(() => parseFrame(badCrc), /CRC/);
  const badLen = frame.replace(/^\n(....)0.../, '\n$10FFF');
  assert.throws(() => parseFrame(badLen), /Comprimento/);
});

test('DC-09: criptografia AES ida e volta', () => {
  const plain = '[#1234|1130 01 003]_12:00:00,10-28-2026';
  const hex = encryptPayload(plain, KEY);
  assert.equal(hex.length % 32, 0);
  assert.equal(decryptPayload(hex, KEY), plain);

  const frame = buildFrame({ id: 'ADM-CID', sequence: '0002', line: '0', account: '1234', data: '#1234|1130 01 003' }, { key: KEY });
  assert.ok(frame.includes('"*ADM-CID"'));
  const msg = parseFrame(frame, () => KEY);
  assert.equal(msg.encrypted, true);
  assert.equal(msg.data, '#1234|1130 01 003');
  assert.ok(msg.timestamp);
  assert.throws(() => parseFrame(frame), /sem chave/);
});

test('DC-09: ACK repete sequência e conta; NAK leva data/hora', () => {
  const msg = parseFrame(buildFrame({ id: 'ADM-CID', sequence: '0042', line: '3', account: '9F1', data: '#9F1|1130 01 003' }));
  const ack = parseFrame(buildAck(msg));
  assert.equal(ack.id, 'ACK');
  assert.equal(ack.sequence, '0042');
  assert.equal(ack.account, '9F1');
  assert.equal(ack.line, '3');
  const nak = parseFrame(buildNak());
  assert.equal(nak.id, 'NAK');
  assert.ok(nak.timestamp);
});

test('extractFrames separa quadros colados e guarda o resto', () => {
  const a = buildFrame({ id: 'NULL', sequence: '0001', line: '0', account: '1', data: '' } as never);
  const b = buildFrame({ id: 'NULL', sequence: '0002', line: '0', account: '1', data: '' } as never);
  const { frames, rest } = extractFrames(`lixo${a}${b}${b.slice(0, 10)}`);
  assert.equal(frames.length, 2);
  assert.equal(rest, b.slice(0, 10));
});

test('normalização: NULL vira supervisão e protocolo desconhecido não se perde', () => {
  const nullMsg = parseFrame(buildFrame({ id: 'NULL', sequence: '0001', line: '0', account: '1234', data: '' }));
  assert.equal(toAlarmEvent(nullMsg, origin).category, 'supervision');

  const other = parseFrame(buildFrame({ id: 'JFL-XYZ', sequence: '0001', line: '0', account: '1234', data: 'abc' }));
  const ev = toAlarmEvent(other, origin);
  assert.equal(ev.category, 'other');
  assert.match(ev.description, /abc/);
});
