import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { autorizacaoDigest } from '../src/portaria/digest.js';
import { ErroEquipamento, Hikvision, lerEventoEquipamento } from '../src/portaria/hikvision.js';
import { eventoRosto, FOTO_TESTE, LeitorSimulado } from '../src/simulator/leitorHik.js';

test('digest: resposta igual ao exemplo da RFC 2617', () => {
  const desafio = 'Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"';
  const h = autorizacaoDigest(desafio, 'GET', '/dir/index.html', 'Mufasa', 'Circle Of Life', '0a4f113b', '00000001');
  assert.match(h, /response="6629fae49393a05397450978507c4ef1"/);
  assert.match(h, /qop=auth, nc=00000001, cnonce="0a4f113b"/);
  assert.match(h, /opaque="5ccc069c403ebaf9f0171e9517f40e41"/);
});

test('cliente ISAPI: informações, abrir porta, chamada, foto e envio de eventos', async () => {
  const leitor = new LeitorSimulado();
  const endereco = await leitor.iniciar();
  try {
    const hik = new Hikvision({ endereco, usuario: 'admin', senha: 'senha-do-leitor' });
    assert.deepEqual(await hik.info(), { nome: 'Portaria', modelo: 'DS-K1T342MWX', serie: 'DS-K1T342MWX20240314V031601ENL42196876', firmware: 'V3.16.1' });
    await hik.abrirPorta();
    assert.equal(leitor.aberturas.length, 1);
    await assert.rejects(hik.abrirPorta(2), /400 \(invalidID\)/);
    assert.equal(await hik.estadoChamada(), 'livre');
    leitor.chamada = 'ring';
    assert.equal(await hik.estadoChamada(), 'tocando');
    await hik.encerrarChamada();
    assert.equal(leitor.chamada, 'idle');
    assert.deepEqual(await hik.foto(), FOTO_TESTE);
    await hik.configurarEnvio('http://10.8.0.1:8090/hik/abc123');
    assert.equal(leitor.destinoEventos, 'http://10.8.0.1:8090/hik/abc123');

    await assert.rejects(new Hikvision({ endereco, usuario: 'admin', senha: 'errada' }).info(), /senha do equipamento incorretos/);
    await assert.rejects(new Hikvision({ endereco: 'http://127.0.0.1:1', usuario: 'a', senha: 'b' }).info(), ErroEquipamento);
    // Equipamento que aceita a conexão e nunca responde (VPN lenta, equipamento travado).
    const mudo = createServer(() => undefined);
    await new Promise<void>((r) => mudo.listen(0, '127.0.0.1', r));
    try {
      const porta = (mudo.address() as { port: number }).port;
      await assert.rejects(new Hikvision({ endereco: `http://127.0.0.1:${porta}`, usuario: 'a', senha: 'b' }, 300).info(), /não respondeu a tempo/);
    } finally {
      mudo.closeAllConnections();
      await new Promise<void>((r) => mudo.close(() => r()));
    }
  } finally {
    await leitor.parar();
  }
});

