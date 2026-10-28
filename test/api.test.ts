import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApi, listen } from '../src/api/server.js';
import { hashSenha } from '../src/auth/senha.js';
import { Central } from '../src/central.js';
import { parseContactId } from '../src/protocols/contactId.js';
import { MemoryRepo } from '../src/store/memoryRepo.js';
import type { AlarmEvent } from '../src/protocols/types.js';

function ev(account: string, cid: string): AlarmEvent {
  return {
    receivedAt: new Date(0).toISOString(), transport: 'tcp', remote: 't', protocol: 'ADM-CID', account, line: '0',
    sequence: '0001', encrypted: false, raw: '', ...parseContactId(cid),
  };
}

// Sobe a API com uma empresa (a Shop Sei) que recebe tudo, como na primeira instalação.
async function montar(opts: { repo?: MemoryRepo; token?: string; ultimoEvento?: () => Date | undefined } = {}) {
  const repo = opts.repo ?? new MemoryRepo();
  const emp = (await repo.listarEmpresas())[0] ?? await repo.criarEmpresa({ nome: 'Shop Sei', rotas: [{ canal: 'dc09', receptora: '*', linha: '*' }] });
  const central = new Central(repo);
  await central.iniciar();
  const server = createApi(central, { token: opts.token, publicDir: 'public', port: 0, repo, ultimoEvento: opts.ultimoEvento });
  const port = await listen(server, 0, '127.0.0.1');
  return { repo, emp, central, queue: central.fila(emp.id), server, base: `http://127.0.0.1:${port}` };
}

