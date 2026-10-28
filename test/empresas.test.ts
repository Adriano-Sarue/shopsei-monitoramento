import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApi, listen } from '../src/api/server.js';
import { hashSenha } from '../src/auth/senha.js';
import { Central, Roteador } from '../src/central.js';
import { parseContactId } from '../src/protocols/contactId.js';
import type { AlarmEvent } from '../src/protocols/types.js';
import { MemoryRepo } from '../src/store/memoryRepo.js';

function ev(account: string, cid: string, receiver = '1', line = '1'): AlarmEvent {
  return {
    receivedAt: new Date().toISOString(), transport: 'tcp', remote: 't', protocol: 'SURGARD', account, receiver, line,
    sequence: '0001', encrypted: false, raw: '', ...parseContactId(cid),
  };
}

test('roteador: a rota mais específica ganha e canal diferente não casa', () => {
  const r = new Roteador([
    { id: 1, nome: 'A', ativo: true, rotas: [{ canal: 'surgard', receptora: '*', linha: '*' }] },
    { id: 2, nome: 'B', ativo: true, rotas: [{ canal: 'surgard', receptora: '2', linha: '*' }] },
    { id: 3, nome: 'C', ativo: true, rotas: [{ canal: 'surgard', receptora: '2', linha: '3' }, { canal: 'surgard', receptora: '*', linha: '9' }] },
  ]);
  assert.equal(r.empresaDe('surgard', '1', '1'), 1);
  assert.equal(r.empresaDe('surgard', '02', '1'), 2);
  assert.equal(r.empresaDe('surgard', '2', '03'), 3);
  // Receptora exata vale mais que linha exata.
  assert.equal(r.empresaDe('surgard', '2', '9'), 2);
  assert.equal(r.empresaDe('surgard', '5', '9'), 3);
  assert.equal(r.empresaDe('dc09', '1', '1'), undefined);
  assert.equal(new Roteador([]).empresaDe('surgard', '1', '1'), undefined);
});

// Duas empresas na mesma receptora (A na linha 1, B na linha 2), com a mesma conta 0013, e o dono do sistema.
async function montar() {
  const repo = new MemoryRepo();
  const a = await repo.criarEmpresa({ nome: 'Shop Sei', rotas: [{ canal: 'surgard', receptora: '1', linha: '1' }] });
  const b = await repo.criarEmpresa({ nome: 'Vigia Sul', rotas: [{ canal: 'surgard', receptora: '1', linha: '2' }] });
  const senha = await hashSenha('senha-forte-1');
  await repo.criarUsuario({ empresaId: a.id, login: 'admin-a', nome: 'Admin A', papel: 'admin', senhaHash: senha });
  await repo.criarUsuario({ empresaId: a.id, login: 'ana', nome: 'Ana', papel: 'operador', senhaHash: senha });
  await repo.criarUsuario({ empresaId: b.id, login: 'admin-b', nome: 'Admin B', papel: 'admin', senhaHash: senha });
  const beto = await repo.criarUsuario({ empresaId: b.id, login: 'beto', nome: 'Beto', papel: 'operador', senhaHash: senha });
  await repo.criarUsuario({ empresaId: null, login: 'dono', nome: 'Dono', papel: 'admin', senhaHash: senha });
  const central = new Central(repo);
  await central.iniciar();
  const server = createApi(central, { publicDir: 'public', port: 0, repo, ultimoEvento: (id) => (id === a.id ? new Date('2026-10-28T12:00:00Z') : undefined) });
  const base = `http://127.0.0.1:${await listen(server, 0, '127.0.0.1')}`;
  const json = { 'content-type': 'application/json' };
  const entrar = async (login: string, s = 'senha-forte-1') => {
    const r = await fetch(`${base}/api/login`, { method: 'POST', headers: json, body: JSON.stringify({ login, senha: s }) });
    return { status: r.status, h: { ...json, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0]! } };
  };
  const chamar = async (h: Record<string, string>, metodo: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, { method: metodo, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, corpo: r.headers.get('content-type')?.includes('json') ? await r.json() as never : await r.text() as never };
  };
  // Como a receptora entrega: roteia e só então põe na fila da empresa.
  const chegar = (e: AlarmEvent) => {
    const eid = central.rotear(e, 'surgard');
    if (eid !== undefined) central.fila(eid).handleEvent(e);
    return eid;
  };
  return { repo, a, b, beto, central, server, base, entrar, chamar, chegar };
}

