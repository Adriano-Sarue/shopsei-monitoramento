import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractSurgardLines, parseSurgardLine, surgardToAlarmEvent } from '../src/protocols/surgard.js';

test('Sur-Gard: lê receptora, linha, conta e evento Contact ID', () => {
  const msg = parseSurgardLine('5 1 011 18 1234 1130 01 003 8');
  assert.deepEqual([msg.receiver, msg.line, msg.account], ['1', '011', '1234']);
  const ev = surgardToAlarmEvent(msg, 'COM2', new Date(0));
  assert.equal(ev.protocol, 'SURGARD');
  assert.equal(ev.category, 'alarm');
  assert.equal(ev.zoneOrUser, '003');
});

test('Sur-Gard: falta de AC e restauração', () => {
  const ac = surgardToAlarmEvent(parseSurgardLine('5 1 011 18 0042 1301 00 000 5'), 'COM2');
  assert.match(ac.description, /energia AC/);
  const back = surgardToAlarmEvent(parseSurgardLine('5 1 011 18 0042 3301 00 000 5'), 'COM2');
  assert.equal(back.qualifier, 'restore');
});

test('Sur-Gard: formato desconhecido não derruba o processamento', () => {
  assert.throws(() => parseSurgardLine('lixo'));
});

test('Sur-Gard: separa mensagens pelo terminador 0x14', () => {
  const buf = Buffer.from('5 1 011 18 1234 1130 01 003 8\x145 1 011 18 1234 31', 'latin1');
  const { lines, rest } = extractSurgardLines(buf);
  assert.equal(lines.length, 1);
  assert.equal(rest.toString('latin1'), '5 1 011 18 1234 31');
});
