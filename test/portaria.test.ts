import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApi, listen } from '../src/api/server.js';
import { hashSenha } from '../src/auth/senha.js';
import { Central } from '../src/central.js';
import { PortariaMemoria } from '../src/portaria/memoria.js';
import { lerImportacao, pessoaValida, UnidadeDuplicadaError, type RepoPortaria } from '../src/portaria/tipos.js';
import { MemoryRepo } from '../src/store/memoryRepo.js';
import { PgRepo } from '../src/store/pgRepo.js';
import { NaoEncontradoError, type Repositorio } from '../src/store/repositorio.js';

test('importação colada do Excel junta pessoas por unidade e recusa linha ruim', () => {
  const us = lerImportacao('Bloco;Número;Nome;Telefone;Tipo\na;101;Maria;1499;morador\nA;101;João;;autorizado\nB 2\t12\tAna\t\t\n;201;;;\n');
  assert.deepEqual(us.map((u) => [u.bloco, u.numero, u.pessoas.map((p) => `${p.nome}:${p.tipo}`)]), [
    ['A', '101', ['Maria:morador', 'João:autorizado']],
    ['B 2', '12', ['Ana:morador']],
    [undefined, '201', []],
  ]);
  assert.equal(us[0]!.pessoas[0]!.telefone, '1499');
  assert.throws(() => lerImportacao('A;;Maria'), /Linha 1: falta o número/);
  assert.throws(() => lerImportacao('A;1;Maria;;sindico'), /Linha 1: tipo "sindico"/);
});

test('autorização com prazo vale até o fim do dia no horário de Brasília', () => {
  const p = { nome: 'Pedreiro', tipo: 'prestador' as const, validoAte: '2026-10-28' };
  assert.equal(pessoaValida(p, new Date('2026-10-29T02:59:00Z')), true); // 23:59 em Brasília
  assert.equal(pessoaValida(p, new Date('2026-10-29T03:01:00Z')), false);
  assert.equal(pessoaValida({ nome: 'X', tipo: 'morador' }, new Date()), true);
});

