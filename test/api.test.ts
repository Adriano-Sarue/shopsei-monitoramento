import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApi, listen } from '../src/api/server.js';
import { IncidentQueue } from '../src/incidents/queue.js';
import { parseContactId } from '../src/protocols/contactId.js';
import { MemoryRepo } from '../src/store/memoryRepo.js';
import { ClienteIndex } from '../src/store/repositorio.js';
import type { AlarmEvent } from '../src/protocols/types.js';

function ev(account: string, cid: string): AlarmEvent {
  return {
    receivedAt: new Date(0).toISOString(), transport: 'tcp', remote: 't', protocol: 'ADM-CID', account, line: '0',
    sequence: '0001', encrypted: false, raw: '', ...parseContactId(cid),
  };
}

test('API exige token, lista ocorrências e conclui como operador', async () => {
  const queue = new IncidentQueue();
  const server = createApi(queue, { token: 'segredo', publicDir: 'public', port: 0 });
  const port = await listen(server, 0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const h = { authorization: 'Bearer segredo', 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(`${base}/api/ocorrencias`)).status, 401);
    assert.equal((await fetch(`${base}/api/ocorrencias`, { headers: { authorization: 'Bearer errado' } })).status, 401);

    const html = await fetch(base);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /Shop Sei Monitoramento/);

    queue.handleEvent(ev('0013', '1301 00 000'));
    await fetch(`${base}/api/operadores`, { method: 'POST', headers: h, body: JSON.stringify({ nome: 'Shop Sei', disponivel: true }) });
    const lista = (await (await fetch(`${base}/api/ocorrencias`, { headers: h })).json()) as { id: number; situacao: string; operador: string }[];
    assert.equal(lista.length, 1);
    assert.equal(lista[0]!.situacao, 'em_atendimento');

    const outro = await fetch(`${base}/api/ocorrencias/${lista[0]!.id}/concluir`, { method: 'POST', headers: h, body: JSON.stringify({ operador: 'Outro', motivo: 'x' }) });
    assert.equal(outro.status, 400);
    const ok = await fetch(`${base}/api/ocorrencias/${lista[0]!.id}/concluir`, { method: 'POST', headers: h, body: JSON.stringify({ operador: 'Shop Sei', motivo: 'Falha de energia do cliente', conclusao: 'Voltou' }) });
    assert.equal(ok.status, 200);
    assert.deepEqual(await (await fetch(`${base}/api/ocorrencias`, { headers: h })).json(), []);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('API de clientes: cria, bloqueia conta repetida e mostra o cliente na ocorrência', async () => {
  const repo = new MemoryRepo();
  const clientes = new ClienteIndex(repo);
  const queue = new IncidentQueue({ contaCadastrada: (c) => clientes.porConta(c) !== undefined });
  const server = createApi(queue, { token: 'segredo', publicDir: 'public', port: 0, repo, clientes });
  const port = await listen(server, 0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const h = { authorization: 'Bearer segredo', 'content-type': 'application/json' };
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: h, body: JSON.stringify(body) });
  try {
    const criado = await post('/api/clientes', {
      nome: 'Zona Rural', endereco: 'Estrada 1', tipo: 'COMERCIAL', palavraChave: 'abc', contraSenha: 'xyz',
      contas: ['0013'], contatos: [{ nome: 'Maria', telefone: '1499' }],
    });
    assert.equal(criado.status, 201);
    assert.equal((await post('/api/clientes', { nome: 'Outro', contas: ['0013'] })).status, 409);
    assert.equal((await post('/api/clientes', { nome: '', contas: ['1'] })).status, 400);
    assert.equal((await (await fetch(`${base}/api/clientes`, { headers: h })).json() as unknown[]).length, 1);

    queue.handleEvent(ev('0013', '1301 00 000'));
    const antes = (await (await fetch(`${base}/api/ocorrencias`, { headers: h })).json()) as { cliente: { nome: string; palavraChave: string | null }; contaCadastrada: boolean }[];
    assert.equal(antes[0]!.cliente.nome, 'Zona Rural');
    assert.equal(antes[0]!.contaCadastrada, true);
    // Sem operador atendendo, a palavra-chave não aparece.
    assert.equal(antes[0]!.cliente.palavraChave, null);

    await post('/api/operadores', { nome: 'Ana', disponivel: true });
    const depois = (await (await fetch(`${base}/api/ocorrencias`, { headers: h })).json()) as { cliente: { palavraChave: string; contraSenha: string } }[];
    assert.equal(depois[0]!.cliente.palavraChave, 'abc');
    assert.equal(depois[0]!.cliente.contraSenha, 'xyz');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
