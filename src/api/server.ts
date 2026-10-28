import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { planoPara, PREFIXO_PASSO, tituloOcorrencia } from '../incidents/planos.js';
import type { Ocorrencia } from '../incidents/queue.js';
import type { Central } from '../central.js';
import { conferirSenha, hashSenha, SENHA_MINIMA } from '../auth/senha.js';
import { Sessoes, type Sessao } from '../auth/sessoes.js';
import type { PortariaAoVivo } from '../portaria/aoVivo.js';
import type { Cofre } from '../portaria/cofre.js';
import { ErroEquipamento, lerEventoEquipamento } from '../portaria/hikvision.js';
import { lerImportacao, pessoaValida, rotuloUnidade, UnidadeDuplicadaError, type Equipamento, type NovaUnidade, type NovoAtendimento, type Pessoa } from '../portaria/tipos.js';
import {
  ContaDuplicadaError, LoginDuplicadoError, NaoEncontradoError, RotaDuplicadaError,
  type Cliente, type NovoCliente, type Papel, type Repositorio, type Rota, type Usuario,
} from '../store/repositorio.js';

export interface ApiOptions {
  // Token de serviço opcional (Authorization: Bearer): administrador da empresa tokenEmpresa (padrão: a
  // primeira), para scripts. Pessoas entram por login.
  token?: string;
  tokenEmpresa?: number;
  sessoes?: Sessoes;
  publicDir: string;
  host?: string;
  port: number;
  repo: Repositorio;
  // Quando chegou o último evento das centrais da empresa (inclusive teste e supervisão): mostra no console se o feed calou.
  ultimoEvento?: (empresaId: number) => Date | undefined;
  // Portaria: chamadas e eventos dos equipamentos, cofre das senhas deles e o endereço (pela VPN) em que os
  // equipamentos alcançam este servidor para enviar eventos, ex.: http://10.8.0.1:8090.
  aoVivo?: PortariaAoVivo;
  cofre?: Cofre;
  urlEventos?: string;
}

function clienteResumo(c: Cliente | undefined, completo: boolean) {
  if (!c) return null;
  return {
    id: c.id, nome: c.nome, endereco: c.endereco ?? null, tipo: c.tipo ?? null, contatos: c.contatos, instrucoes: c.instrucoes ?? null,
    // Palavra-chave e contra-senha só vão para quem está atendendo a ocorrência.
    palavraChave: completo ? (c.palavraChave ?? null) : null,
    contraSenha: completo ? (c.contraSenha ?? null) : null,
    // Os links das câmeras podem trazer credenciais: também só para quem atende.
    cameras: completo ? (c.cameras ?? []) : [],
  };
}

function resumo(o: Ocorrencia, cliente?: Cliente, comCadastro = false) {
  const cadastrada = comCadastro ? cliente !== undefined : o.contaCadastrada;
  const feitos = new Set(o.acoes.filter((a) => a.descricao.startsWith(PREFIXO_PASSO)).map((a) => a.descricao.slice(PREFIXO_PASSO.length)));
  return {
    id: o.id,
    conta: o.conta,
    // Com o cadastro ligado vale o estado atual: o cliente pode ser cadastrado durante o atendimento.
    contaCadastrada: cadastrada,
    cliente: clienteResumo(cliente, o.situacao === 'em_atendimento'),
    prioridade: o.prioridade,
    situacao: o.situacao,
    operador: o.operador ?? null,
    abertaEm: o.abertaEm.toISOString(),
    adiadaAte: o.adiadaAte?.toISOString() ?? null,
    motivo: o.motivo ?? null,
    eventos: o.eventos.map((e) => ({
      em: e.receivedAt, codigo: e.code, descricao: e.description, zona: e.zoneOrUser ?? null, protocolo: e.protocol,
    })),
    resumo: tituloOcorrencia(o),
    plano: planoPara(o, cadastrada).map((passo) => ({ passo, feito: feitos.has(passo) })),
    acoes: o.acoes.map((a) => ({ em: a.em.toISOString(), operador: a.operador ?? null, descricao: a.descricao })),
  };
}