async function contrato(p: RepoPortaria, a: number, b: number): Promise<void> {
  await assert.rejects(p.criarCondominio(a, { nome: '  ' }), /Nome/);
  const zm = await p.criarCondominio(a, { nome: ' Cond. Zé Moreira ', endereco: 'Rua 1', instrucoes: 'Entregas ficam na portaria' });
  assert.deepEqual([zm.nome, zm.ativo, zm.unidades, zm.instrucoes], ['Cond. Zé Moreira', true, 0, 'Entregas ficam na portaria']);
  const outro = await p.criarCondominio(b, { nome: 'Residencial B' });

  const u = await p.salvarUnidade(a, zm.id, { bloco: 'a', numero: ' 101 ', pessoas: [
    { nome: 'Maria', tipo: 'morador', telefone: '1499' }, { nome: '', tipo: 'morador' }, { nome: 'Ex-marido', tipo: 'proibido', observacao: 'Medida protetiva' },
  ] });
  assert.deepEqual([u.bloco, u.numero, u.pessoas.length], ['A', '101', 2]);
  assert.deepEqual(u.pessoas[1], { nome: 'Ex-marido', tipo: 'proibido', observacao: 'Medida protetiva' });
  await assert.rejects(p.salvarUnidade(a, zm.id, { bloco: 'A', numero: '101', pessoas: [] }), UnidadeDuplicadaError);
  await assert.rejects(p.salvarUnidade(a, zm.id, { numero: '1', pessoas: [{ nome: 'X', tipo: 'chefe' as never }] }), /Tipo de pessoa/);
  await assert.rejects(p.salvarUnidade(a, zm.id, { numero: '1', pessoas: [{ nome: 'X', tipo: 'autorizado', validoAte: '28/10' }] }), /Validade/);
  const sem = await p.salvarUnidade(a, zm.id, { numero: '201', pessoas: [] });
  assert.equal(sem.bloco, undefined);
  // Mesmo número em outro bloco é outra unidade.
  await p.salvarUnidade(a, zm.id, { bloco: 'B', numero: '101', pessoas: [] });

  const editada = await p.salvarUnidade(a, zm.id, { id: u.id, bloco: 'A', numero: '101', pessoas: [{ nome: 'Maria', tipo: 'morador' }] });
  assert.equal(editada.pessoas.length, 1);
  assert.equal((await p.listarUnidades(a, zm.id)).length, 3);
  assert.equal((await p.listarCondominios(a))[0]!.unidades, 3);

  // A outra empresa não vê nem mexe no condomínio desta.
  assert.deepEqual((await p.listarCondominios(b)).map((c) => c.nome), ['Residencial B']);
  await assert.rejects(p.listarUnidades(b, zm.id), NaoEncontradoError);
  await assert.rejects(p.salvarUnidade(b, zm.id, { numero: '9', pessoas: [] }), NaoEncontradoError);
  await assert.rejects(p.atualizarCondominio(b, zm.id, { nome: 'Roubado' }), NaoEncontradoError);
  await assert.rejects(p.salvarUnidade(a, outro.id, { numero: '9', pessoas: [] }), NaoEncontradoError);
  await assert.rejects(p.salvarUnidade(a, zm.id, { id: 99999, numero: '9', pessoas: [] }), NaoEncontradoError);

  const at = await p.registrarAtendimento(a, { condominioId: zm.id, unidadeId: u.id, tipo: 'entrega', visitante: ' iFood ', decisao: 'liberado', autorizadoPor: 'Maria' }, 'Ana', new Date('2026-10-28T20:00:00Z'));
  assert.deepEqual([at.visitante, at.unidade, at.operador, at.em.toISOString()], ['iFood', 'A 101', 'Ana', '2026-10-28T20:00:00.000Z']);
  await p.registrarAtendimento(a, { condominioId: zm.id, tipo: 'visitante', visitante: 'Desconhecido', decisao: 'negado' }, 'Ana', new Date('2026-10-28T21:00:00Z'));
  await p.registrarAtendimento(b, { condominioId: outro.id, tipo: 'visitante', visitante: 'Zé', decisao: 'sem_resposta' }, 'Beto', new Date('2026-10-28T21:30:00Z'));
  await assert.rejects(p.registrarAtendimento(a, { condominioId: zm.id, tipo: 'visitante', visitante: '', decisao: 'liberado' }, 'Ana', new Date()), /portão/);
  await assert.rejects(p.registrarAtendimento(a, { condominioId: zm.id, tipo: 'visitante', visitante: 'X', decisao: 'talvez' as never }, 'Ana', new Date()), /Decisão/);
  await assert.rejects(p.registrarAtendimento(a, { condominioId: outro.id, tipo: 'visitante', visitante: 'X', decisao: 'liberado' }, 'Ana', new Date()), NaoEncontradoError);

  const lista = await p.listarAtendimentos(a, { limite: 10 });
  assert.deepEqual(lista.map((x) => x.visitante), ['Desconhecido', 'iFood']);
  assert.deepEqual((await p.listarAtendimentos(a, { limite: 10, de: new Date('2026-10-28T20:30:00Z') })).map((x) => x.visitante), ['Desconhecido']);
  assert.deepEqual((await p.listarAtendimentos(b, { limite: 10 })).map((x) => x.visitante), ['Zé']);

  // Apagar a unidade não apaga o histórico: o rótulo fica.
  await p.removerUnidade(a, zm.id, u.id);
  await assert.rejects(p.removerUnidade(a, zm.id, u.id), NaoEncontradoError);
  const depois = (await p.listarAtendimentos(a, { limite: 10 })).find((x) => x.visitante === 'iFood')!;
  assert.deepEqual([depois.unidade, depois.unidadeId], ['A 101', undefined]);

  // Equipamentos: endereço só do equipamento, senha obrigatória ao criar e mantida ao editar.
  const base = { nome: 'Portão social', marca: 'hikvision' as const, endereco: 'http://10.8.0.12/', usuario: 'admin', porta: 1, ativo: true };
  await assert.rejects(p.salvarEquipamento(a, zm.id, base), /Senha do equipamento/);
  await assert.rejects(p.salvarEquipamento(a, zm.id, { ...base, endereco: 'rtsp://10.8.0.12', senhaCifrada: 'x' }), /http/);
  await assert.rejects(p.salvarEquipamento(a, zm.id, { ...base, endereco: 'http://admin:123@10.8.0.12', senhaCifrada: 'x' }), /sem caminho nem senha/);
  await assert.rejects(p.salvarEquipamento(a, zm.id, { ...base, porta: 9, senhaCifrada: 'x' }), /Porta/);
  await assert.rejects(p.salvarEquipamento(b, zm.id, { ...base, senhaCifrada: 'x' }), NaoEncontradoError);
  const eq = await p.salvarEquipamento(a, zm.id, { ...base, senhaCifrada: 'cifrada-1' });
  assert.deepEqual([eq.endereco, eq.empresaId, eq.condominioId, eq.senhaCifrada, eq.tokenEventos.length >= 20], ['http://10.8.0.12', a, zm.id, 'cifrada-1', true]);
  const ed = await p.salvarEquipamento(a, zm.id, { ...base, id: eq.id, nome: 'Portão de pedestres' });
  assert.deepEqual([ed.nome, ed.senhaCifrada, ed.tokenEventos], ['Portão de pedestres', 'cifrada-1', eq.tokenEventos]);
  assert.equal((await p.equipamentoPorToken(eq.tokenEventos))?.id, eq.id);
  assert.equal(await p.equipamentoPorToken('nao-existe'), undefined);
  assert.equal((await p.buscarEquipamento(a, eq.id))?.nome, 'Portão de pedestres');
  assert.equal(await p.buscarEquipamento(b, eq.id), undefined);
  assert.deepEqual((await p.equipamentosAtivos()).map((e) => e.id), [eq.id]);
  await p.registrarAbertura(a, { equipamentoId: eq.id, condominioId: zm.id, em: new Date('2026-10-28T20:00:00Z'), operador: 'Ana', ok: true });
  await p.registrarAbertura(a, { equipamentoId: eq.id, condominioId: zm.id, em: new Date('2026-10-28T20:05:00Z'), operador: 'Ana', ok: false, erro: 'fora do ar' });
  assert.deepEqual((await p.listarAberturas(a, zm.id, 10)).map((x) => [x.ok, x.erro]), [[false, 'fora do ar'], [true, undefined]]);
  assert.deepEqual(await p.listarAberturas(b, zm.id, 10), []);
  await p.removerEquipamento(a, zm.id, eq.id);
  assert.equal((await p.listarAberturas(a, zm.id, 10))[0]!.equipamentoId, undefined);
  const eq2 = await p.salvarEquipamento(a, zm.id, { ...base, senhaCifrada: 'c' });

  const susp = await p.atualizarCondominio(a, zm.id, { nome: 'Cond. Zé Moreira', ativo: false });
  assert.equal(susp.ativo, false);
  // Condomínio desativado não tem equipamento acompanhado.
  assert.deepEqual(await p.equipamentosAtivos(), []);
  assert.equal((await p.listarEquipamentos(a, zm.id))[0]!.id, eq2.id);
}