test('eventos do equipamento: JSON em multipart, XML e sinal de vida', () => {
  const limite = 'X';
  const corpo = Buffer.concat([
    Buffer.from(`--${limite}\r\nContent-Disposition: form-data; name="event_log"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(eventoRosto('Maria Silva'))}\r\n`),
    Buffer.from(`--${limite}\r\nContent-Disposition: form-data; name="Picture"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), FOTO_TESTE, Buffer.from(`\r\n--${limite}--\r\n`),
  ]);
  const e = lerEventoEquipamento(corpo, `multipart/form-data; boundary=${limite}`);
  assert.deepEqual([e.tipo, e.descricao, e.nome, e.codigo], ['acesso', 'Rosto reconhecido', 'Maria Silva', '5/75']);
  assert.deepEqual(e.foto, FOTO_TESTE);
  const n = lerEventoEquipamento(Buffer.from(JSON.stringify(eventoRosto('', false))), 'application/json');
  assert.deepEqual([n.tipo, n.descricao, n.nome], ['negado', 'Rosto não reconhecido', undefined]);
  const xml = '<EventNotificationAlert><dateTime>2026-10-28T18:48:00-03:00</dateTime><eventType>AccessControllerEvent</eventType><AccessControllerEvent><majorEventType>5</majorEventType><subEventType>21</subEventType></AccessControllerEvent></EventNotificationAlert>';
  const x = lerEventoEquipamento(Buffer.from(xml), 'application/xml');
  assert.deepEqual([x.tipo, x.descricao, x.em], ['porta', 'Porta destrancada', '2026-10-28T21:48:00.000Z']);
  assert.equal(lerEventoEquipamento(Buffer.from('{"eventType":"heartBeat"}'), 'application/json').tipo, 'sinal');
  assert.equal(lerEventoEquipamento(Buffer.from('{"eventType":"AccessControllerEvent","AccessControllerEvent":{"majorEventType":3,"subEventType":1024}}'), 'application/json').descricao, 'Evento do leitor (código 3/1024)');
  assert.throws(() => lerEventoEquipamento(Buffer.from('lixo'), 'text/plain'), /formato desconhecido/);
});

test('portaria com equipamento: cadastro, teste, eventos, chamada tocando e abrir porta registrado', async () => {
  const { MemoryRepo } = await import('../src/store/memoryRepo.js');
  const { Central } = await import('../src/central.js');
  const { createApi, listen } = await import('../src/api/server.js');
  const { hashSenha } = await import('../src/auth/senha.js');
  const { Cofre } = await import('../src/portaria/cofre.js');
  const { PortariaAoVivo } = await import('../src/portaria/aoVivo.js');
  const leitor = new LeitorSimulado();
  const enderecoLeitor = await leitor.iniciar();
  const repo = new MemoryRepo();
  const a = await repo.criarEmpresa({ nome: 'Shop Sei' });
  const b = await repo.criarEmpresa({ nome: 'Vigia Sul' });
  const senha = await hashSenha('senha-forte-1');
  await repo.criarUsuario({ empresaId: a.id, login: 'adm', nome: 'Adm', papel: 'admin', senhaHash: senha });
  await repo.criarUsuario({ empresaId: a.id, login: 'ana', nome: 'Ana', papel: 'operador', senhaHash: senha });
  await repo.criarUsuario({ empresaId: b.id, login: 'beto', nome: 'Beto', papel: 'admin', senhaHash: senha });
  const central = new Central(repo);
  await central.iniciar();
  const cofre = new Cofre('chave-de-teste-bem-longa');
  const aoVivo = new PortariaAoVivo(repo.portaria, cofre);
  let base = '';
  const server = createApi(central, { publicDir: 'public', port: 0, repo, aoVivo, cofre, urlEventos: 'http://127.0.0.1:0' });
  base = `http://127.0.0.1:${await listen(server, 0, '127.0.0.1')}`;
  const json = { 'content-type': 'application/json' };
  const entrar = async (login: string) => {
    const r = await fetch(`${base}/api/login`, { method: 'POST', headers: json, body: JSON.stringify({ login, senha: 'senha-forte-1' }) });
    return { ...json, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0]! };
  };
  const chamar = async (h: Record<string, string>, metodo: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, { method: metodo, headers: h, body: body === undefined ? undefined : JSON.stringify(body ?? {}) });
    const t = r.headers.get('content-type') ?? '';
    return { status: r.status, tipo: t, corpo: (t.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer())) as never };
  };
  try {
    const adm = await entrar('adm');
    const ana = await entrar('ana');
    const beto = await entrar('beto');
    const c = (await chamar(adm, 'POST', '/api/portaria/condominios', { nome: 'Cond. Zé Moreira' })).corpo as { id: number };
    const novo = { nome: 'Portão social', endereco: enderecoLeitor, usuario: 'admin', senha: 'senha-do-leitor', porta: 1 };
    assert.equal((await chamar(ana, 'POST', `/api/portaria/condominios/${c.id}/equipamentos`, novo)).status, 403);
    const criado = await chamar(adm, 'POST', `/api/portaria/condominios/${c.id}/equipamentos`, novo);
    assert.equal(criado.status, 201);
    const eq = criado.corpo as Record<string, unknown> & { id: number };
    assert.ok(!('senha' in eq) && !('senhaCifrada' in eq) && !('tokenEventos' in eq), 'senha e token nunca saem da API');
    // A senha fica cifrada no banco.
    const guardado = (await repo.portaria.buscarEquipamento(a.id, eq.id))!;
    assert.ok(!guardado.senhaCifrada.includes('senha-do-leitor'));
    // Operador não vê endereço nem usuário do equipamento.
    const vistoAna = ((await chamar(ana, 'GET', `/api/portaria/condominios/${c.id}/equipamentos`)).corpo as Record<string, unknown>[])[0]!;
    assert.deepEqual([vistoAna.nome, 'endereco' in vistoAna, 'usuario' in vistoAna], ['Portão social', false, false]);

    assert.deepEqual(((await chamar(adm, 'POST', `/api/portaria/equipamentos/${eq.id}/testar`, {})).corpo as { modelo: string }).modelo, 'DS-K1T342MWX');
    assert.equal((await chamar(ana, 'POST', `/api/portaria/equipamentos/${eq.id}/testar`, {})).status, 403);

    // Envio de eventos: o equipamento passa a postar no /hik/<token> deste servidor.
    assert.equal((await chamar(adm, 'POST', `/api/portaria/equipamentos/${eq.id}/configurar-envio`, {})).status, 200);
    leitor.destinoEventos = leitor.destinoEventos!.replace('http://127.0.0.1:0', base);
    assert.match(leitor.destinoEventos, new RegExp(`/hik/${guardado.tokenEventos}$`));
    assert.equal(await leitor.enviarEvento(eventoRosto('Maria Silva')), 200);
    assert.equal(await leitor.enviarEvento({ eventType: 'heartBeat' }, false), 200);
    assert.equal((await fetch(`${base}/hik/token-que-nao-existe-123`, { method: 'POST', body: '{}' })).status, 404);
    const vivo = (await chamar(ana, 'GET', `/api/portaria/ao-vivo?condominio=${c.id}`)).corpo as { eventos: { id: string; descricao: string; nome: string; temFoto: boolean }[]; chamadas: unknown[] };
    assert.deepEqual(vivo.eventos.map((e) => [e.descricao, e.nome, e.temFoto]), [['Rosto reconhecido', 'Maria Silva', true]]);
    const foto = await chamar(ana, 'GET', `/api/portaria/eventos/${vivo.eventos[0]!.id}/foto`);
    assert.deepEqual([foto.status, foto.tipo, (foto.corpo as Buffer).equals(FOTO_TESTE)], [200, 'image/jpeg', true]);
    assert.equal((await chamar(beto, 'GET', `/api/portaria/eventos/${vivo.eventos[0]!.id}/foto`)).status, 404);
    assert.deepEqual(((await chamar(beto, 'GET', '/api/portaria/ao-vivo')).corpo as { eventos: unknown[] }).eventos, []);

    // Visitante aperta o botão: a chamada aparece uma vez e some quando para de tocar.
    await aoVivo.recarregar();
    leitor.chamada = 'ring';
    await aoVivo.verificar();
    await aoVivo.verificar();
    const tocando = (await chamar(ana, 'GET', '/api/portaria/ao-vivo')).corpo as { chamadas: { equipamentoId: number; condominioId: number }[]; eventos: { tipo: string }[] };
    assert.deepEqual(tocando.chamadas.map((x) => [x.equipamentoId, x.condominioId]), [[eq.id, c.id]]);
    assert.equal(tocando.eventos.filter((e) => e.tipo === 'chamada').length, 1);
    assert.deepEqual(((await chamar(beto, 'GET', '/api/portaria/ao-vivo')).corpo as { chamadas: unknown[] }).chamadas, []);
    const fotoAoVivo = await chamar(ana, 'GET', `/api/portaria/equipamentos/${eq.id}/foto`);
    assert.equal(fotoAoVivo.tipo, 'image/jpeg');

    // Abrir porta: só a empresa dona, e toda tentativa fica registrada.
    assert.equal((await chamar(beto, 'POST', `/api/portaria/equipamentos/${eq.id}/abrir`, {})).status, 404);
    assert.equal((await chamar(ana, 'POST', `/api/portaria/equipamentos/${eq.id}/abrir`, {})).status, 200);
    assert.equal(leitor.aberturas.length, 1);
    assert.equal((await chamar(ana, 'POST', `/api/portaria/equipamentos/${eq.id}/encerrar`, {})).status, 200);
    assert.equal(leitor.chamada, 'idle');
    await aoVivo.verificar();
    assert.deepEqual(((await chamar(ana, 'GET', '/api/portaria/ao-vivo')).corpo as { chamadas: unknown[] }).chamadas, []);

    // Senha trocada no equipamento: a abertura falha com mensagem clara e também fica registrada.
    assert.equal((await chamar(adm, 'PUT', `/api/portaria/condominios/${c.id}/equipamentos/${eq.id}`, { ...novo, senha: 'senha-errada' })).status, 200);
    const falha = await chamar(ana, 'POST', `/api/portaria/equipamentos/${eq.id}/abrir`, {});
    assert.deepEqual([falha.status, (falha.corpo as { erro: string }).erro], [502, 'Usuário ou senha do equipamento incorretos']);
    const ab = (await chamar(ana, 'GET', `/api/portaria/aberturas?condominio=${c.id}`)).corpo as { ok: boolean; operador: string }[];
    assert.deepEqual(ab.map((x) => [x.ok, x.operador]), [[false, 'Ana'], [true, 'Ana']]);
    // Editar sem senha mantém a atual.
    await chamar(adm, 'PUT', `/api/portaria/condominios/${c.id}/equipamentos/${eq.id}`, { ...novo, senha: 'senha-do-leitor' });
    await chamar(adm, 'PUT', `/api/portaria/condominios/${c.id}/equipamentos/${eq.id}`, { ...novo, senha: '' });
    assert.equal((await chamar(ana, 'POST', `/api/portaria/equipamentos/${eq.id}/abrir`, {})).status, 200);
    // Equipamento fora do ar.
    await leitor.parar();
    await aoVivo.verificar();
    const est = ((await chamar(ana, 'GET', `/api/portaria/condominios/${c.id}/equipamentos`)).corpo as { online: boolean; erro: string }[])[0]!;
    assert.deepEqual([est.online, /fora do ar|recusou a conexão/.test(est.erro)], [false, true]);
    assert.equal((await chamar(adm, 'DELETE', `/api/portaria/condominios/${c.id}/equipamentos/${eq.id}`, {})).status, 200);
  } finally {
    await leitor.parar();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