test('API exige token, lista ocorrências e conclui como operador', async () => {
  const { queue, server, base } = await montar({ token: 'segredo' });
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
  const { queue, server, base } = await montar({ token: 'segredo' });
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
  const { id: eid } = await repo.criarEmpresa({ nome: 'Shop Sei', rotas: [] });
  await repo.criarUsuario({ empresaId: eid, login: 'admin', nome: 'Administrador', papel: 'admin', senhaHash: await hashSenha('senha-admin') });
  const ana = await repo.criarUsuario({ empresaId: eid, login: 'ana', nome: 'Ana', papel: 'operador', senhaHash: await hashSenha('senha-ana-1') });
  const { queue, server, base } = await montar({ repo });
  const json = { 'content-type': 'application/json' };
  const login = (l: string, senha: string) => fetch(`${base}/api/login`, { method: 'POST', headers: json, body: JSON.stringify({ login: l, senha }) });
  const cookieDe = (r: Response) => (r.headers.get('set-cookie') ?? '').split(';')[0]!;
  try {
    // Sem sessão: páginas redirecionam para o login e a API recusa.
    const pagina = await fetch(base, { redirect: 'manual' });
    assert.equal(pagina.status, 302);
    assert.equal(pagina.headers.get('location'), '/login.html');
    assert.equal((await fetch(`${base}/login.html`)).status, 200);
    assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { ok: true });
    // Sem CONFIAR_PROXY o cookie não sai como Secure só porque alguém mandou o cabeçalho.
    assert.doesNotMatch((await fetch(`${base}/api/login`, { method: 'POST', headers: { ...json, 'x-forwarded-proto': 'https' }, body: JSON.stringify({ login: 'admin', senha: 'senha-admin' }) })).headers.get('set-cookie') ?? '', /Secure/);
    assert.equal((await fetch(`${base}/api/ocorrencias`)).status, 401);

    assert.equal((await login('ana', 'errada')).status, 401);
    assert.equal((await login('ninguem', 'qualquer-coisa')).status, 401);
    const ok = await login('ana', 'senha-ana-1');
    assert.equal(ok.status, 200);
    assert.match(ok.headers.get('set-cookie') ?? '', /HttpOnly/);
    assert.match(ok.headers.get('set-cookie') ?? '', /SameSite=Strict/);
    const c = { ...json, cookie: cookieDe(ok) };

    assert.deepEqual(await (await fetch(`${base}/api/eu`, { headers: c })).json(), {
      login: 'ana', nome: 'Ana', papel: 'operador', plataforma: false, empresa: { id: eid, nome: 'Shop Sei' }, disponivel: false,
    });
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

test('câmeras só aparecem a quem atende; estado do feed, histórico, CSV e troca de senha', async () => {
  const repo = new MemoryRepo();
  const { id: eid } = await repo.criarEmpresa({ nome: 'Shop Sei', rotas: [] });
  await repo.criarUsuario({ empresaId: eid, login: 'ana', nome: 'Ana', papel: 'operador', senhaHash: await hashSenha('senha-ana-1') });
  let ultimo: Date | undefined;
  const { queue, server, base } = await montar({ repo, token: 'segredo', ultimoEvento: () => ultimo });
  const h = { authorization: 'Bearer segredo', 'content-type': 'application/json' };
  try {
    const r = await fetch(`${base}/api/clientes`, { method: 'POST', headers: h, body: JSON.stringify({
      nome: 'Loja', contas: ['0013'], cameras: [{ nome: 'Entrada', marca: 'Intelbras', url: 'https://cam.exemplo/1' }],
    }) });
    assert.equal(r.status, 201);
    const ruim = await fetch(`${base}/api/clientes`, { method: 'POST', headers: h, body: JSON.stringify({ nome: 'X', contas: ['1'], cameras: [{ nome: 'C', url: 'rtsp://x' }] }) });
    assert.equal(ruim.status, 400);

    queue.handleEvent(ev('0013', '1130 01 003'));
    const antes = (await (await fetch(`${base}/api/ocorrencias`, { headers: h })).json()) as { cliente: { cameras: unknown[] } }[];
    assert.deepEqual(antes[0]!.cliente.cameras, []);
    queue.setOperator('Ana', true);
    const depois = (await (await fetch(`${base}/api/ocorrencias`, { headers: h })).json()) as { id: number; cliente: { cameras: { nome: string; url: string }[] } }[];
    assert.equal(depois[0]!.cliente.cameras[0]!.url, 'https://cam.exemplo/1');

    // Plano de ação e anotações: só quem atende anota; passo feito aparece marcado.
    const id = depois[0]!.id;
    const anota = (operador: string, descricao: string) => fetch(`${base}/api/ocorrencias/${id}/acoes`, { method: 'POST', headers: h, body: JSON.stringify({ operador, descricao }) });
    assert.equal((await anota('Beto', 'x')).status, 400);
    assert.equal((await anota('Ana', 'x'.repeat(501))).status, 400);
    const r1 = await (await anota('Ana', 'Passo concluído: Ligar para o local e pedir a palavra-chave')).json() as { plano: { passo: string; feito: boolean }[]; acoes: { descricao: string }[] };
    assert.equal(r1.plano.find((p) => p.passo === 'Ligar para o local e pedir a palavra-chave')!.feito, true);
    assert.equal(r1.plano.filter((p) => p.feito).length, 1);
    const r2 = await (await anota('Ana', 'Ligação para Maria: atendeu')).json() as { acoes: { descricao: string; operador: string }[] };
    assert.deepEqual(r2.acoes.at(-1), { em: r2.acoes.at(-1)!['em' as never], operador: 'Ana', descricao: 'Ligação para Maria: atendeu' });

    assert.equal(((await (await fetch(`${base}/api/estado`, { headers: h })).json()) as { ultimoEventoEm: string | null }).ultimoEventoEm, null);
    ultimo = new Date('2026-10-28T12:00:00Z');
    assert.equal(((await (await fetch(`${base}/api/estado`, { headers: h })).json()) as { ultimoEventoEm: string }).ultimoEventoEm, '2026-10-28T12:00:00.000Z');

    // Histórico e CSV (a ocorrência precisa estar gravada como encerrada).
    const o = queue.encerrar(depois[0]!.id, 'Ana', 'Alarme falso; teste', 'ok "aspas"');
    await repo.salvarOcorrencia(o);
    const hist = (await (await fetch(`${base}/api/historico?conta=0013&de=2020-01-01`, { headers: h })).json()) as { cliente: string }[];
    assert.equal(hist.length, 1);
    assert.equal(hist[0]!.cliente, 'Loja');
    assert.equal(((await (await fetch(`${base}/api/historico?conta=9999`, { headers: h })).json()) as unknown[]).length, 0);
    const csv = await fetch(`${base}/api/historico.csv`, { headers: h });
    assert.match(csv.headers.get('content-disposition') ?? '', /historico\.csv/);
    const texto = await csv.text();
    assert.ok(texto.includes('"Alarme falso; teste"'));
    assert.ok(texto.includes('"ok ""aspas"""'));

    // Troca de senha: pede a atual, exige 8 caracteres e vale no próximo login.
    const json = { 'content-type': 'application/json' };
    const entrar = (senha: string) => fetch(`${base}/api/login`, { method: 'POST', headers: json, body: JSON.stringify({ login: 'ana', senha }) });
    const login = await entrar('senha-ana-1');
    const c = { ...json, cookie: (login.headers.get('set-cookie') ?? '').split(';')[0]! };
    const troca = (atual: string, nova: string) => fetch(`${base}/api/senha`, { method: 'POST', headers: c, body: JSON.stringify({ atual, nova }) });
    assert.equal((await troca('errada', 'nova-senha-1')).status, 400);
    assert.equal((await troca('senha-ana-1', 'curta')).status, 400);
    assert.equal((await troca('senha-ana-1', 'nova-senha-1')).status, 200);
    assert.equal((await entrar('senha-ana-1')).status, 401);
    assert.equal((await entrar('nova-senha-1')).status, 200);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('disparo vem marcado como alarme; falha de energia não; logo e ícone são servidos', async () => {
  const { queue, server, base } = await montar({ token: 'segredo' });
  const h = { authorization: 'Bearer segredo' };
  try {
    queue.handleEvent(ev('0020', '1130 01 003'));
    queue.handleEvent(ev('0021', '1301 00 000'));
    queue.handleEvent(ev('0022', '1344 00 000'));
    const lista = (await (await fetch(`${base}/api/ocorrencias`, { headers: h })).json()) as { conta: string; alarme: boolean }[];
    assert.deepEqual(Object.fromEntries(lista.map((o) => [o.conta, o.alarme])), { '0020': true, '0021': false, '0022': true });

    for (const [caminho, tipo] of [['/logo-recortada.png', 'image/png'], ['/logo-icone.png', 'image/png'], ['/favicon.png', 'image/png'], ['/fontes/inter.woff2', 'font/woff2']]) {
      const r = await fetch(base + caminho);
      assert.equal(r.status, 200, caminho);
      assert.equal(r.headers.get('content-type'), tipo);
      const bytes = Buffer.from(await r.arrayBuffer());
      assert.ok(bytes.length > 1000, caminho);
      assert.equal(bytes[0], { 'image/png': 0x89, 'image/jpeg': 0xff, 'font/woff2': 0x77 }[tipo!], caminho);
    }
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
