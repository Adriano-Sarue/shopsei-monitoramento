import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApi, listen } from '../src/api/server.js';
import { hashSenha } from '../src/auth/senha.js';
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

test('login por usuário: sessão, perfis, bloqueio e revogação', async () => {
  const repo = new MemoryRepo();
  await repo.criarUsuario({ login: 'admin', nome: 'Administrador', papel: 'admin', senhaHash: await hashSenha('senha-admin') });
  const ana = await repo.criarUsuario({ login: 'ana', nome: 'Ana', papel: 'operador', senhaHash: await hashSenha('senha-ana-1') });
  const clientes = new ClienteIndex(repo);
  const queue = new IncidentQueue();
  const server = createApi(queue, { publicDir: 'public', port: 0, repo, clientes });
  const port = await listen(server, 0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const json = { 'content-type': 'application/json' };
  const login = (l: string, senha: string) => fetch(`${base}/api/login`, { method: 'POST', headers: json, body: JSON.stringify({ login: l, senha }) });
  const cookieDe = (r: Response) => (r.headers.get('set-cookie') ?? '').split(';')[0]!;
  try {
    // Sem sessão: páginas redirecionam para o login e a API recusa.
    const pagina = await fetch(base, { redirect: 'manual' });
    assert.equal(pagina.status, 302);
    assert.equal(pagina.headers.get('location'), '/login.html');
    assert.equal((await fetch(`${base}/login.html`)).status, 200);
    assert.equal((await fetch(`${base}/api/ocorrencias`)).status, 401);

    assert.equal((await login('ana', 'errada')).status, 401);
    assert.equal((await login('ninguem', 'qualquer-coisa')).status, 401);
    const ok = await login('ana', 'senha-ana-1');
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('set-cookie') ?? '', /HttpOnly/);
    assert.match(ok.headers.get('set-cookie') ?? '', /SameSite=Strict/);
    const c = { ...json, cookie: cookieDe(ok) };

    assert.deepEqual(await (await fetch(`${base}/api/eu`, { headers: c })).json(), { login: 'ana', nome: 'Ana', papel: 'operador', disponivel: false });
    // Operador não vê cadastro nem usuários, e não abre essas páginas.
    assert.equal((await fetch(`${base}/api/clientes`, { headers: c })).status, 403);
    assert.equal((await fetch(`${base}/api/usuarios`, { headers: c })).status, 403);
    assert.equal((await fetch(`${base}/usuarios.html`, { headers: c, redirect: 'manual' })).status, 302);
    // JSON obrigatório nas escritas.
    assert.equal((await fetch(`${base}/api/operadores`, { method: 'POST', headers: { cookie: c.cookie } })).status, 415);

    // O operador é quem está na sessão, não quem o corpo diz.
    queue.handleEvent(ev('0013', '1301 00 000'));
    await fetch(`${base}/api/operadores`, { method: 'POST', headers: c, body: JSON.stringify({ disponivel: true }) });
    assert.equal(((await (await fetch(`${base}/api/eu`, { headers: c })).json()) as { disponivel: boolean }).disponivel, true);
    const [oc] = (await (await fetch(`${base}/api/ocorrencias`, { headers: c })).json()) as { id: number; operador: string }[];
    assert.equal(oc!.operador, 'Ana');
    const fim = await fetch(`${base}/api/ocorrencias/${oc!.id}/concluir`, { method: 'POST', headers: c, body: JSON.stringify({ operador: 'Outro', motivo: 'Alarme falso' }) });
    assert.equal(fim.status, 200);

    // Administrador cria usuário; senha curta e login repetido são recusados.
    const adm = await login('admin', 'senha-admin');
    const a = { ...json, cookie: cookieDe(adm) };
    const novo = (body: unknown) => fetch(`${base}/api/usuarios`, { method: 'POST', headers: a, body: JSON.stringify(body) });
    assert.equal((await novo({ login: 'beto', nome: 'Beto', papel: 'operador', senha: 'curta' })).status, 400);
    assert.equal((await novo({ login: 'beto', nome: 'Beto', papel: 'operador', senha: 'senha-do-beto' })).status, 201);
    assert.equal((await novo({ login: 'BETO', nome: 'Outro', papel: 'operador', senha: 'senha-do-beto' })).status, 409);
    const lista = await (await fetch(`${base}/api/usuarios`, { headers: a })).json() as Record<string, unknown>[];
    assert.equal(lista.length, 3);
    assert.ok(lista.every((u) => !('senhaHash' in u)));
    assert.equal((await fetch(`${base}/api/usuarios/1`, { method: 'PUT', headers: a, body: JSON.stringify({ ativo: false }) })).status, 400);

    // Desativar derruba a sessão em andamento e impede novo login.
    assert.equal((await fetch(`${base}/api/usuarios/${ana.id}`, { method: 'PUT', headers: a, body: JSON.stringify({ ativo: false }) })).status, 200);
    assert.equal((await fetch(`${base}/api/eu`, { headers: c })).status, 401);
    assert.equal((await login('ana', 'senha-ana-1')).status, 401);

    // Depois de 5 falhas seguidas o login é bloqueado, mesmo com a senha certa.
    for (let i = 0; i < 5; i++) await login('beto', 'errada');
    assert.equal((await login('beto', 'senha-do-beto')).status, 429);

    const sai = await fetch(`${base}/api/logout`, { method: 'POST', headers: a, body: '{}' });
    assert.equal(sai.status, 200);
    assert.equal((await fetch(`${base}/api/eu`, { headers: a })).status, 401);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
