import assert from 'node:assert/strict';
import { test } from 'node:test';
import { IncidentQueue, type Ocorrencia } from '../src/incidents/queue.js';
import { parseContactId } from '../src/protocols/contactId.js';
import type { AlarmEvent } from '../src/protocols/types.js';
import { MemoryRepo } from '../src/store/memoryRepo.js';
import { PgRepo } from '../src/store/pgRepo.js';
import { ClienteIndex, ContaDuplicadaError, type Repositorio } from '../src/store/repositorio.js';

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

  const criado = await repo.criarCliente({
    nome: 'Farmaformula', endereco: 'Rua A, 10', tipo: 'COMERCIAL', palavraChave: 'abc', contraSenha: 'xyz',
    contas: ['0016', ' 0017 '], contatos: [{ nome: 'Maria', telefone: '1499999', ordem: 1 }, { nome: '', ordem: 2 }],
  });
  assert.deepEqual(criado.contas.sort(), ['0016', '0017']);
  assert.equal(criado.contatos.length, 1);
  assert.equal(criado.palavraChave, 'abc');

  await assert.rejects(repo.criarCliente({ nome: 'Outro', contas: ['0016'], contatos: [] }), ContaDuplicadaError);
  await assert.rejects(repo.criarCliente({ nome: '', contas: ['1'], contatos: [] }), /Nome/);
  await assert.rejects(repo.criarCliente({ nome: 'X', contas: [], contatos: [] }), /conta/);
  await assert.rejects(repo.criarCliente({ nome: 'X', contas: ['zz!'], contatos: [] }), /inválida/);

  const atual = await repo.atualizarCliente(criado.id, { nome: 'Farmaformula Centro', contas: ['0016'], contatos: [{ nome: 'João', telefone: '1488888', ordem: 1 }] });
  assert.equal(atual.nome, 'Farmaformula Centro');
  assert.deepEqual(atual.contas, ['0016']);
  assert.equal(atual.contatos[0]!.nome, 'João');
  // a conta 0017 ficou livre
  const outro = await repo.criarCliente({ nome: 'Outro', contas: ['0017'], contatos: [] });
  assert.deepEqual(outro.contas, ['0017']);

  const idx = new ClienteIndex(repo);
  await idx.refresh();
  assert.equal(idx.porConta('0016')?.nome, 'Farmaformula Centro');
  assert.equal(idx.porConta('9999'), undefined);

  // Ocorrências: gravar a cada mudança e recarregar as abertas.
  const gravadas: Ocorrencia[] = [];
  const q = new IncidentQueue({ onChange: (o) => gravadas.push(o) });
  q.setOperator('Ana', true);
  const a = q.handleEvent(ev('0016', '1301 00 000'))!;
  q.handleEvent(ev('0017', '1130 01 003'));
  q.encerrar(a.id, 'Ana', 'Falha de energia', 'Voltou sozinha');
  for (const o of q.list()) await repo.salvarOcorrencia(o);
  await repo.salvarEvento(ev('0016', '1301 00 000'));

  const abertas = await repo.carregarOcorrenciasAbertas();
  assert.equal(abertas.length, 1);
  assert.equal(abertas[0]!.conta, '0017');
  assert.equal(abertas[0]!.abertaEm instanceof Date, true);
  assert.equal(abertas[0]!.eventos[0]!.code, '130');

  // Reinício: a ocorrência volta para a fila e o próximo id não repete.
  const q2 = new IncidentQueue();
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
  await pool.query('TRUNCATE ocorrencias, eventos, contatos, contas, clientes RESTART IDENTITY CASCADE');
  try {
    await contrato(repo);
  } finally {
    await repo.fechar();
  }
});
