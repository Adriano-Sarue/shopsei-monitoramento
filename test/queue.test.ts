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

test('arme e desarme durante uma ocorrência aberta são anotados, sem concluir nem contar como restauração', () => {
  const q = new IncidentQueue();
  const a = q.handleEvent(ev('1234', '1130 01 003'))!;
  q.handleEvent(ev('1234', '1401 01 005'));
  q.handleEvent(ev('1234', '3401 01 005'));
  const o = q.get(a.id);
  assert.equal(o.situacao, 'aguardando');
  assert.deepEqual(o.acoes.map((x) => x.descricao), ['Desarme pelo usuário 005', 'Arme pelo usuário 005']);
  assert.equal(o.eventos.length, 3);
});

test('Contact ID: E401 é desarme e R401 é arme', () => {
  assert.equal(parseContactId('1401 01 005').description, 'Desarme pelo usuário');
  assert.equal(parseContactId('3401 01 005').description, 'Arme pelo usuário');
  assert.equal(parseContactId('3408 01 000').description, 'Arme rápido');
  assert.equal(parseContactId('1407 01 000').description, 'Desarme remoto');
});

test('restauração não repete a palavra no registro', () => {
  const q = new IncidentQueue();
  const a = q.handleEvent(ev('1234', '1301 00 000'))!;
  q.handleEvent(ev('1234', '3301 00 000'));
  assert.equal(q.get(a.id).acoes[0]!.descricao, 'Restauração recebida: Falha AC');
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

test('lote: conclui várias ocorrências e ignora as que estão com outro operador', () => {
  const q = new IncidentQueue();
  q.setOperator('Beto', true);
  const c = q.handleEvent(ev('5', '1130 01 003'))!.id; // fica com Beto
  q.setOperator('Beto', false);
  const a = q.handleEvent(ev('16', '1301 00 000'))!.id;
  const b = q.handleEvent(ev('137', '1301 00 000'))!.id;
  const r = q.concluirEmLote([a, b, c], 'Ana', 'Falha de energia do cliente', 'Restaurou sozinha');
  assert.deepEqual(r.concluidas.map((i) => i.id).sort(), [a, b].sort());
  assert.deepEqual(r.ignoradas, [c]);
  assert.equal(q.get(a).conclusao, 'Restaurou sozinha');
  assert.equal(q.get(a).situacao, 'encerrada');
});

test('lote: agendar várias ocorrências de uma vez', () => {
  const agora = new Date('2026-10-28T11:00:00Z');
  const q = new IncidentQueue({ now: () => agora });
  const a = q.handleEvent(ev('16', '1301 00 000'))!.id;
  const b = q.handleEvent(ev('137', '1250 00 000'))!.id;
  const r = q.agendarEmLote([a, b], 'Ana', new Date('2026-10-28T12:00:00Z'));
  assert.equal(r.agendadas.length, 2);
  assert.equal(q.get(a).situacao, 'pendente');
});

test('operador sem conexão devolve as ocorrências à fila e outro pega', () => {
  const q = new IncidentQueue();
  q.setOperator('Ana', true);
  q.handleEvent(ev('0013', '1130 01 003'));
  assert.equal(q.list()[0]!.operador, 'Ana');
  q.setOperator('Beto', true);
  const devolvidas = q.desconectar('Ana');
  assert.equal(devolvidas.length, 1);
  assert.equal(q.estaDisponivel('Ana'), false);
  // Beto estava livre: pega na hora.
  assert.equal(q.list()[0]!.operador, 'Beto');
  assert.match(q.list()[0]!.acoes.at(-1)!.descricao, /Ana ficou sem conexão/);
});

test('evento repetido não cresce sem limite e ocorrências encerradas saem da memória', () => {
  let agora = new Date('2026-10-28T12:00:00Z');
  const q = new IncidentQueue({ now: () => agora });
  for (let i = 0; i < 500; i++) q.handleEvent(ev('0013', '1301 00 000'));
  assert.equal(q.list().length, 1);
  assert.equal(q.list()[0]!.eventos.length, 200);
  q.setOperator('Ana', true);
  q.encerrar(q.list()[0]!.id, 'Ana', 'ok');
  q.podar(3600_000);
  assert.equal(q.list().length, 1);
  agora = new Date('2026-10-28T14:00:00Z');
  q.podar(3600_000);
  assert.equal(q.list().length, 0);
});

test('troca de turno passa os chamados em atendimento direto para quem entra', () => {
  const q = new IncidentQueue();
  q.setOperator('Ana', true);
  q.handleEvent(ev('0013', '1130 01 003'));
  q.handleEvent(ev('0014', '1130 01 004'));
  q.registrarAcao(q.list()[0]!.id, 'Ana', 'Ligação para Maria: não atendeu');
  const passadas = q.passarTurno('Ana', 'Beto');
  assert.equal(passadas.length, 2);
  for (const o of q.list()) {
    assert.equal(o.situacao, 'em_atendimento');
    assert.equal(o.operador, 'Beto');
    assert.match(o.acoes.at(-1)!.descricao, /Troca de turno: passada de Ana para Beto/);
  }
  // O histórico de quem saiu continua lá.
  assert.ok(q.list()[0]!.acoes.some((a) => a.operador === 'Ana'));
  assert.equal(q.estaDisponivel('Ana'), false);
  assert.equal(q.estaDisponivel('Beto'), true);
  // Chamado novo vai para quem entrou.
  q.handleEvent(ev('0015', '1130 01 005'));
  assert.equal(q.list().find((o) => o.conta === '0015')!.operador, 'Beto');
});
