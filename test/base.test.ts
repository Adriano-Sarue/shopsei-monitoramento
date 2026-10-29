import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VigiaBase } from '../src/incidents/base.js';
import { CODIGO_BASE, CONTA_BASE, eventoInterno, planoPara } from '../src/incidents/planos.js';
import { IncidentQueue } from '../src/incidents/queue.js';

test('vigia da base avisa uma vez quando o sinal cai e uma vez quando volta', () => {
  let agora = new Date('2026-10-29T12:00:00Z');
  const passa = (s: number) => { agora = new Date(agora.getTime() + s * 1000); };
  const v = new VigiaBase(120, () => agora);
  // Logo depois de iniciar, a ponte ainda tem tempo para conectar.
  assert.equal(v.verificar({ conexoes: 0 }), undefined);
  passa(60);
  let sinal = new Date(agora);
  assert.equal(v.verificar({ conexoes: 1, ultimoSinal: sinal }), undefined);
  // Batimento a cada 30 s: tudo bem.
  for (let i = 0; i < 6; i++) { passa(30); sinal = new Date(agora); assert.equal(v.verificar({ conexoes: 1, ultimoSinal: sinal }), undefined); }
  // A internet da base cai: a conexão continua "aberta" no servidor, mas nada chega.
  passa(100); assert.equal(v.verificar({ conexoes: 1, ultimoSinal: sinal }), undefined);
  passa(30); assert.equal(v.verificar({ conexoes: 1, ultimoSinal: sinal }), 'caiu');
  assert.equal(v.semSinal, true);
  passa(30); assert.equal(v.verificar({ conexoes: 0, ultimoSinal: sinal }), undefined);
  // A ponte reconecta e manda o batimento.
  passa(10); sinal = new Date(agora);
  assert.equal(v.verificar({ conexoes: 1, ultimoSinal: sinal }), 'voltou');
  assert.equal(v.semSinal, false);
  // Ponte fechada de vez (sem conexão nenhuma) também conta.
  passa(121); assert.equal(v.verificar({ conexoes: 0, ultimoSinal: sinal }), 'caiu');
});

test('ponte que nunca conectou depois de iniciar também gera aviso', () => {
  let agora = new Date('2026-10-29T12:00:00Z');
  const v = new VigiaBase(120, () => agora);
  agora = new Date(agora.getTime() + 121_000);
  assert.equal(v.verificar({ conexoes: 0 }), 'caiu');
});

test('aviso de base sem sinal é urgente, tem plano próprio e a volta só anota', () => {
  const q = new IncidentQueue();
  const o = q.handleEvent(eventoInterno(CONTA_BASE, CODIGO_BASE, 'Base sem sinal', new Date(), { priority: 2 }))!;
  assert.equal(o.prioridade, 2);
  assert.match(planoPara(o, false).join(' '), /internet da base/);
  q.handleEvent(eventoInterno(CONTA_BASE, CODIGO_BASE, 'Sinal da base voltou', new Date(), { qualifier: 'restore', priority: 5 }));
  assert.equal(q.list().length, 1);
  assert.notEqual(q.list()[0]!.situacao, 'encerrada');
  assert.match(q.list()[0]!.acoes.at(-1)!.descricao, /Sinal da base voltou/);
});
