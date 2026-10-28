import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseContactId } from '../src/protocols/contactId.js';
import type { AlarmEvent } from '../src/protocols/types.js';
import { IncidentQueue } from '../src/incidents/queue.js';

function ev(account: string, cid: string): AlarmEvent {
  return {
    receivedAt: new Date(0).toISOString(), transport: 'tcp', remote: 't', protocol: 'ADM-CID', account, line: '0',
    sequence: '0001', encrypted: false, raw: '', ...parseContactId(cid),
  };
}

test('disparo entra na fila e vai para o operador livre', () => {
  const q = new IncidentQueue();
  const incident = q.handleEvent(ev('1234', '1130 01 003'))!;
  assert.equal(incident.situacao, 'aguardando');
  q.setOperator('Ana', true);
  assert.equal(q.get(incident.id).situacao, 'em_atendimento');
  assert.equal(q.get(incident.id).operador, 'Ana');
});

test('mais urgente é atendido primeiro e novas ocorrências vão ao operador menos ocupado', () => {
  const q = new IncidentQueue();
  const falha = q.handleEvent(ev('1', '1301 00 000'))!; // falta de AC, prioridade 3
  const panico = q.handleEvent(ev('2', '1120 01 000'))!; // pânico, prioridade 1
  q.setOperator('Ana', true);
  // Ana pega os dois (limite de 3), começando pelo mais urgente.
  assert.equal(q.get(panico.id).atendidaEm! <= q.get(falha.id).atendidaEm!, true);
  assert.equal(q.get(falha.id).operador, 'Ana');
  q.setOperator('Beto', true);
  const nova = q.handleEvent(ev('3', '1130 01 003'))!;
  assert.equal(q.get(nova.id).operador, 'Beto');
});

test('eventos repetidos da mesma conta entram na ocorrência aberta', () => {
  const q = new IncidentQueue();
  const a = q.handleEvent(ev('1234', '1130 01 003'))!;
  const b = q.handleEvent(ev('1234', '1131 01 004'))!;
  assert.equal(a.id, b.id);
  assert.equal(q.get(a.id).eventos.length, 2);
  assert.equal(q.list().length, 1);
});

test('arme/desarme e teste não geram ocorrência; restauração só anota', () => {
  const q = new IncidentQueue();
  assert.equal(q.handleEvent(ev('1234', '1401 01 005')), undefined);
  assert.equal(q.handleEvent(ev('1234', '1602 00 000')), undefined);
  const a = q.handleEvent(ev('1234', '1301 00 000'))!;
  q.handleEvent(ev('1234', '3301 00 000'));
  assert.equal(q.get(a.id).situacao, 'aguardando');
  assert.match(q.get(a.id).acoes[0]!.descricao, /Restauração/);
});

test('conta não cadastrada vira ocorrência marcada', () => {
  const q = new IncidentQueue({ contaCadastrada: (c) => c === '1234' });
  assert.equal(q.handleEvent(ev('94', '1130 01 003'))!.contaCadastrada, false);
  assert.equal(q.handleEvent(ev('1234', '1130 01 003'))!.contaCadastrada, true);
});

test('encerrar libera o operador para a próxima ocorrência e limita 3 simultâneas', () => {
  const q = new IncidentQueue();
  q.setOperator('Ana', true);
  const ids = ['1', '2', '3', '4'].map((c) => q.handleEvent(ev(c, '1130 01 003'))!.id);
  assert.equal(q.get(ids[3]!).situacao, 'aguardando');
  assert.throws(() => q.encerrar(ids[0]!, 'Beto', 'x'));
  q.encerrar(ids[0]!, 'Ana', 'Alarme falso, cliente confirmou');
  assert.equal(q.get(ids[3]!).operador, 'Ana');
});

test('adiar tira do operador e reativarVencidas devolve à fila no prazo', () => {
  let agora = new Date('2026-10-28T11:00:00Z');
  const q = new IncidentQueue({ now: () => agora });
  q.setOperator('Ana', true);
  const id = q.handleEvent(ev('1', '1301 00 000'))!.id;
  q.adiar(id, 'Ana', new Date('2026-10-28T11:30:00Z'));
  assert.equal(q.get(id).situacao, 'pendente');
  assert.equal(q.get(id).operador, undefined);
  assert.equal(q.reativarVencidas().length, 0);
  agora = new Date('2026-10-28T11:31:00Z');
  assert.equal(q.reativarVencidas().length, 1);
  assert.equal(q.get(id).situacao, 'em_atendimento');
});
