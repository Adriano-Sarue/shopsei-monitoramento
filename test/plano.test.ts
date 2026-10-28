import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventoInterno, planoPara } from '../src/incidents/planos.js';
import { IncidentQueue } from '../src/incidents/queue.js';
import { SupervisaoTeste } from '../src/incidents/supervisao.js';
import { parseContactId } from '../src/protocols/contactId.js';
import type { AlarmEvent } from '../src/protocols/types.js';

function ev(account: string, cid: string): AlarmEvent {
  return {
    receivedAt: new Date(0).toISOString(), transport: 'tcp', remote: 't', protocol: 'ADM-CID', account, line: '0',
    sequence: '0001', encrypted: false, raw: '', ...parseContactId(cid),
  };
}

test('plano de ação segue o evento mais urgente e avisa conta não cadastrada', () => {
  const q = new IncidentQueue();
  const o = q.handleEvent(ev('0013', '1301 00 000'))!;
  assert.match(planoPara(o, true)[0]!, /restauração/);
  q.handleEvent(ev('0013', '1130 01 003'));
  assert.match(planoPara(o, true).join('|'), /palavra-chave/);
  q.handleEvent(ev('0013', '1121 01 001'));
  assert.match(planoPara(o, true)[0]!, /Coação/);
  assert.match(planoPara(o, false)[0]!, /não cadastrada/);
  const p = q.handleEvent(ev('0020', '1120 01 001'))!;
  assert.match(planoPara(p, true)[0]!, /Polícia/);
  const f = q.handleEvent(ev('0021', '1110 01 001'))!;
  assert.match(planoPara(f, true).join('|'), /Bombeiros/);
  const t = q.handleEvent(eventoInterno('0022', 'TST', 'Falta de teste', new Date()))!;
  assert.match(planoPara(t, true)[0]!, /outras contas/);
});

test('falha de energia espera em pendente; disparo na mesma conta traz de volta na hora', () => {
  let agora = new Date('2026-10-28T12:00:00Z');
  const q = new IncidentQueue({ now: () => agora, esperaMin: (e) => (e.code === '301' && e.qualifier !== 'restore' ? 30 : 0) });
  q.setOperator('Ana', true);
  const o = q.handleEvent(ev('0013', '1301 00 000'))!;
  assert.equal(o.situacao, 'pendente');
  assert.equal(o.adiadaAte?.toISOString(), '2026-10-28T12:30:00.000Z');
  // A restauração só anota: quem conclui é o operador.
  q.handleEvent(ev('0013', '3301 00 000'));
  assert.equal(o.situacao, 'pendente');
  assert.match(o.acoes.at(-1)!.descricao, /Restauração/);
  agora = new Date('2026-10-28T12:31:00Z');
  q.reativarVencidas();
  assert.equal(o.situacao, 'em_atendimento');

  const b = q.handleEvent(ev('0014', '1301 00 000'))!;
  assert.equal(b.situacao, 'pendente');
  q.handleEvent(ev('0014', '1130 01 003'));
  assert.equal(b.situacao, 'em_atendimento');
  assert.equal(b.prioridade, 2);
  assert.ok(b.acoes.some((a) => /voltou para a fila/.test(a.descricao)));
});

test('ocorrência adiada pelo operador volta à fila se chegar um disparo', () => {
  const q = new IncidentQueue();
  q.setOperator('Ana', true);
  const o = q.handleEvent(ev('0013', '1301 00 000'))!;
  q.adiar(o.id, 'Ana', new Date(Date.now() + 3600_000));
  assert.equal(o.situacao, 'pendente');
  q.handleEvent(ev('0013', '1130 01 003'));
  assert.equal(o.situacao, 'em_atendimento');
});

test('falta de teste periódico: avisa uma vez por atraso e volta a vigiar quando a central fala', () => {
  let agora = new Date('2026-10-28T00:00:00Z');
  const intervalos: Record<string, number> = { '0013': 24, '0014': 1 };
  const s = new SupervisaoTeste((c) => intervalos[c], () => agora);
  s.carregar(new Map([['0013', new Date('2026-10-27T06:00:00Z')]]));
  const contas = ['0013', '0014', '0099'];
  // 0013 tem histórico de 18 h atrás; 0014 nunca falou e conta a partir da subida.
  assert.deepEqual(s.atrasadas(contas), []);
  agora = new Date('2026-10-28T01:00:00Z');
  assert.deepEqual(s.atrasadas(contas).map((x) => x.conta), ['0014']);
  assert.deepEqual(s.atrasadas(contas), []);
  agora = new Date('2026-10-28T06:00:01Z');
  assert.deepEqual(s.atrasadas(contas).map((x) => x.conta), ['0013']);
  s.registrar('0014', agora);
  agora = new Date('2026-10-28T07:00:02Z');
  assert.deepEqual(s.atrasadas(contas).map((x) => x.conta), ['0014']);
});
