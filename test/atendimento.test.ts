import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createApi, listen } from '../src/api/server.js';
import { hashSenha } from '../src/auth/senha.js';
import { Central } from '../src/central.js';
import { buscarFoto, lerImagemColada } from '../src/incidents/cameras.js';
import { IncidentQueue } from '../src/incidents/queue.js';
import { parseContactId } from '../src/protocols/contactId.js';
import type { AlarmEvent } from '../src/protocols/types.js';
import { bilheteValido } from '../src/store/repositorio.js';
import { MemoryRepo } from '../src/store/memoryRepo.js';

function ev(account: string, cid: string): AlarmEvent {
  return {
    receivedAt: new Date(0).toISOString(), transport: 'tcp', remote: 't', protocol: 'ADM-CID', account, line: '0',
    sequence: '0001', encrypted: false, raw: '', ...parseContactId(cid),
  };
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1]);
const PNG_COLADO = 'data:image/png;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0]).toString('base64');

// Câmera falsa: devolve um JPEG só com usuário e senha (Basic), como um gravador na VPN.
async function cameraFalsa() {
  let pedidos = 0;
  const srv = createServer((req, res) => {
    pedidos++;
    if (req.headers.authorization !== 'Basic ' + Buffer.from('adm:segredo').toString('base64')) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="cam"' }).end();
      return;
    }
    if (req.url === '/texto') { res.writeHead(200, { 'content-type': 'text/html' }).end('<html>'); return; }
    res.writeHead(200, { 'content-type': 'image/jpeg' }).end(JPEG);
  });
  const port = await listen(srv as never, 0, '127.0.0.1');
  return { srv, base: `http://127.0.0.1:${port}`, pedidos: () => pedidos };
}

test('fila: provisionar, apoio e fotos só para quem atende; concluir apaga o rascunho', () => {
  const q = new IncidentQueue();
  q.setOperator('Ana', true);
  const o = q.handleEvent(ev('0013', '1130 01 003'))!;
  assert.throws(() => q.provisionar(o.id, 'Beto', 'x'), /outro operador/);
  q.provisionar(o.id, 'Ana', ' Alarme falso ', '  ');
  assert.deepEqual([o.rascunho!.motivo, o.rascunho!.texto, o.rascunho!.operador], ['Alarme falso', undefined, 'Ana']);
  q.provisionar(o.id, 'Ana', '', '');
  assert.equal(o.rascunho, undefined);

  assert.throws(() => q.apoio(o.id, 'Ana', 'a_caminho'), /veículo/);
  assert.throws(() => q.apoio(o.id, 'Ana', 'voando' as never, 'V1'), /inválida/);
  q.apoio(o.id, 'Ana', 'acionado', 'Viatura 12');
  q.apoio(o.id, 'Ana', 'no_local');
  assert.deepEqual([o.apoio!.viatura, o.apoio!.situacao], ['Viatura 12', 'no_local']);
  assert.deepEqual(o.acoes.map((a) => a.descricao), ['Apoio Viatura 12: acionado', 'Apoio Viatura 12: no local']);

  q.anexarMidia(o.id, 'Ana', 7, 'câmera Caixa');
  assert.equal(o.midias![0]!.id, 7);
  assert.equal(o.acoes.at(-1)!.descricao, 'Foto anexada: câmera Caixa');

  q.provisionar(o.id, 'Ana', 'Alarme falso', 'ok');
  q.encerrar(o.id, 'Ana', 'Alarme falso', 'ok');
  assert.equal(o.rascunho, undefined);
});

test('bilhete vale até o fim do dia da validade (horário de Brasília)', () => {
  const b = { id: 1, texto: 'x', autor: 'a', criadoEm: new Date(), validoAte: '2026-12-10' };
  assert.equal(bilheteValido(b, new Date('2026-12-11T02:59:00Z')), true);
  assert.equal(bilheteValido(b, new Date('2026-12-11T03:00:01Z')), false);
  assert.equal(bilheteValido({ ...b, validoAte: undefined }, new Date('2099-01-01')), true);
});

test('foto da câmera: autentica, recusa o que não é imagem e explica a falha', async () => {
  const cam = await cameraFalsa();
  try {
    const host = cam.base.replace('http://', '');
    const f = await buscarFoto(`http://adm:segredo@${host}/ISAPI/Streaming/channels/101/picture`);
    assert.equal(f.tipo, 'image/jpeg');
    assert.deepEqual(f.dados, JPEG);
    await assert.rejects(buscarFoto(`http://adm:errada@${host}/x`), /recusou/);
    await assert.rejects(buscarFoto(`http://adm:segredo@${host}/texto`), /não devolveu uma foto/);
    await assert.rejects(buscarFoto('http://127.0.0.1:1/x', 1000), /não respondeu/);
    await assert.rejects(buscarFoto('file:///etc/passwd'), /inválido/);
  } finally {
    cam.srv.close();
  }
  assert.equal(lerImagemColada(PNG_COLADO).tipo, 'image/png');
  assert.throws(() => lerImagemColada('data:image/jpeg;base64,' + Buffer.from('<svg>').toString('base64')), /inválida/);
  assert.throws(() => lerImagemColada('data:image/svg+xml;base64,AAAA'), /inválida/);
});