function tokenOk(req: IncomingMessage, token: string | undefined): boolean {
  if (!token) return false;
  const header = req.headers.authorization ?? '';
  if (!/^Bearer\s/i.test(header)) return false;
  const given = Buffer.from(header.replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const COOKIE = 'shopsei_sessao';

// Atrás do Caddy (CONFIAR_PROXY=1) o IP real vem no X-Forwarded-For; sem proxy esse cabeçalho é ignorado,
// porque qualquer um poderia inventá-lo para escapar do limite de tentativas.
function clienteIp(req: IncomingMessage): string {
  const xff = process.env.CONFIAR_PROXY === '1' ? String(req.headers['x-forwarded-for'] ?? '').split(',').pop()?.trim() : '';
  return xff || req.socket.remoteAddress || '?';
}
const INICIO = new Date();

function cookieDe(req: IncomingMessage): string | undefined {
  for (const parte of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return undefined;
}

function cookieSessao(req: IncomingMessage, token: string, maxAge: number): string {
  const seguro = (process.env.CONFIAR_PROXY === '1' && req.headers['x-forwarded-proto'] === 'https') || process.env.COOKIE_SEGURO === '1';
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${seguro ? '; Secure' : ''}`;
}

// Quem está chamando: uma pessoa com sessão, ou o token de serviço (que informa o operador no corpo).
interface Quem {
  nome?: string;
  papel: Papel;
  // null = dono do sistema.
  empresaId: number | null;
  sessao?: Sessao;
  token?: string;
}

// publica: sem login · empresa: só quem é de uma empresa · admin: só administradores · plataforma: só o dono do sistema.
const PAGINAS: Record<string, { arquivo: string; tipo: string; publica?: boolean; empresa?: boolean; admin?: boolean; plataforma?: boolean }> = {
  '/': { arquivo: 'index.html', tipo: 'text/html', empresa: true },
  '/index.html': { arquivo: 'index.html', tipo: 'text/html', empresa: true },
  '/clientes.html': { arquivo: 'clientes.html', tipo: 'text/html', empresa: true, admin: true },
  '/historico.html': { arquivo: 'historico.html', tipo: 'text/html', empresa: true },
  '/portaria.html': { arquivo: 'portaria.html', tipo: 'text/html', empresa: true },
  '/condominios.html': { arquivo: 'condominios.html', tipo: 'text/html', empresa: true, admin: true },
  '/usuarios.html': { arquivo: 'usuarios.html', tipo: 'text/html', admin: true },
  '/empresas.html': { arquivo: 'empresas.html', tipo: 'text/html', plataforma: true },
  '/login.html': { arquivo: 'login.html', tipo: 'text/html', publica: true },
  '/app.css': { arquivo: 'app.css', tipo: 'text/css', publica: true },
  '/app.js': { arquivo: 'app.js', tipo: 'application/javascript', publica: true },
};

function usuarioPublico(u: Usuario) {
  return { id: u.id, empresaId: u.empresaId, login: u.login, nome: u.nome, papel: u.papel, ativo: u.ativo };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new Error('Corpo grande demais');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function readRaw(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new Error('Corpo grande demais');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json', extra: Record<string, string> = {}): void {
  const binario = Buffer.isBuffer(body);
  res.writeHead(status, { 'content-type': binario ? type : `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', ...extra });
  res.end(binario || typeof body === 'string' ? body : JSON.stringify(body));
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

// Planilha para o Excel (ponto e vírgula, BOM para acentos). Célula começando com = + - @ viraria fórmula:
// um apóstrofo na frente impede.
function csv<K extends string>(cab: readonly K[], linhas: Partial<Record<K, unknown>>[]): string {
  const cel = (v: unknown) => {
    let t = v === null || v === undefined ? '' : String(v);
    if (/^[=+\-@]/.test(t)) t = `'${t}`;
    return /[",;\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return '\ufeff' + [cab.join(';'), ...linhas.map((l) => cab.map((c) => cel(l[c])).join(';'))].join('\r\n') + '\r\n';
}

// Data e hora de Brasília para planilhas (o Excel não entende o formato ISO).
const dataHoraBr = (d: Date | undefined | null) => (d ? d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }).replace(',', '') : '');

// Data de filtro: "AAAA-MM-DD" vale o dia inteiro (início em "de", fim em "até").
function dataFiltro(v: string | null, fim: boolean): Date | undefined {
  if (!v) return undefined;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T${fim ? '23:59:59.999' : '00:00:00'}` : v);
  if (Number.isNaN(d.getTime())) throw new Error('Data inválida');
  return d;
}

function text(v: unknown, campo: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`Campo "${campo}" é obrigatório`);
  return v.trim();
}

export function createApi(central: Central, opts: ApiOptions): Server {
  const sessoes = opts.sessoes ?? new Sessoes();
  const repo = opts.repo;

  const quem = (req: IncomingMessage): Quem | undefined => {
    const token = cookieDe(req);
    const sessao = sessoes.obter(token);
    if (sessao) return { nome: sessao.nome, papel: sessao.papel, empresaId: sessao.empresaId, sessao, token };
    if (tokenOk(req, opts.token)) return { papel: 'admin', empresaId: opts.tokenEmpresa ?? central.listaEmpresas()[0]?.id ?? null };
    return undefined;
  };

  // Empresa de quem chama; o dono do sistema não tem fila nem clientes.
  const empresaDe = (q: Quem): number => {
    if (q.empresaId === null) throw new HttpError(403, 'Disponível só para usuários de uma empresa');
    return q.empresaId;
  };
  const exigirAdmin = (q: Quem) => {
    if (q.papel !== 'admin') throw new HttpError(403, 'Só administradores');
  };
  const exigirPlataforma = (q: Quem) => {
    if (q.empresaId !== null || !q.sessao) throw new HttpError(403, 'Só o dono do sistema');
  };
  const senhaNova = (v: unknown): string => {
    if (typeof v !== 'string' || v.length < SENHA_MINIMA) throw new Error(`A senha precisa ter ao menos ${SENHA_MINIMA} caracteres`);
    return v;
  };
  const resumoDe = (empresaId: number, o: Ocorrencia) => resumo(o, central.clientes(empresaId).porConta(o.conta), true);
  const rotasDe = (v: unknown): Rota[] | undefined => (Array.isArray(v) ? (v as Record<string, unknown>[]).map((r) => ({
    canal: r.canal as Rota['canal'], receptora: String(r.receptora ?? '*'), linha: String(r.linha ?? '*'),
  })) : undefined);
  // Tira da escala quem não tem mais sessão nenhuma aberta.
  const desconectar = (empresaId: number | null, nome: string) => {
    if (empresaId !== null && central.empresa(empresaId) && !sessoes.temSessao(empresaId, nome)) central.fila(empresaId).desconectar(nome);
  };

  // ---- Portaria remota: condomínios e unidades (o administrador cadastra) e atendimentos (o operador registra).
  const portaria = async (req: IncomingMessage, res: ServerResponse, url: URL, q: Quem, eid: number): Promise<void> => {
    const p = repo.portaria;
    const partes = url.pathname.split('/').slice(3); // condominios, :id, unidades | importar, :uid
    const num = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : NaN);
    const opcional = (v: unknown) => (typeof v === 'string' ? v : undefined);
    if (partes[0] === 'condominios') {
      const cid = num(partes[1]);
      if (partes.length === 1 && req.method === 'GET') return send(res, 200, await p.listarCondominios(eid));
      if (partes.length === 1 && req.method === 'POST') {
        exigirAdmin(q);
        const b = await readJson(req);
        return send(res, 201, await p.criarCondominio(eid, { nome: String(b.nome ?? ''), endereco: opcional(b.endereco), instrucoes: opcional(b.instrucoes) }));
      }
      if (partes.length === 2 && !Number.isNaN(cid) && req.method === 'PUT') {
        exigirAdmin(q);
        const b = await readJson(req);
        return send(res, 200, await p.atualizarCondominio(eid, cid, {
          nome: String(b.nome ?? ''), endereco: opcional(b.endereco), instrucoes: opcional(b.instrucoes), ativo: typeof b.ativo === 'boolean' ? b.ativo : undefined,
        }));
      }
      if (partes[2] === 'unidades' && !Number.isNaN(cid)) {
        if (partes.length === 3 && req.method === 'GET') {
          // Quem está com a validade vencida vai marcado: o operador confirma com o morador antes de liberar.
          const hoje = new Date();
          const us = await p.listarUnidades(eid, cid);
          return send(res, 200, us.map((u) => ({ ...u, rotulo: rotuloUnidade(u), pessoas: u.pessoas.map((x) => ({ ...x, vencido: !pessoaValida(x, hoje) })) })));
        }
        exigirAdmin(q);
        const entrada = (b: Record<string, unknown>): NovaUnidade => ({
          bloco: opcional(b.bloco), numero: String(b.numero ?? ''), observacao: opcional(b.observacao),
          pessoas: Array.isArray(b.pessoas) ? (b.pessoas as Pessoa[]) : [],
        });
        if (partes.length === 3 && req.method === 'POST') return send(res, 201, await p.salvarUnidade(eid, cid, entrada(await readJson(req))));
        const uid = num(partes[3]);
        if (partes.length === 4 && !Number.isNaN(uid) && req.method === 'PUT') return send(res, 200, await p.salvarUnidade(eid, cid, { ...entrada(await readJson(req)), id: uid }));
        if (partes.length === 4 && !Number.isNaN(uid) && req.method === 'DELETE') {
          await p.removerUnidade(eid, cid, uid);
          return send(res, 200, { ok: true });
        }
      }
      if (partes[2] === 'importar' && partes.length === 3 && !Number.isNaN(cid) && req.method === 'POST') {
        // Unidade nova é criada; a que já existe ganha as pessoas que ainda não tem (pelo nome). Ninguém é apagado.
        exigirAdmin(q);
        const novas = lerImportacao(String((await readJson(req)).texto ?? ''));
        const atuais = await p.listarUnidades(eid, cid);
        let criadas = 0, atualizadas = 0, pessoas = 0;
        for (const n of novas) {
          const u = atuais.find((x) => (x.bloco ?? '') === (n.bloco ?? '') && x.numero === n.numero);
          if (!u) {
            await p.salvarUnidade(eid, cid, n);
            criadas++;
            pessoas += n.pessoas.length;
            continue;
          }
          const faltam = n.pessoas.filter((x) => !u.pessoas.some((y) => y.nome.toLowerCase() === x.nome.toLowerCase()));
          if (!faltam.length) continue;
          await p.salvarUnidade(eid, cid, { ...u, pessoas: [...u.pessoas, ...faltam] });
          atualizadas++;
          pessoas += faltam.length;
        }
        return send(res, 200, { criadas, atualizadas, pessoas });
      }
    }
    // ---- Equipamentos (leitor facial / interfone) do condomínio.
    const publicoEquip = (e: Equipamento) => ({
      id: e.id, condominioId: e.condominioId, nome: e.nome, marca: e.marca, porta: e.porta, ativo: e.ativo,
      ...(q.papel === 'admin' ? { endereco: e.endereco, usuario: e.usuario } : {}),
      ...(opts.aoVivo?.estado(e.id) ?? { online: false }),
    });
    const equip = async (id: number) => {
      const e = Number.isNaN(id) ? undefined : await p.buscarEquipamento(eid, id);
      if (!e) throw new NaoEncontradoError(`Equipamento ${id} não existe`);
      return e;
    };
    const aoVivo = () => {
      if (!opts.aoVivo) throw new HttpError(503, 'Integração com equipamentos desligada neste servidor');
      return opts.aoVivo;
    };
    if (partes[0] === 'condominios' && partes[2] === 'equipamentos' && !Number.isNaN(num(partes[1]))) {
      const cid = num(partes[1]);
      if (partes.length === 3 && req.method === 'GET') return send(res, 200, (await p.listarEquipamentos(eid, cid)).map(publicoEquip));
      exigirAdmin(q);
      const id = partes.length === 4 ? num(partes[3]) : undefined;
      if (req.method === 'DELETE' && id !== undefined && !Number.isNaN(id)) {
        await p.removerEquipamento(eid, cid, id);
        await opts.aoVivo?.recarregar();
        return send(res, 200, { ok: true });
      }
      if ((req.method === 'POST' && partes.length === 3) || (req.method === 'PUT' && id !== undefined && !Number.isNaN(id))) {
        const b = await readJson(req);
        let senhaCifrada: string | undefined;
        if (typeof b.senha === 'string' && b.senha) {
          if (!opts.cofre) throw new HttpError(503, 'Defina CHAVE_EQUIPAMENTOS no servidor para guardar senhas de equipamentos');
          if (b.senha.length > 64) throw new Error('Senha do equipamento longa demais');
          senhaCifrada = opts.cofre.cifrar(b.senha);
        }
        const e = await p.salvarEquipamento(eid, cid, {
          id, nome: String(b.nome ?? ''), marca: 'hikvision', endereco: String(b.endereco ?? ''), usuario: String(b.usuario ?? ''),
          porta: b.porta === undefined || b.porta === '' ? 1 : Number(b.porta), ativo: b.ativo !== false, senhaCifrada,
        });
        await opts.aoVivo?.recarregar();
        return send(res, id === undefined ? 201 : 200, publicoEquip(e));
      }
    }
    if (partes[0] === 'equipamentos' && partes.length === 3) {
      const e = await equip(num(partes[1]));
      const acao = partes[2];
      if (req.method === 'GET' && acao === 'foto') {
        const jpg = await aoVivo().conexao(e).foto();
        return send(res, 200, jpg, 'image/jpeg');
      }
      if (req.method === 'POST' && acao === 'abrir') {
        // Toda tentativa fica registrada, com quem pediu e se o equipamento aceitou.
        const b = await readJson(req);
        const operador = q.nome ?? text(b.operador, 'operador');
        try {
          await aoVivo().conexao(e).abrirPorta(e.porta);
        } catch (err) {
          await p.registrarAbertura(eid, { equipamentoId: e.id, condominioId: e.condominioId, em: new Date(), operador, ok: false, erro: (err as Error).message });
          throw err;
        }
        await p.registrarAbertura(eid, { equipamentoId: e.id, condominioId: e.condominioId, em: new Date(), operador, ok: true });
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && acao === 'encerrar') {
        await readJson(req);
        await aoVivo().conexao(e).encerrarChamada();
        return send(res, 200, { ok: true });
      }
      if (req.method === 'POST' && acao === 'testar') {
        exigirAdmin(q);
        await readJson(req);
        return send(res, 200, await aoVivo().conexao(e).info());
      }
      if (req.method === 'POST' && acao === 'configurar-envio') {
        exigirAdmin(q);
        await readJson(req);
        if (!opts.urlEventos) throw new HttpError(503, 'Defina PORTARIA_URL_EVENTOS no servidor (endereço deste servidor na VPN)');
        await aoVivo().conexao(e).configurarEnvio(`${opts.urlEventos.replace(/\/+$/, '')}/hik/${e.tokenEventos}`);
        return send(res, 200, { ok: true });
      }
    }
    if (partes[0] === 'ao-vivo' && partes.length === 1 && req.method === 'GET') {
      const cond = Number(url.searchParams.get('condominio')) || undefined;
      const v = opts.aoVivo;
      return send(res, 200, { chamadas: v?.chamadas(eid) ?? [], eventos: v?.eventosDa(eid, cond).slice(0, 30) ?? [] });
    }
    if (partes[0] === 'eventos' && partes[2] === 'foto' && partes.length === 3 && req.method === 'GET') {
      const jpg = opts.aoVivo?.fotoDoEvento(eid, partes[1]!);
      if (!jpg) throw new NaoEncontradoError('Foto não disponível');
      return send(res, 200, jpg, 'image/jpeg');
    }
    if (partes[0] === 'aberturas' && partes.length === 1 && req.method === 'GET') {
      const cond = Number(url.searchParams.get('condominio'));
      if (!cond) throw new Error('Informe o condomínio');
      return send(res, 200, await p.listarAberturas(eid, cond, 30));
    }
    if (partes.length === 1 && partes[0] === 'atendimentos' && req.method === 'POST') {
      const b = await readJson(req);
      const a: NovoAtendimento = {
        condominioId: Number(b.condominioId),
        unidadeId: b.unidadeId === undefined || b.unidadeId === null || b.unidadeId === '' ? undefined : Number(b.unidadeId),
        tipo: b.tipo as NovoAtendimento['tipo'], visitante: String(b.visitante ?? ''), decisao: b.decisao as NovoAtendimento['decisao'],
        documento: opcional(b.documento), autorizadoPor: opcional(b.autorizadoPor), observacao: opcional(b.observacao),
      };
      return send(res, 201, await p.registrarAtendimento(eid, a, q.nome ?? text(b.operador, 'operador'), new Date()));
    }
    if (partes.length === 1 && (partes[0] === 'atendimentos' || partes[0] === 'atendimentos.csv') && req.method === 'GET') {
      const ehCsv = partes[0].endsWith('.csv');
      const cond = url.searchParams.get('condominio');
      const lista = await p.listarAtendimentos(eid, {
        condominioId: cond ? Number(cond) || undefined : undefined,
        de: dataFiltro(url.searchParams.get('de'), false),
        ate: dataFiltro(url.searchParams.get('ate'), true),
        limite: Math.min(Math.max(Number(url.searchParams.get('limite')) || 200, 1), ehCsv ? 5000 : 500),
      });
      const nomes = new Map((await p.listarCondominios(eid)).map((c) => [c.id, c.nome]));
      const linhas = lista.map((a) => ({ ...a, em: a.em.toISOString(), condominio: nomes.get(a.condominioId) ?? '' }));
      if (!ehCsv) return send(res, 200, linhas);
      const cab = ['id', 'em', 'condominio', 'unidade', 'tipo', 'visitante', 'documento', 'decisao', 'autorizadoPor', 'operador', 'observacao'] as const;
      const planilha = lista.map((a, i) => ({ ...linhas[i]!, em: dataHoraBr(a.em) }));
      return send(res, 200, csv(cab, planilha), 'text/csv', { 'content-disposition': 'attachment; filename="portaria.csv"' });
    }
    send(res, 404, { erro: 'Não encontrado' });
  };

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const q = quem(req);
      const pagina = PAGINAS[url.pathname];
      if (req.method === 'GET' && pagina) {
        const ir = (location: string) => send(res, 302, '', 'text/plain', { location });
        if (!pagina.publica && !q) return ir('/login.html');
        if (url.pathname === '/login.html' && q?.sessao) return ir(q.empresaId === null ? '/empresas.html' : '/');
        if (q && pagina.empresa && q.empresaId === null) return ir('/empresas.html');
        if (q && pagina.plataforma && q.empresaId !== null) return ir('/');
        if (q && pagina.admin && q.papel !== 'admin') return ir(q.empresaId === null ? '/empresas.html' : '/');
        const html = await readFile(join(opts.publicDir, pagina.arquivo), 'utf8');
        return send(res, 200, html, pagina.tipo, pagina.publica ? {} : { 'cache-control': 'no-store' });
      }
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });
      // Eventos que os equipamentos dos condomínios enviam (sem login: o token no endereço identifica o equipamento).
      const hik = /^\/hik\/([A-Za-z0-9_-]{16,64})$/.exec(url.pathname);
      if (req.method === 'POST' && hik) {
        const corpo = await readRaw(req, 3 * 1024 * 1024);
        const e = opts.aoVivo ? await repo.portaria.equipamentoPorToken(hik[1]!) : undefined;
        if (!e || !opts.aoVivo) return send(res, 404, { erro: 'Não encontrado' });
        opts.aoVivo.receber(e, lerEventoEquipamento(corpo, req.headers['content-type'] ?? ''));
        return send(res, 200, { ok: true });
      }
      if (!url.pathname.startsWith('/api/')) return send(res, 404, { erro: 'Não encontrado' });

      // Chamadas que mudam algo só valem como JSON: formulários de outros sites não conseguem enviá-las.
      if (req.method !== 'GET' && !/^application\/json/i.test(req.headers['content-type'] ?? '')) {
        return send(res, 415, { erro: 'Use application/json' });
      }

      if (req.method === 'POST' && url.pathname === '/api/login') {
        const body = await readJson(req);
        const login = String(body.login ?? '').trim().toLowerCase();
        const ip = `ip|${clienteIp(req)}`;
        const chave = `${login}|${ip}`;
        if (sessoes.bloqueado(chave) || sessoes.bloqueado(ip, 25)) return send(res, 429, { erro: 'Muitas tentativas. Aguarde alguns minutos.' });
        const u = await repo.buscarUsuario(login);
        const certo = await conferirSenha(String(body.senha ?? ''), u?.senhaHash);
        if (!u || !u.ativo || !certo) {
          sessoes.registrarFalha(chave);
          sessoes.registrarFalha(ip);
          return send(res, 401, { erro: 'Usuário ou senha incorretos' });
        }
        if (u.empresaId !== null && !central.empresa(u.empresaId)?.ativo) return send(res, 403, { erro: 'Empresa suspensa. Fale com o suporte.' });
        sessoes.limparFalhas(chave);
        const token = sessoes.criar({ usuarioId: u.id, empresaId: u.empresaId, login: u.login, nome: u.nome, papel: u.papel });
        return send(res, 200, usuarioPublico(u), 'application/json', { 'set-cookie': cookieSessao(req, token, 12 * 3600) });
      }
      if (!q) return send(res, 401, { erro: 'Faça login' });

      if (req.method === 'POST' && url.pathname === '/api/logout') {
        sessoes.encerrar(q.token);
        if (q.nome) desconectar(q.empresaId, q.nome);
        return send(res, 200, { ok: true }, 'application/json', { 'set-cookie': cookieSessao(req, '', 0) });
      }
      if (req.method === 'GET' && url.pathname === '/api/eu') {
        const empresa = q.empresaId === null ? undefined : central.empresa(q.empresaId);
        return send(res, 200, {
          login: q.sessao?.login ?? null, nome: q.nome ?? null, papel: q.papel, plataforma: q.empresaId === null,
          empresa: empresa ? { id: empresa.id, nome: empresa.nome } : null,
          disponivel: q.nome && empresa ? central.fila(empresa.id).estaDisponivel(q.nome) : false,
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/senha') {
        if (!q.sessao) return send(res, 400, { erro: 'Disponível só para quem entrou com usuário' });
        const body = await readJson(req);
        const u = await repo.buscarUsuario(q.sessao.login);
        if (!u || !(await conferirSenha(String(body.atual ?? ''), u.senhaHash))) return send(res, 400, { erro: 'A senha atual não confere' });
        if (typeof body.nova !== 'string' || body.nova.length < SENHA_MINIMA) return send(res, 400, { erro: `A nova senha precisa ter ao menos ${SENHA_MINIMA} caracteres` });
        await repo.atualizarUsuario(u.empresaId, u.id, { senhaHash: await hashSenha(body.nova) });
        return send(res, 200, { ok: true });
      }

      // Usuários: o administrador cuida dos da sua empresa; o dono do sistema, dos donos do sistema.
      if (url.pathname === '/api/usuarios' || /^\/api\/usuarios\/\d+$/.test(url.pathname)) {
        exigirAdmin(q);
        const escopo = q.empresaId;
        if (req.method === 'GET') return send(res, 200, (await repo.listarUsuarios(escopo)).map(usuarioPublico));
        const body = await readJson(req);
        if (req.method === 'POST' && url.pathname === '/api/usuarios') {
          const u = await repo.criarUsuario({
            empresaId: escopo, login: String(body.login ?? ''), nome: String(body.nome ?? ''), papel: (escopo === null ? 'admin' : body.papel) as Papel,
            senhaHash: await hashSenha(senhaNova(body.senha)),
          });
          return send(res, 201, usuarioPublico(u));
        }
        if (req.method === 'PUT') {
          const id = Number(url.pathname.split('/').pop());
          if (q.sessao?.usuarioId === id && (body.ativo === false || (body.papel && body.papel !== 'admin'))) {
            throw new Error('Você não pode desativar nem rebaixar a si mesmo');
          }
          const mudancas: Partial<Pick<Usuario, 'nome' | 'papel' | 'ativo' | 'senhaHash'>> = {};
          if (typeof body.nome === 'string') mudancas.nome = body.nome;
          if (body.papel !== undefined && escopo !== null) mudancas.papel = body.papel as Papel;
          if (typeof body.ativo === 'boolean') mudancas.ativo = body.ativo;
          if (body.senha !== undefined) mudancas.senhaHash = await hashSenha(senhaNova(body.senha));
          const u = await repo.atualizarUsuario(escopo, id, mudancas);
          if (!u.ativo || mudancas.senhaHash || mudancas.papel) {
            sessoes.revogarUsuario(id);
            desconectar(escopo, u.nome);
          }
          return send(res, 200, usuarioPublico(u));
        }
        return send(res, 405, { erro: 'Método não permitido' });
      }

      // ---- Dono do sistema: empresas compradoras, rotas e eventos sem dono.
      if (url.pathname === '/api/empresas' || /^\/api\/empresas\/\d+(\/usuarios)?$/.test(url.pathname) || url.pathname === '/api/sem-rota') {
        exigirPlataforma(q);
        if (req.method === 'GET' && url.pathname === '/api/sem-rota') return send(res, 200, central.semRota);
        if (req.method === 'GET' && url.pathname === '/api/empresas') {
          return send(res, 200, central.listaEmpresas().map((e) => ({
            ...e, clientes: central.clientes(e.id).todos().length, ultimoEventoEm: opts.ultimoEvento?.(e.id)?.toISOString() ?? null,
          })));
        }
        const body = await readJson(req);
        if (req.method === 'POST' && url.pathname === '/api/empresas') {
          // Confere o administrador antes de criar a empresa, para não sobrar empresa sem ninguém que entre nela.
          const admin = (body.admin ?? {}) as Record<string, unknown>;
          const senha = await hashSenha(senhaNova(admin.senha));
          if (await repo.buscarUsuario(String(admin.login ?? ''))) throw new LoginDuplicadoError(`O login ${String(admin.login).trim().toLowerCase()} já existe`);
          const empresa = await repo.criarEmpresa({ nome: String(body.nome ?? ''), rotas: rotasDe(body.rotas) });
          await repo.criarUsuario({ empresaId: empresa.id, login: String(admin.login ?? ''), nome: String(admin.nome ?? ''), papel: 'admin', senhaHash: senha });
          await central.recarregarEmpresas();
          return send(res, 201, empresa);
        }
        const id = Number(url.pathname.split('/')[3]);
        if (req.method === 'POST' && url.pathname.endsWith('/usuarios')) {
          if (!central.empresa(id)) throw new NaoEncontradoError(`Empresa ${id} não existe`);
          const u = await repo.criarUsuario({
            empresaId: id, login: String(body.login ?? ''), nome: String(body.nome ?? ''), papel: (body.papel ?? 'admin') as Papel,
            senhaHash: await hashSenha(senhaNova(body.senha)),
          });
          return send(res, 201, usuarioPublico(u));
        }
        if (req.method === 'PUT') {
          const empresa = await repo.atualizarEmpresa(id, {
            nome: typeof body.nome === 'string' ? body.nome : undefined,
            ativo: typeof body.ativo === 'boolean' ? body.ativo : undefined,
            rotas: rotasDe(body.rotas),
          });
          await central.recarregarEmpresas();
          if (!empresa.ativo) sessoes.revogarEmpresa(id);
          return send(res, 200, empresa);
        }
        return send(res, 405, { erro: 'Método não permitido' });
      }

      // ---- Daqui para baixo tudo é da empresa de quem chama.
      const eid = empresaDe(q);
      const fila = central.fila(eid);
      const clientes = central.clientes(eid);

      if (req.method === 'GET' && url.pathname === '/api/estado') {
        const ultimo = opts.ultimoEvento?.(eid);
        return send(res, 200, { agora: new Date().toISOString(), iniciadoEm: INICIO.toISOString(), ultimoEventoEm: ultimo?.toISOString() ?? null });
      }
      if (req.method === 'GET' && (url.pathname === '/api/historico' || url.pathname === '/api/historico.csv')) {
        const ehCsv = url.pathname.endsWith('.csv');
        const lista = await repo.listarEncerradas(eid, {
          conta: url.searchParams.get('conta')?.trim().toUpperCase() || undefined,
          de: dataFiltro(url.searchParams.get('de'), false),
          ate: dataFiltro(url.searchParams.get('ate'), true),
          limite: Math.min(Math.max(Number(url.searchParams.get('limite')) || 200, 1), ehCsv ? 5000 : 500),
        });
        const linhas = lista.map((o) => ({
          id: o.id, conta: o.conta, cliente: clientes.porConta(o.conta)?.nome ?? null, prioridade: o.prioridade,
          abertaEm: o.abertaEm.toISOString(), encerradaEm: o.encerradaEm?.toISOString() ?? null, operador: o.operador ?? null,
          motivo: o.motivo ?? null, conclusao: o.conclusao ?? null, resumo: o.eventos.length ? tituloOcorrencia(o) : '', eventos: o.eventos.length,
        }));
        if (!ehCsv) return send(res, 200, linhas);
        const cab = ['id', 'conta', 'cliente', 'prioridade', 'abertaEm', 'encerradaEm', 'operador', 'motivo', 'conclusao', 'resumo', 'eventos'] as const;
        const planilha = lista.map((o, i) => ({ ...linhas[i]!, abertaEm: dataHoraBr(o.abertaEm), encerradaEm: dataHoraBr(o.encerradaEm) }));
        return send(res, 200, csv(cab, planilha), 'text/csv', { 'content-disposition': 'attachment; filename="historico.csv"' });
      }

      if (req.method === 'GET' && url.pathname === '/api/ocorrencias') {
        return send(res, 200, fila.list().filter((o) => o.situacao !== 'encerrada').map((o) => resumoDe(eid, o)));
      }
      if (req.method === 'POST' && url.pathname === '/api/operadores') {
        const body = await readJson(req);
        fila.setOperator(q.nome ?? text(body.nome, 'nome'), body.disponivel === true);
        return send(res, 200, { ok: true });
      }
      const anota = /^\/api\/ocorrencias\/(\d+)\/acoes$/.exec(url.pathname);
      if (req.method === 'POST' && anota) {
        // Anotação do operador: passo do plano feito, ligação feita ou texto livre.
        const body = await readJson(req);
        const operador = q.nome ?? text(body.operador, 'operador');
        const descricao = text(body.descricao, 'descricao');
        if (descricao.length > 500) throw new Error('Anotação longa demais (máximo 500 caracteres)');
        const o = fila.get(Number(anota[1]));
        if (o.situacao !== 'em_atendimento' || o.operador !== operador) throw new Error('Ocorrência está com outro operador');
        fila.registrarAcao(o.id, operador, descricao);
        return send(res, 200, resumoDe(eid, o));
      }
      const m = /^\/api\/ocorrencias\/(\d+)\/(concluir|adiar)$/.exec(url.pathname);
      if (req.method === 'POST' && m) {
        const id = Number(m[1]);
        const body = await readJson(req);
        const operador = q.nome ?? text(body.operador, 'operador');
        if (m[2] === 'concluir') {
          const conclusao = typeof body.conclusao === 'string' ? body.conclusao : undefined;
          return send(res, 200, resumoDe(eid, fila.encerrar(id, operador, text(body.motivo, 'motivo'), conclusao)));
        }
        const ate = new Date(text(body.ate, 'ate'));
        if (Number.isNaN(ate.getTime())) throw new Error('Data inválida');
        return send(res, 200, resumoDe(eid, fila.adiar(id, operador, ate)));
      }
      if (url.pathname === '/api/clientes' || /^\/api\/clientes\/\d+$/.test(url.pathname)) {
        exigirAdmin(q);
        if (req.method === 'GET' && url.pathname === '/api/clientes') return send(res, 200, await repo.listarClientes(eid));
        const entrada = (b: Record<string, unknown>): NovoCliente => ({
          nome: String(b.nome ?? ''),
          endereco: typeof b.endereco === 'string' ? b.endereco : undefined,
          tipo: typeof b.tipo === 'string' ? b.tipo : undefined,
          observacoes: typeof b.observacoes === 'string' ? b.observacoes : undefined,
          instrucoes: typeof b.instrucoes === 'string' ? b.instrucoes : undefined,
          intervaloTesteHoras: b.intervaloTesteHoras === undefined || b.intervaloTesteHoras === null || b.intervaloTesteHoras === '' ? undefined : Number(b.intervaloTesteHoras),
          palavraChave: typeof b.palavraChave === 'string' ? b.palavraChave : undefined,
          contraSenha: typeof b.contraSenha === 'string' ? b.contraSenha : undefined,
          contas: Array.isArray(b.contas) ? b.contas.map(String) : [],
          cameras: Array.isArray(b.cameras) ? (b.cameras as Record<string, unknown>[]).map((x, i) => ({
            nome: String(x.nome ?? ''), marca: typeof x.marca === 'string' ? x.marca : undefined, url: String(x.url ?? ''), ordem: Number(x.ordem) || i + 1,
          })) : [],
          contatos: Array.isArray(b.contatos) ? (b.contatos as Record<string, unknown>[]).map((x, i) => ({
            nome: String(x.nome ?? ''), telefone: typeof x.telefone === 'string' ? x.telefone : undefined, ordem: Number(x.ordem) || i + 1,
          })) : [],
        });
        let cliente: Cliente;
        if (req.method === 'POST' && url.pathname === '/api/clientes') {
          cliente = await repo.criarCliente(eid, entrada(await readJson(req)));
        } else if (req.method === 'PUT') {
          cliente = await repo.atualizarCliente(eid, Number(url.pathname.split('/').pop()), entrada(await readJson(req)));
        } else {
          return send(res, 405, { erro: 'Método não permitido' });
        }
        await clientes.refresh();
        return send(res, req.method === 'POST' ? 201 : 200, cliente);
      }
      if (url.pathname.startsWith('/api/portaria/')) return await portaria(req, res, url, q, eid);
      send(res, 404, { erro: 'Não encontrado' });
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { erro: err.message });
      if (err instanceof ErroEquipamento) return send(res, 502, { erro: err.message });
      if (err instanceof ContaDuplicadaError || err instanceof LoginDuplicadoError || err instanceof RotaDuplicadaError || err instanceof UnidadeDuplicadaError) return send(res, 409, { erro: err.message });
      if (err instanceof NaoEncontradoError) return send(res, 404, { erro: err.message });
      if (err instanceof SyntaxError) return send(res, 400, { erro: 'JSON inválido' });
      send(res, 400, { erro: (err as Error).message });
    }
  });
}

export async function listen(server: Server, port: number, host = '0.0.0.0'): Promise<number> {
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const addr = server.address();
  return typeof addr === 'object' && addr ? addr.port : port;
}