test('empresas não enxergam a fila, os clientes, o histórico nem os usuários umas das outras', async () => {
  const { a, b, beto, server, entrar, chamar, chegar } = await montar();
  try {
    const admA = (await entrar('admin-a')).h;
    const admB = (await entrar('admin-b')).h;
    assert.equal((await chamar(admA, 'POST', '/api/clientes', { nome: 'Loja A', contas: ['0013'], palavraChave: 'senha-a' })).status, 201);
    const cliB = await chamar(admB, 'POST', '/api/clientes', { nome: 'Loja B', contas: ['0013'], palavraChave: 'senha-b' });
    assert.equal(cliB.status, 201);
    assert.deepEqual((await chamar(admA, 'GET', '/api/clientes')).corpo.map((c: { nome: string }) => c.nome), ['Loja A']);
    assert.deepEqual((await chamar(admB, 'GET', '/api/clientes')).corpo.map((c: { nome: string }) => c.nome), ['Loja B']);
    // Mexer no cliente da outra empresa pelo número dá "não existe", sem revelar nada.
    const id = (cliB.corpo as { id: number }).id;
    assert.equal((await chamar(admA, 'PUT', `/api/clientes/${id}`, { nome: 'Peguei', contas: ['0013'] })).status, 404);
    assert.equal((await chamar(admA, 'PUT', `/api/usuarios/${beto.id}`, { ativo: false })).status, 404);
    assert.deepEqual((await chamar(admA, 'GET', '/api/usuarios')).corpo.map((u: { login: string }) => u.login).sort(), ['admin-a', 'ana']);
    // O usuário criado pelo administrador fica na empresa dele.
    assert.equal((await chamar(admB, 'POST', '/api/usuarios', { login: 'carla', nome: 'Carla', papel: 'operador', senha: 'senha-forte-2' })).status, 201);
    assert.equal((await chamar(admA, 'GET', '/api/usuarios')).corpo.length, 2);
    assert.equal((await chamar(admB, 'GET', '/api/usuarios')).corpo.length, 3);

    // A mesma conta em linhas diferentes: cada disparo vai só para a fila da sua empresa.
    assert.equal(chegar(ev('0013', '1130 01 003', '1', '1')), a.id);
    assert.equal(chegar(ev('0013', '1120 01 004', '01', '02')), b.id);
    const ana = (await entrar('ana')).h;
    const bet = (await entrar('beto')).h;
    await chamar(ana, 'POST', '/api/operadores', { disponivel: true });
    await chamar(bet, 'POST', '/api/operadores', { disponivel: true });
    const filaA = (await chamar(ana, 'GET', '/api/ocorrencias')).corpo as { id: number; cliente: { nome: string; palavraChave: string }; resumo: string; operador: string }[];
    const filaB = (await chamar(bet, 'GET', '/api/ocorrencias')).corpo as typeof filaA;
    assert.equal(filaA.length, 1);
    assert.equal(filaB.length, 1);
    assert.deepEqual([filaA[0]!.cliente.nome, filaA[0]!.cliente.palavraChave, filaA[0]!.operador], ['Loja A', 'senha-a', 'Ana']);
    assert.deepEqual([filaB[0]!.cliente.nome, filaB[0]!.cliente.palavraChave, filaB[0]!.operador], ['Loja B', 'senha-b', 'Beto']);
    assert.notEqual(filaA[0]!.id, filaB[0]!.id);

    // Ana não anota, adia nem conclui a ocorrência da outra empresa.
    assert.equal((await chamar(ana, 'POST', `/api/ocorrencias/${filaB[0]!.id}/acoes`, { descricao: 'x' })).status, 400);
    assert.equal((await chamar(ana, 'POST', `/api/ocorrencias/${filaB[0]!.id}/concluir`, { motivo: 'x' })).status, 400);
    assert.equal((await chamar(bet, 'GET', '/api/ocorrencias')).corpo.length, 1);

    assert.equal((await chamar(ana, 'POST', `/api/ocorrencias/${filaA[0]!.id}/concluir`, { motivo: 'Alarme falso' })).status, 200);
    // O histórico do teste em memória vem do repositório; grava como a aplicação faria.
    assert.deepEqual((await chamar(bet, 'GET', '/api/historico')).corpo, []);
    // O estado do feed também é por empresa.
    assert.equal((await chamar(ana, 'GET', '/api/estado')).corpo.ultimoEventoEm, '2026-10-28T12:00:00.000Z');
    assert.equal((await chamar(bet, 'GET', '/api/estado')).corpo.ultimoEventoEm, null);
    // Quem é de empresa não abre a área do dono do sistema.
    assert.equal((await chamar(admA, 'GET', '/api/empresas')).status, 403);
    assert.equal((await chamar(admA, 'GET', '/api/sem-rota')).status, 403);
    assert.equal((await fetch(`${'http://127.0.0.1:' + (server.address() as { port: number }).port}/empresas.html`, { headers: admA, redirect: 'manual' })).headers.get('location'), '/');
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('dono do sistema: cria empresa com administrador, ajusta rotas, vê eventos sem dono e suspende', async () => {
  const { a, b, central, server, base, entrar, chamar, chegar } = await montar();
  try {
    const dono = (await entrar('dono')).h;
    const eu = (await chamar(dono, 'GET', '/api/eu')).corpo as { plataforma: boolean; empresa: unknown };
    assert.deepEqual([eu.plataforma, eu.empresa], [true, null]);
    // O dono do sistema não tem fila nem clientes; as páginas da operação levam à de empresas.
    assert.equal((await chamar(dono, 'GET', '/api/ocorrencias')).status, 403);
    assert.equal((await chamar(dono, 'GET', '/api/clientes')).status, 403);
    assert.equal((await fetch(base, { headers: dono, redirect: 'manual' })).headers.get('location'), '/empresas.html');
    assert.equal((await fetch(`${base}/empresas.html`, { headers: dono })).status, 200);

    const lista = (await chamar(dono, 'GET', '/api/empresas')).corpo as { id: number; nome: string; clientes: number; ultimoEventoEm: string | null }[];
    assert.deepEqual(lista.map((e) => [e.nome, e.ultimoEventoEm]), [['Shop Sei', '2026-10-28T12:00:00.000Z'], ['Vigia Sul', null]]);

    // Evento que nenhuma rota reconhece fica guardado para o dono ver.
    assert.equal(chegar(ev('0500', '1130 01 001', '7', '1')), undefined);
    const sem = (await chamar(dono, 'GET', '/api/sem-rota')).corpo as { receptora: string; conta: string }[];
    assert.deepEqual([sem[0]!.receptora, sem[0]!.conta], ['7', '0500']);

    const nova = { nome: 'Guarda Norte', rotas: [{ canal: 'surgard', receptora: '7', linha: '*' }], admin: { login: 'admin-c', nome: 'Admin C', senha: 'senha-forte-3' } };
    // Rota já usada, login já usado e senha curta são recusados sem deixar empresa pela metade.
    assert.equal((await chamar(dono, 'POST', '/api/empresas', { ...nova, rotas: [{ canal: 'surgard', receptora: '1', linha: '2' }] })).status, 409);
    assert.equal((await chamar(dono, 'POST', '/api/empresas', { ...nova, admin: { ...nova.admin, login: 'ana' } })).status, 409);
    assert.equal((await chamar(dono, 'POST', '/api/empresas', { ...nova, admin: { ...nova.admin, senha: 'curta' } })).status, 400);
    assert.equal((await chamar(dono, 'GET', '/api/empresas')).corpo.length, 2);
    const criada = await chamar(dono, 'POST', '/api/empresas', nova);
    assert.equal(criada.status, 201);
    const c = criada.corpo as { id: number };
    // A empresa nova recebe eventos na hora, sem reiniciar o servidor.
    assert.equal(chegar(ev('0500', '1130 01 001', '7', '1')), c.id);
    const admC = await entrar('admin-c', 'senha-forte-3');
    assert.equal(admC.status, 200);
    assert.equal((await chamar(admC.h, 'GET', '/api/ocorrencias')).corpo.length, 1);
    assert.equal((await chamar(dono, 'POST', `/api/empresas/${c.id}/usuarios`, { login: 'dani', nome: 'Dani', papel: 'operador', senha: 'senha-forte-4' })).status, 201);
    assert.equal((await chamar(dono, 'POST', '/api/empresas/999/usuarios', { login: 'zeca', nome: 'Zeca', senha: 'senha-forte-4' })).status, 404);
    assert.equal((await entrar('dani', 'senha-forte-4')).status, 200);

    // Trocar rotas vale para o próximo evento.
    assert.equal((await chamar(dono, 'PUT', `/api/empresas/${b.id}`, { rotas: [{ canal: 'surgard', receptora: '1', linha: '*' }] })).status, 200);
    assert.equal(chegar(ev('0013', '1130 01 001', '1', '5')), b.id);
    assert.equal(chegar(ev('0013', '1130 01 001', '1', '1')), a.id);
    assert.equal((await chamar(dono, 'PUT', `/api/empresas/${b.id}`, { rotas: [{ canal: 'surgard', receptora: '1', linha: '1' }] })).status, 409);
    assert.equal((await chamar(dono, 'PUT', '/api/empresas/999', { ativo: false })).status, 404);

    // Suspender derruba quem está dentro e impede novo login; reativar devolve o acesso.
    const beto = (await entrar('beto')).h;
    assert.equal((await chamar(beto, 'GET', '/api/eu')).status, 200);
    assert.equal((await chamar(dono, 'PUT', `/api/empresas/${b.id}`, { ativo: false })).status, 200);
    assert.equal((await chamar(beto, 'GET', '/api/eu')).status, 401);
    assert.equal((await entrar('beto')).status, 403);
    assert.equal(central.empresa(b.id)?.ativo, false);
    assert.equal((await entrar('ana')).status, 200);
    assert.equal((await chamar(dono, 'PUT', `/api/empresas/${b.id}`, { ativo: true })).status, 200);
    assert.equal((await entrar('beto')).status, 200);

    // O dono cria outros donos, que nascem administradores e sem empresa.
    const outro = await chamar(dono, 'POST', '/api/usuarios', { login: 'socio', nome: 'Sócio', papel: 'operador', senha: 'senha-forte-5' });
    assert.equal(outro.status, 201);
    assert.deepEqual([(outro.corpo as { papel: string }).papel, (outro.corpo as { empresaId: null }).empresaId], ['admin', null]);
    assert.deepEqual((await chamar(dono, 'GET', '/api/usuarios')).corpo.map((u: { login: string }) => u.login).sort(), ['dono', 'socio']);
    void a;
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('reinício: cada ocorrência aberta volta para a fila da sua empresa e o número não repete', async () => {
  const repo = new MemoryRepo();
  const a = await repo.criarEmpresa({ nome: 'A', rotas: [{ canal: 'surgard', receptora: '1', linha: '*' }] });
  const b = await repo.criarEmpresa({ nome: 'B', rotas: [{ canal: 'surgard', receptora: '2', linha: '*' }] });
  const c1 = new Central(repo, { onChange: (o) => void repo.salvarOcorrencia(o) });
  await c1.iniciar();
  for (const [conta, rec] of [['0001', '1'], ['0002', '2'], ['0003', '2']] as const) {
    const e = ev(conta, '1130 01 001', rec);
    c1.fila(c1.rotear(e, 'surgard')!).handleEvent(e);
  }
  const c2 = new Central(repo);
  await c2.iniciar();
  assert.deepEqual(c2.fila(a.id).list().map((o) => o.conta), ['0001']);
  assert.deepEqual(c2.fila(b.id).list().map((o) => o.conta).sort(), ['0002', '0003']);
  const maior = Math.max(...[a.id, b.id].flatMap((id) => c2.fila(id).list().map((o) => o.id)));
  const e = ev('0004', '1130 01 001', '1');
  assert.ok(c2.fila(c2.rotear(e, 'surgard')!).handleEvent(e)!.id > maior);
});