test('tela de atendimento: bilhetes, provisionar, apoio, fotos e câmera dentro da ocorrência', async () => {
  const cam = await cameraFalsa();
  const repo = new MemoryRepo();
  const emp = await repo.criarEmpresa({ nome: 'Shop Sei', rotas: [{ canal: 'dc09', receptora: '*', linha: '*' }] });
  const outra = await repo.criarEmpresa({ nome: 'Vigia', rotas: [{ canal: 'surgard', receptora: '*', linha: '*' }] });
  await repo.criarUsuario({ empresaId: emp.id, login: 'admin', nome: 'Administrador', papel: 'admin', senhaHash: await hashSenha('senha-admin') });
  await repo.criarUsuario({ empresaId: emp.id, login: 'ana', nome: 'Ana', papel: 'operador', senhaHash: await hashSenha('senha-ana-1') });
  await repo.criarUsuario({ empresaId: emp.id, login: 'beto', nome: 'Beto', papel: 'operador', senhaHash: await hashSenha('senha-beto-1') });
  await repo.criarUsuario({ empresaId: outra.id, login: 'zeca', nome: 'Zé', papel: 'admin', senhaHash: await hashSenha('senha-ze-12') });
  const central = new Central(repo);
  await central.iniciar();
  const server = createApi(central, { publicDir: 'public', port: 0, repo });
  const base = `http://127.0.0.1:${await listen(server, 0, '127.0.0.1')}`;
  const json = { 'content-type': 'application/json' };
  const entrar = async (login: string, senha: string) => {
    const r = await fetch(`${base}/api/login`, { method: 'POST', headers: json, body: JSON.stringify({ login, senha }) });
    return { ...json, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0]! };
  };
  const post = (h: Record<string, string>, path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: h, body: JSON.stringify(body) });
  type Oc = {
    id: number; cliente: { referencia: string; chaves: string | null; bilhetes: { id: number; texto: string; autor: string }[]; cameras: Record<string, unknown>[] };
    rascunho: { motivo: string; texto: string } | null; apoio: { viatura: string; rotulo: string } | null; midias: { id: number; url: string; descricao: string }[];
    origem: string; eventos: { particao: string | null }[]; atendidaEm: string | null;
  };
  try {
    const admin = await entrar('admin', 'senha-admin');
    const host = cam.base.replace('http://', '');
    const cr = await post(admin, '/api/clientes', {
      nome: 'Loja Centro', contas: ['0043'], contatos: [{ nome: 'João', telefone: '1499' }], referencia: 'Ao lado da padaria', chaves: 'Com o vizinho do 12',
      cameras: [
        { nome: 'Caixa', marca: 'Hikvision', url: 'https://nuvem.exemplo/caixa', fotoUrl: `http://adm:segredo@${host}/ISAPI/Streaming/channels/101/picture` },
        { nome: 'Fundos', url: 'https://nuvem.exemplo/fundos' },
      ],
    });
    assert.equal(cr.status, 201);
    const cliente = await cr.json() as { id: number };
    // Bilhete do cadastro (administrador) aparece na ocorrência; o vencido não.
    assert.equal((await post(admin, `/api/clientes/${cliente.id}/bilhetes`, { texto: 'Dono viajando' })).status, 201);
    assert.equal((await post(admin, `/api/clientes/${cliente.id}/bilhetes`, { texto: 'Velho', validoAte: '2020-01-01' })).status, 201);

    central.fila(emp.id).handleEvent(ev('0043', '1130 02 003'));
    const ana = await entrar('ana', 'senha-ana-1');
    // Operador não usa a rota de bilhetes do cadastro.
    assert.equal((await post(ana, `/api/clientes/${cliente.id}/bilhetes`, { texto: 'x' })).status, 403);
    await post(ana, '/api/operadores', { disponivel: true });
    const lista = async (h: Record<string, string>) => (await (await fetch(`${base}/api/ocorrencias`, { headers: h })).json()) as Oc[];
    let o = (await lista(ana))[0]!;
    assert.equal(o.cliente.referencia, 'Ao lado da padaria');
    assert.equal(o.cliente.chaves, 'Com o vizinho do 12');
    assert.deepEqual(o.cliente.bilhetes.map((b) => b.texto), ['Dono viajando']);
    assert.equal(o.eventos[0]!.particao, '02');
    assert.match(o.origem, /ADM-CID/);
    assert.ok(o.atendidaEm);
    // O endereço da foto (com a senha da câmera) nunca vai para a tela.
    assert.deepEqual(o.cliente.cameras.map((k) => [k.nome, k.temFoto, 'fotoUrl' in k]), [['Caixa', true, false], ['Fundos', false, false]]);
    assert.doesNotMatch(JSON.stringify(await lista(ana)), /segredo/);

    // Quem não está atendendo não vê nem mexe.
    const beto = await entrar('beto', 'senha-beto-1');
    assert.equal((await fetch(`${base}/api/ocorrencias/${o.id}/cameras/0/foto`, { headers: beto })).status, 403);
    assert.equal((await post(beto, `/api/ocorrencias/${o.id}/provisionar`, { motivo: 'x' })).status, 400);
    assert.equal((await lista(beto))[0]!.cliente.chaves, null);

    // Câmera ao vivo dentro da ocorrência.
    const viva = await fetch(`${base}/api/ocorrencias/${o.id}/cameras/0/foto`, { headers: ana });
    assert.equal(viva.status, 200);
    assert.equal(viva.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(Buffer.from(await viva.arrayBuffer()), JPEG);
    assert.equal((await fetch(`${base}/api/ocorrencias/${o.id}/cameras/1/foto`, { headers: ana })).status, 404);

    // Provisionar guarda o texto da conclusão sem concluir.
    assert.equal((await post(ana, `/api/ocorrencias/${o.id}/provisionar`, { motivo: 'Alarme falso', texto: 'Cliente confirmou a palavra-chave' })).status, 200);
    o = (await lista(ana))[0]!;
    assert.deepEqual(o.rascunho && [o.rascunho.motivo, o.rascunho.texto], ['Alarme falso', 'Cliente confirmou a palavra-chave']);

    // Apoio e bilhete deixado pelo operador.
    assert.equal((await post(ana, `/api/ocorrencias/${o.id}/apoio`, { situacao: 'acionado' })).status, 400);
    assert.equal((await post(ana, `/api/ocorrencias/${o.id}/apoio`, { situacao: 'a_caminho', viatura: 'Viatura 12' })).status, 200);
    assert.equal((await post(ana, `/api/ocorrencias/${o.id}/bilhetes`, { texto: 'Portão com defeito' })).status, 201);
    o = (await lista(ana))[0]!;
    assert.equal(o.apoio!.rotulo, 'a caminho');
    assert.deepEqual(o.cliente.bilhetes.map((b) => [b.texto, b.autor]), [['Dono viajando', 'Administrador'], ['Portão com defeito', 'Ana']]);

    // Fotos: da câmera (o servidor busca) e colada; a câmera sem endereço de foto é recusada.
    assert.equal((await post(ana, `/api/ocorrencias/${o.id}/fotos`, { camera: 0 })).status, 201);
    assert.equal((await post(ana, `/api/ocorrencias/${o.id}/fotos`, { camera: 1 })).status, 400);
    assert.equal((await post(ana, `/api/ocorrencias/${o.id}/fotos`, { imagem: PNG_COLADO, descricao: 'print do celular' })).status, 201);
    assert.equal((await post(ana, `/api/ocorrencias/${o.id}/fotos`, { imagem: 'data:text/html;base64,PGI+' })).status, 400);
    o = (await lista(ana))[0]!;
    assert.deepEqual(o.midias.map((m) => m.descricao), ['câmera Caixa', 'print do celular']);
    const foto = await fetch(`${base}${o.midias[0]!.url}`, { headers: beto });
    assert.equal(foto.status, 200);
    assert.deepEqual(Buffer.from(await foto.arrayBuffer()), JPEG);
    // Outra empresa não abre a foto.
    const ze = await entrar('zeca', 'senha-ze-12');
    assert.equal((await fetch(`${base}${o.midias[0]!.url}`, { headers: ze })).status, 404);

    // Bilhete apagado pelo administrador some da ocorrência.
    const doOperador = o.cliente.bilhetes.find((b) => b.autor === 'Ana')!;
    assert.equal((await fetch(`${base}/api/clientes/${cliente.id}/bilhetes/${doOperador.id}`, { method: 'DELETE', headers: admin })).status, 200);
    assert.deepEqual((await lista(ana))[0]!.cliente.bilhetes.map((b) => b.texto), ['Dono viajando']);

    // Concluir apaga o rascunho.
    assert.equal((await post(ana, `/api/ocorrencias/${o.id}/concluir`, { motivo: 'Alarme falso' })).status, 200);
    assert.equal(central.fila(emp.id).get(o.id).rascunho, undefined);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    cam.srv.close();
  }
});
