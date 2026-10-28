import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IncidentQueue, type Ocorrencia } from '../src/incidents/queue.js';
import { parseContactId } from '../src/protocols/contactId.js';
import type { AlarmEvent } from '../src/protocols/types.js';
import { MemoryRepo } from '../src/store/memoryRepo.js';
import { PgRepo } from '../src/store/pgRepo.js';
import { ClienteIndex, ContaDuplicadaError, LoginDuplicadoError, NaoEncontradoError, RotaDuplicadaError, type Repositorio } from '../src/store/repositorio.js';

function ev(account: string, cid: string): AlarmEvent {
  return {
    receivedAt: new Date(0).toISOString(), transport: 'tcp', remote: 't', protocol: 'ADM-CID', account, line: '0',
    sequence: '0001', encrypted: false, raw: '', ...parseContactId(cid),
  };
}

// Os mesmos testes valem para a implementação em memória e para o PostgreSQL (se PG_TEST_URL existir).
async function contrato(repo: Repositorio): Promise<void> {
  await repo.init();
  await repo.init(); // idempotente

  // Empresas e rotas: a mesma rota não pode ser de duas empresas.
  const emp = await repo.criarEmpresa({ nome: ' Shop Sei ', rotas: [{ canal: 'surgard', receptora: '*', linha: '*' }] });
  assert.deepEqual([emp.nome, emp.ativo], ['Shop Sei', true]);
  const outra = await repo.criarEmpresa({ nome: 'Vigia Sul', rotas: [{ canal: 'surgard', receptora: '02', linha: '*' }, { canal: 'dc09', receptora: '*', linha: '3' }] });
  await assert.rejects(repo.criarEmpresa({ nome: 'Copia', rotas: [{ canal: 'surgard', receptora: '2', linha: '*' }] }), RotaDuplicadaError);
  await assert.rejects(repo.criarEmpresa({ nome: '', rotas: [] }), /Nome/);
  await assert.rejects(repo.criarEmpresa({ nome: 'X', rotas: [{ canal: 'fax' as never, receptora: '*', linha: '*' }] }), /Canal/);
  await assert.rejects(repo.atualizarEmpresa(999, { ativo: false }), NaoEncontradoError);
  const susp = await repo.atualizarEmpresa(outra.id, { ativo: false });
  assert.equal(susp.ativo, false);
  assert.equal(susp.rotas.length, 2);
  await repo.atualizarEmpresa(outra.id, { ativo: true });
  assert.equal((await repo.listarEmpresas()).length, 2);

  const u = await repo.criarUsuario({ empresaId: emp.id, login: ' Maria ', nome: 'Maria', papel: 'operador', senhaHash: 'h1' });
  assert.equal(u.login, 'maria');
  await assert.rejects(repo.criarUsuario({ empresaId: emp.id, login: 'maria', nome: 'Outra', papel: 'admin', senhaHash: 'h' }), LoginDuplicadoError);
  await assert.rejects(repo.criarUsuario({ empresaId: emp.id, login: 'x', nome: 'X', papel: 'admin', senhaHash: 'h' }), /Login/);
  assert.equal((await repo.buscarUsuario('MARIA'))?.senhaHash, 'h1');
  await assert.rejects(repo.atualizarUsuario(outra.id, u.id, { ativo: false }), NaoEncontradoError);
  await assert.rejects(repo.criarUsuario({ empresaId: 999, login: 'zeca', nome: 'Zeca', papel: 'admin', senhaHash: 'h' }), NaoEncontradoError);
  const dono = await repo.criarUsuario({ empresaId: null, login: 'plataforma', nome: 'Dono', papel: 'admin', senhaHash: 'h' });
  assert.equal(dono.empresaId, null);
  assert.equal((await repo.buscarUsuario('plataforma'))?.empresaId, null);
  assert.equal((await repo.listarUsuarios(null)).length, 1);
  const mud = await repo.atualizarUsuario(emp.id, u.id, { papel: 'admin', ativo: false, senhaHash: 'h2' });
  assert.deepEqual([mud.papel, mud.ativo, mud.senhaHash, mud.login], ['admin', false, 'h2', 'maria']);
  assert.equal((await repo.listarUsuarios(emp.id)).length, 1);
  assert.equal((await repo.listarUsuarios(outra.id)).length, 0);

  const criado = await repo.criarCliente(emp.id, {
    nome: 'Farmaformula', endereco: 'Rua A, 10', tipo: 'COMERCIAL', palavraChave: 'abc', contraSenha: 'xyz',
    contas: ['0016', ' 0017 '], contatos: [{ nome: 'Maria', telefone: '1499999', ordem: 1 }, { nome: '', ordem: 2 }],
  });
  assert.deepEqual(criado.contas.sort(), ['0016', '0017']);
  assert.equal(criado.contatos.length, 1);
  assert.equal(criado.palavraChave, 'abc');

  await assert.rejects(repo.criarCliente(emp.id, { nome: 'Outro', contas: ['0016'], contatos: [] }), ContaDuplicadaError);
  await assert.rejects(repo.criarCliente(emp.id, { nome: '', contas: ['1'], contatos: [] }), /Nome/);
  await assert.rejects(repo.criarCliente(emp.id, { nome: 'X', contas: [], contatos: [] }), /conta/);
  await assert.rejects(repo.criarCliente(emp.id, { nome: 'X', contas: ['zz!'], contatos: [] }), /inválida/);

  await assert.rejects(repo.criarCliente(emp.id, { nome: 'Cam', contas: ['0020'], contatos: [], cameras: [{ nome: 'A', url: 'rtsp://x', ordem: 1 }] }), /http/);
  const cam = await repo.criarCliente(emp.id, { nome: 'Cam', contas: ['0020'], contatos: [], cameras: [{ nome: 'Entrada', marca: 'Hikvision', url: 'https://c.exemplo/1', ordem: 1 }] });
  assert.deepEqual(cam.cameras, [{ nome: 'Entrada', marca: 'Hikvision', url: 'https://c.exemplo/1', ordem: 1 }]);
  assert.deepEqual((await repo.atualizarCliente(emp.id, cam.id, { nome: 'Cam', contas: ['0020'], contatos: [] })).cameras, []);

  await assert.rejects(repo.criarCliente(emp.id, { nome: 'T', contas: ['0030'], contatos: [], intervaloTesteHoras: 0 }), /Intervalo/);
  const sup = await repo.criarCliente(emp.id, { nome: 'T', contas: ['0030'], contatos: [], intervaloTesteHoras: 24, instrucoes: '  Ligar para o vigia  ' });
  assert.equal(sup.intervaloTesteHoras, 24);
  assert.equal(sup.instrucoes, 'Ligar para o vigia');
  const semSup = await repo.atualizarCliente(emp.id, sup.id, { nome: 'T', contas: ['0030'], contatos: [] });
  assert.equal(semSup.intervaloTesteHoras, undefined);
  assert.equal(semSup.instrucoes, undefined);

  const atual = await repo.atualizarCliente(emp.id, criado.id, { nome: 'Farmaformula Centro', contas: ['0016'], contatos: [{ nome: 'João', telefone: '1488888', ordem: 1 }] });
  assert.equal(atual.nome, 'Farmaformula Centro');
  assert.deepEqual(atual.contas, ['0016']);
  assert.equal(atual.contatos[0]!.nome, 'João');
  // a conta 0017 ficou livre
  const outro = await repo.criarCliente(emp.id, { nome: 'Outro', contas: ['0017'], contatos: [] });
  assert.deepEqual(outro.contas, ['0017']);

  const idx = new ClienteIndex(repo, emp.id);
  await idx.refresh();
  assert.equal(idx.porConta('0016')?.nome, 'Farmaformula Centro');
  assert.equal(idx.porConta('9999'), undefined);

  // Outra empresa pode ter a mesma conta; cada uma só vê e altera os seus clientes.
  const deles = await repo.criarCliente(outra.id, { nome: 'Padaria da Vigia', contas: ['0016'], contatos: [] });
  assert.equal((await repo.listarClientes(outra.id)).length, 1);
  assert.equal((await repo.listarClientes(emp.id)).length, 4);
  await assert.rejects(repo.atualizarCliente(emp.id, deles.id, { nome: 'Roubado', contas: ['0016'], contatos: [] }), NaoEncontradoError);
  const idxOutra = new ClienteIndex(repo, outra.id);
  await idxOutra.refresh();
  assert.equal(idxOutra.porConta('0016')?.nome, 'Padaria da Vigia');
  assert.equal(idxOutra.porConta('0017'), undefined);

  // Ocorrências: gravar a cada mudança e recarregar as abertas.
  const gravadas: Ocorrencia[] = [];
  const q = new IncidentQueue({ empresaId: emp.id, onChange: (o) => gravadas.push(o) });
  q.setOperator('Ana', true);
  const a = q.handleEvent(ev('0016', '1301 00 000'))!;
  q.handleEvent(ev('0017', '1130 01 003'));
  q.encerrar(a.id, 'Ana', 'Falha de energia', 'Voltou sozinha');
  for (const o of q.list()) await repo.salvarOcorrencia(o);
  // Ocorrência de outra empresa: não aparece no histórico da primeira.
  const qOutra = new IncidentQueue({ empresaId: outra.id, proximoId: () => 1000 });
  qOutra.setOperator('Zé', true);
  const b = qOutra.handleEvent(ev('0016', '1130 01 003'))!;
  await repo.salvarOcorrencia(qOutra.encerrar(b.id, 'Zé', 'Alarme falso'));
  assert.deepEqual((await repo.listarEncerradas(emp.id, { limite: 50 })).map((o) => o.id), [a.id]);
  assert.deepEqual((await repo.listarEncerradas(outra.id, { limite: 50 })).map((o) => o.id), [1000]);
  assert.equal((await repo.listarEncerradas(outra.id, { limite: 50 }))[0]!.empresaId, outra.id);

  const doEmp = (e: AlarmEvent): AlarmEvent => ({ ...e, empresaId: emp.id });
  await repo.salvarEvento(doEmp(ev('0016', '1301 00 000')));
  await repo.salvarEvento(doEmp({ ...ev('0016', '1301 00 000'), receivedAt: '2026-10-28T10:00:00.000Z' }));
  await repo.salvarEvento(doEmp({ ...ev('0016', '1301 00 000'), protocol: 'INTERNO', receivedAt: '2026-10-28T11:00:00.000Z' }));
  await repo.salvarEvento({ ...ev('0016', '1301 00 000'), empresaId: outra.id, receivedAt: '2026-10-28T12:00:00.000Z' });
  // Evento sem rota é guardado, mas não conta para ninguém.
  await repo.salvarEvento({ ...ev('0016', '1301 00 000'), receivedAt: '2026-10-28T13:00:00.000Z' });
  const ultimos = await repo.ultimosEventos();
  const ult = (eid: number) => ultimos.find((x) => x.empresaId === eid && x.conta === '0016')?.em.toISOString();
  assert.equal(ult(emp.id), '2026-10-28T10:00:00.000Z');
  assert.equal(ult(outra.id), '2026-10-28T12:00:00.000Z');
  assert.equal(ultimos.length, 2);

  const abertas = await repo.carregarOcorrenciasAbertas();
  assert.equal(abertas.length, 1);
  assert.equal(abertas[0]!.conta, '0017');
  assert.equal(abertas[0]!.empresaId, emp.id);
  assert.equal(abertas[0]!.abertaEm instanceof Date, true);
  assert.equal(abertas[0]!.eventos[0]!.code, '130');

  // Reinício: a ocorrência volta para a fila e o próximo id não repete.
  const q2 = new IncidentQueue({ empresaId: emp.id });
  q2.restore(abertas);
  assert.equal(q2.list()[0]!.situacao, 'aguardando');
  const nova = q2.handleEvent(ev('0099', '1301 00 000'))!;
  assert.ok(nova.id > a.id);
  assert.ok(gravadas.length >= 4);
}

test('repositório em memória cumpre o contrato', async () => {
  await contrato(new MemoryRepo());
});

test('repositório PostgreSQL cumpre o contrato', { skip: !process.env.PG_TEST_URL && 'defina PG_TEST_URL para testar o PostgreSQL' }, async () => {
  const repo = new PgRepo(process.env.PG_TEST_URL!);
  await repo.init();
  // Limpa as tabelas para o teste ser repetível.
  const pool = (repo as unknown as { pool: { query: (q: string) => Promise<unknown> } }).pool;
  await pool.query('TRUNCATE ocorrencias, eventos, contatos, cameras, contas, clientes, usuarios, rotas, empresas RESTART IDENTITY CASCADE');
  try {
    await contrato(repo);
  } finally {
    await repo.fechar();
  }
});