test('portaria em memória cumpre o contrato', async () => {
  const repo = new MemoryRepo();
  const a = await repo.criarEmpresa({ nome: 'A' });
  const b = await repo.criarEmpresa({ nome: 'B' });
  await contrato(repo.portaria, a.id, b.id);
  assert.ok(repo.portaria instanceof PortariaMemoria);
});

test('portaria no PostgreSQL cumpre o contrato', { skip: !process.env.PG_TEST_URL && 'defina PG_TEST_URL para testar o PostgreSQL' }, async () => {
  const repo: Repositorio = new PgRepo(process.env.PG_TEST_URL!);
  await repo.init();
  const pool = (repo as unknown as { pool: { query: (q: string) => Promise<unknown> } }).pool;
  await pool.query('TRUNCATE aberturas_porta, equipamentos_portaria, atendimentos_portaria, unidades, condominios, ocorrencias, eventos, contatos, cameras, contas, clientes, usuarios, rotas, empresas RESTART IDENTITY CASCADE');
  try {
    const a = await repo.criarEmpresa({ nome: 'A' });
    const b = await repo.criarEmpresa({ nome: 'B' });
    await contrato(repo.portaria, a.id, b.id);
  } finally {
    await repo.fechar();
  }
});

test('API da portaria: administrador cadastra e importa, operador atende, outra empresa não vê', async () => {
  const repo = new MemoryRepo();
  const a = await repo.criarEmpresa({ nome: 'Shop Sei' });
  const b = await repo.criarEmpresa({ nome: 'Vigia Sul' });
  const senha = await hashSenha('senha-forte-1');
  await repo.criarUsuario({ empresaId: a.id, login: 'adm', nome: 'Adm', papel: 'admin', senhaHash: senha });
  await repo.criarUsuario({ empresaId: a.id, login: 'ana', nome: 'Ana', papel: 'operador', senhaHash: senha });
  await repo.criarUsuario({ empresaId: b.id, login: 'beto', nome: 'Beto', papel: 'admin', senhaHash: senha });
  const central = new Central(repo);
  await central.iniciar();
  const server = createApi(central, { publicDir: 'public', port: 0, repo });
  const base = `http://127.0.0.1:${await listen(server, 0, '127.0.0.1')}`;
  const json = { 'content-type': 'application/json' };
  const entrar = async (login: string) => {
    const r = await fetch(`${base}/api/login`, { method: 'POST', headers: json, body: JSON.stringify({ login, senha: 'senha-forte-1' }) });
    return { ...json, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0]! };
  };
  const chamar = async (h: Record<string, string>, metodo: string, path: string, body?: unknown) => {
    const r = await fetch(`${base}${path}`, { method: metodo, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const t = r.headers.get('content-type') ?? '';
    return { status: r.status, corpo: (t.includes('json') ? await r.json() : await r.text()) as never };
  };
  try {
    const adm = await entrar('adm');
    const ana = await entrar('ana');
    const beto = await entrar('beto');
    const c = (await chamar(adm, 'POST', '/api/portaria/condominios', { nome: 'Cond. Zé Moreira', instrucoes: 'Mudança só com o síndico' })).corpo as { id: number };
    assert.equal((await chamar(ana, 'POST', '/api/portaria/condominios', { nome: 'X' })).status, 403);
    assert.equal((await chamar(adm, 'POST', `/api/portaria/condominios/${c.id}/unidades`, { bloco: 'A', numero: '101', pessoas: [{ nome: 'Maria', tipo: 'morador', telefone: '1499' }] })).status, 201);
    assert.equal((await chamar(adm, 'POST', `/api/portaria/condominios/${c.id}/unidades`, { bloco: 'a', numero: '101', pessoas: [] })).status, 409);
    assert.equal((await chamar(ana, 'POST', `/api/portaria/condominios/${c.id}/unidades`, { numero: '1', pessoas: [] })).status, 403);

    // Importação: soma pessoas novas e cria unidades, sem apagar nada; repetir não duplica.
    const texto = 'bloco;numero;nome;telefone;tipo\nA;101;Maria;;morador\nA;101;João;1488;autorizado\nB;202;Pedro;;morador\nB;202;Fulano;;proibido';
    assert.deepEqual((await chamar(adm, 'POST', `/api/portaria/condominios/${c.id}/importar`, { texto })).corpo, { criadas: 1, atualizadas: 1, pessoas: 3 });
    assert.deepEqual((await chamar(adm, 'POST', `/api/portaria/condominios/${c.id}/importar`, { texto })).corpo, { criadas: 0, atualizadas: 0, pessoas: 0 });
    assert.equal((await chamar(adm, 'POST', `/api/portaria/condominios/${c.id}/importar`, { texto: 'A;101;X;;sindico' })).status, 400);

    // O operador vê condomínios e unidades, com a validade conferida.
    const conds = (await chamar(ana, 'GET', '/api/portaria/condominios')).corpo as { nome: string; unidades: number; instrucoes: string }[];
    assert.deepEqual(conds.map((x) => [x.nome, x.unidades, x.instrucoes]), [['Cond. Zé Moreira', 2, 'Mudança só com o síndico']]);
    const us = (await chamar(ana, 'GET', `/api/portaria/condominios/${c.id}/unidades`)).corpo as { id: number; rotulo: string; pessoas: { nome: string; vencido: boolean }[] }[];
    assert.deepEqual(us.map((u) => [u.rotulo, u.pessoas.map((x) => x.nome)]), [['A 101', ['Maria', 'João']], ['B 202', ['Pedro', 'Fulano']]]);
    assert.equal(us[0]!.pessoas[0]!.vencido, false);
    const ontem = new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 10);
    await chamar(adm, 'PUT', `/api/portaria/condominios/${c.id}/unidades/${us[1]!.id}`, { bloco: 'B', numero: '202', pessoas: [{ nome: 'Obra', tipo: 'prestador', validoAte: ontem }] });
    const venc = (await chamar(ana, 'GET', `/api/portaria/condominios/${c.id}/unidades`)).corpo as typeof us;
    assert.equal(venc[1]!.pessoas[0]!.vencido, true);

    // Atendimento: o operador é quem está logado; outra empresa não registra nem vê.
    const at = await chamar(ana, 'POST', '/api/portaria/atendimentos', { condominioId: c.id, unidadeId: us[0]!.id, tipo: 'entrega', visitante: '=Mercado Livre', decisao: 'liberado', autorizadoPor: 'Maria', operador: 'Outro' });
    assert.equal(at.status, 201);
    assert.equal((at.corpo as { operador: string }).operador, 'Ana');
    assert.equal((await chamar(ana, 'POST', '/api/portaria/atendimentos', { condominioId: c.id, tipo: 'visitante', visitante: 'X', decisao: 'liberou' })).status, 400);
    assert.equal((await chamar(beto, 'POST', '/api/portaria/atendimentos', { condominioId: c.id, tipo: 'visitante', visitante: 'X', decisao: 'liberado' })).status, 404);
    assert.equal((await chamar(beto, 'GET', `/api/portaria/condominios/${c.id}/unidades`)).status, 404);
    assert.deepEqual((await chamar(beto, 'GET', '/api/portaria/atendimentos')).corpo, []);
    const hist = (await chamar(ana, 'GET', `/api/portaria/atendimentos?condominio=${c.id}`)).corpo as { condominio: string; unidade: string }[];
    assert.deepEqual([hist[0]!.condominio, hist[0]!.unidade], ['Cond. Zé Moreira', 'A 101']);
    const planilha = (await chamar(ana, 'GET', '/api/portaria/atendimentos.csv')).corpo as string;
    assert.ok(planilha.includes("'=Mercado Livre"), 'fórmula neutralizada no CSV');
    assert.ok(planilha.includes('Cond. Zé Moreira;A 101;entrega'));
    assert.match(planilha, /\n\d+;\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2};/, 'data e hora de Brasília na planilha');

    assert.equal((await chamar(ana, 'DELETE', `/api/portaria/condominios/${c.id}/unidades/${us[0]!.id}`)).status, 403);
    assert.equal((await chamar(adm, 'DELETE', `/api/portaria/condominios/${c.id}/unidades/${us[0]!.id}`)).status, 200);
    assert.equal((await chamar(adm, 'GET', '/api/portaria/nada')).status, 404);
    // Páginas: operador abre a portaria, mas não o cadastro de condomínios.
    assert.equal((await fetch(`${base}/portaria.html`, { headers: ana })).status, 200);
    assert.equal((await fetch(`${base}/condominios.html`, { headers: ana, redirect: 'manual' })).status, 302);
    assert.equal((await fetch(`${base}/condominios.html`, { headers: adm })).status, 200);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
