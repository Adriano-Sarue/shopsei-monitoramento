import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { planoPara, PREFIXO_PASSO } from '../incidents/planos.js';
import type { IncidentQueue, Ocorrencia } from '../incidents/queue.js';
import { conferirSenha, hashSenha, SENHA_MINIMA } from '../auth/senha.js';
import { Sessoes, type Sessao } from '../auth/sessoes.js';
import { ContaDuplicadaError, LoginDuplicadoError, type Cliente, type ClienteIndex, type NovoCliente, type Papel, type Repositorio, type Usuario } from '../store/repositorio.js';

export interface ApiOptions {
  // Token de serviço opcional (Authorization: Bearer): acesso de administrador para scripts. Pessoas entram por login.
  token?: string;
  sessoes?: Sessoes;
  publicDir: string;
  host?: string;
  port: number;
  repo?: Repositorio;
  clientes?: ClienteIndex;
  // Quando chegou o último evento de qualquer central (inclusive teste e supervisão): mostra no console se o feed calou.
  ultimoEvento?: () => Date | undefined;
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
  const ultimo = o.eventos[o.eventos.length - 1]!;
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
    resumo: ultimo.description,
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
  sessao?: Sessao;
  token?: string;
}

const PAGINAS: Record<string, { arquivo: string; tipo: string; publica?: boolean; admin?: boolean }> = {
  '/': { arquivo: 'index.html', tipo: 'text/html' },
  '/index.html': { arquivo: 'index.html', tipo: 'text/html' },
  '/clientes.html': { arquivo: 'clientes.html', tipo: 'text/html', admin: true },
  '/historico.html': { arquivo: 'historico.html', tipo: 'text/html' },
  '/usuarios.html': { arquivo: 'usuarios.html', tipo: 'text/html', admin: true },
  '/login.html': { arquivo: 'login.html', tipo: 'text/html', publica: true },
  '/app.css': { arquivo: 'app.css', tipo: 'text/css', publica: true },
  '/app.js': { arquivo: 'app.js', tipo: 'application/javascript', publica: true },
};

function usuarioPublico(u: Usuario) {
  return { id: u.id, login: u.login, nome: u.nome, papel: u.papel, ativo: u.ativo };
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

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json', extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', ...extra });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function text(v: unknown, campo: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`Campo "${campo}" é obrigatório`);
  return v.trim();
}

export function createApi(queue: IncidentQueue, opts: ApiOptions): Server {
  if (!opts.token && !opts.repo) throw new Error('Defina um token de serviço ou um repositório de usuários');
  const sessoes = opts.sessoes ?? new Sessoes();

  const quem = (req: IncomingMessage): Quem | undefined => {
    const sessao = sessoes.obter(cookieDe(req));
    if (sessao) return { nome: sessao.nome, papel: sessao.papel, sessao, token: cookieDe(req) };
    if (tokenOk(req, opts.token)) return { papel: 'admin' };
    return undefined;
  };

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const q = quem(req);
      const pagina = PAGINAS[url.pathname];
      if (req.method === 'GET' && pagina) {
        if (!pagina.publica && !q) return send(res, 302, '', 'text/plain', { location: '/login.html' });
        if (pagina.admin && q?.papel !== 'admin') return send(res, 302, '', 'text/plain', { location: '/' });
        if (url.pathname === '/login.html' && q?.sessao) return send(res, 302, '', 'text/plain', { location: '/' });
        const html = await readFile(join(opts.publicDir, pagina.arquivo), 'utf8');
        return send(res, 200, html, pagina.tipo, pagina.publica ? {} : { 'cache-control': 'no-store' });
      }
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, { ok: true });
      if (!url.pathname.startsWith('/api/')) return send(res, 404, { erro: 'Não encontrado' });

      // Chamadas que mudam algo só valem como JSON: formulários de outros sites não conseguem enviá-las.
      if (req.method !== 'GET' && !/^application\/json/i.test(req.headers['content-type'] ?? '')) {
        return send(res, 415, { erro: 'Use application/json' });
      }

      if (req.method === 'POST' && url.pathname === '/api/login') {
        if (!opts.repo) return send(res, 501, { erro: 'Login não está ligado' });
        const body = await readJson(req);
        const login = String(body.login ?? '').trim().toLowerCase();
        const ip = `ip|${clienteIp(req)}`;
        const chave = `${login}|${ip}`;
        if (sessoes.bloqueado(chave) || sessoes.bloqueado(ip, 25)) return send(res, 429, { erro: 'Muitas tentativas. Aguarde alguns minutos.' });
        const u = await opts.repo.buscarUsuario(login);
        const certo = await conferirSenha(String(body.senha ?? ''), u?.senhaHash);
        if (!u || !u.ativo || !certo) {
          sessoes.registrarFalha(chave);
          sessoes.registrarFalha(ip);
          return send(res, 401, { erro: 'Usuário ou senha incorretos' });
        }
        sessoes.limparFalhas(chave);
        const token = sessoes.criar({ usuarioId: u.id, login: u.login, nome: u.nome, papel: u.papel });
        return send(res, 200, usuarioPublico(u), 'application/json', { 'set-cookie': cookieSessao(req, token, 12 * 3600) });
      }
      if (!q) return send(res, 401, { erro: 'Faça login' });

      if (req.method === 'POST' && url.pathname === '/api/logout') {
        sessoes.encerrar(q.token);
        if (q.nome && !sessoes.temSessao(q.nome)) queue.desconectar(q.nome);
        return send(res, 200, { ok: true }, 'application/json', { 'set-cookie': cookieSessao(req, '', 0) });
      }
      if (req.method === 'GET' && url.pathname === '/api/eu') {
        return send(res, 200, { login: q.sessao?.login ?? null, nome: q.nome ?? null, papel: q.papel, disponivel: q.nome ? queue.estaDisponivel(q.nome) : false });
      }

      if (req.method === 'GET' && url.pathname === '/api/estado') {
        const ultimo = opts.ultimoEvento?.();
        return send(res, 200, { agora: new Date().toISOString(), iniciadoEm: INICIO.toISOString(), ultimoEventoEm: ultimo?.toISOString() ?? null });
      }
      if (req.method === 'POST' && url.pathname === '/api/senha') {
        if (!q.sessao || !opts.repo) return send(res, 400, { erro: 'Disponível só para quem entrou com usuário' });
        const body = await readJson(req);
        const u = await opts.repo.buscarUsuario(q.sessao.login);
        if (!u || !(await conferirSenha(String(body.atual ?? ''), u.senhaHash))) return send(res, 400, { erro: 'A senha atual não confere' });
        if (typeof body.nova !== 'string' || body.nova.length < SENHA_MINIMA) return send(res, 400, { erro: `A nova senha precisa ter ao menos ${SENHA_MINIMA} caracteres` });
        await opts.repo.atualizarUsuario(u.id, { senhaHash: await hashSenha(body.nova) });
        return send(res, 200, { ok: true });
      }
      if (req.method === 'GET' && (url.pathname === '/api/historico' || url.pathname === '/api/historico.csv')) {
        if (!opts.repo) return send(res, 501, { erro: 'Histórico não está ligado' });
        const data = (v: string | null, fim: boolean): Date | undefined => {
          if (!v) return undefined;
          const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T${fim ? '23:59:59.999' : '00:00:00'}` : v);
          if (Number.isNaN(d.getTime())) throw new Error('Data inválida');
          return d;
        };
        const csv = url.pathname.endsWith('.csv');
        const lista = await opts.repo.listarEncerradas({
          conta: url.searchParams.get('conta')?.trim().toUpperCase() || undefined,
          de: data(url.searchParams.get('de'), false),
          ate: data(url.searchParams.get('ate'), true),
          limite: Math.min(Math.max(Number(url.searchParams.get('limite')) || 200, 1), csv ? 5000 : 500),
        });
        const linhas = lista.map((o) => ({
          id: o.id, conta: o.conta, cliente: opts.clientes?.porConta(o.conta)?.nome ?? null, prioridade: o.prioridade,
          abertaEm: o.abertaEm.toISOString(), encerradaEm: o.encerradaEm?.toISOString() ?? null, operador: o.operador ?? null,
          motivo: o.motivo ?? null, conclusao: o.conclusao ?? null, resumo: o.eventos[0]?.description ?? '', eventos: o.eventos.length,
        }));
        if (!csv) return send(res, 200, linhas);
        const cel = (v: unknown) => { const t = v === null || v === undefined ? '' : String(v); return /[",;\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
        const cab = ['id', 'conta', 'cliente', 'prioridade', 'abertaEm', 'encerradaEm', 'operador', 'motivo', 'conclusao', 'resumo', 'eventos'] as const;
        const texto = '\ufeff' + [cab.join(';'), ...linhas.map((l) => cab.map((c) => cel(l[c])).join(';'))].join('\r\n') + '\r\n';
        return send(res, 200, texto, 'text/csv', { 'content-disposition': 'attachment; filename="historico.csv"' });
      }

      // Administração de usuários.
      if (url.pathname === '/api/usuarios' || /^\/api\/usuarios\/\d+$/.test(url.pathname)) {
        if (q.papel !== 'admin') return send(res, 403, { erro: 'Só administradores' });
        if (!opts.repo) return send(res, 501, { erro: 'Usuários não estão ligados' });
        const senhaNova = (v: unknown): string => {
          if (typeof v !== 'string' || v.length < SENHA_MINIMA) throw new Error(`A senha precisa ter ao menos ${SENHA_MINIMA} caracteres`);
          return v;
        };
        try {
          if (req.method === 'GET') return send(res, 200, (await opts.repo.listarUsuarios()).map(usuarioPublico));
          const body = await readJson(req);
          if (req.method === 'POST' && url.pathname === '/api/usuarios') {
            const u = await opts.repo.criarUsuario({
              login: String(body.login ?? ''), nome: String(body.nome ?? ''), papel: body.papel as Papel, senhaHash: await hashSenha(senhaNova(body.senha)),
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
            if (body.papel !== undefined) mudancas.papel = body.papel as Papel;
            if (typeof body.ativo === 'boolean') mudancas.ativo = body.ativo;
            if (body.senha !== undefined) mudancas.senhaHash = await hashSenha(senhaNova(body.senha));
            const u = await opts.repo.atualizarUsuario(id, mudancas);
            if (!u.ativo || mudancas.senhaHash || mudancas.papel) {
              sessoes.revogarUsuario(id);
              queue.desconectar(u.nome);
            }
            return send(res, 200, usuarioPublico(u));
          }
          return send(res, 405, { erro: 'Método não permitido' });
        } catch (err) {
          if (err instanceof LoginDuplicadoError) return send(res, 409, { erro: err.message });
          throw err;
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/ocorrencias') {
        return send(res, 200, queue.list().filter((o) => o.situacao !== 'encerrada').map((o) => resumo(o, opts.clientes?.porConta(o.conta), opts.clientes !== undefined)));
      }
      if (req.method === 'POST' && url.pathname === '/api/operadores') {
        const body = await readJson(req);
        queue.setOperator(q.nome ?? text(body.nome, 'nome'), body.disponivel === true);
        return send(res, 200, { ok: true });
      }
      const anota = /^\/api\/ocorrencias\/(\d+)\/acoes$/.exec(url.pathname);
      if (req.method === 'POST' && anota) {
        // Anotação do operador: passo do plano feito, ligação feita ou texto livre.
        const body = await readJson(req);
        const operador = q.nome ?? text(body.operador, 'operador');
        const descricao = text(body.descricao, 'descricao');
        if (descricao.length > 500) throw new Error('Anotação longa demais (máximo 500 caracteres)');
        const o = queue.get(Number(anota[1]));
        if (o.situacao !== 'em_atendimento' || o.operador !== operador) throw new Error('Ocorrência está com outro operador');
        queue.registrarAcao(o.id, operador, descricao);
        return send(res, 200, resumo(o, opts.clientes?.porConta(o.conta), opts.clientes !== undefined));
      }
      const m = /^\/api\/ocorrencias\/(\d+)\/(concluir|adiar)$/.exec(url.pathname);
      if (req.method === 'POST' && m) {
        const id = Number(m[1]);
        const body = await readJson(req);
        const operador = q.nome ?? text(body.operador, 'operador');
        if (m[2] === 'concluir') {
          const conclusao = typeof body.conclusao === 'string' ? body.conclusao : undefined;
          const o = queue.encerrar(id, operador, text(body.motivo, 'motivo'), conclusao);
          return send(res, 200, resumo(o, opts.clientes?.porConta(o.conta), opts.clientes !== undefined));
        }
        const ate = new Date(text(body.ate, 'ate'));
        if (Number.isNaN(ate.getTime())) throw new Error('Data inválida');
        const o = queue.adiar(id, operador, ate);
        return send(res, 200, resumo(o, opts.clientes?.porConta(o.conta), opts.clientes !== undefined));
      }
      if (url.pathname === '/api/clientes' || /^\/api\/clientes\/\d+$/.test(url.pathname)) {
        if (q.papel !== 'admin') return send(res, 403, { erro: 'Só administradores' });
        if (!opts.repo || !opts.clientes) return send(res, 501, { erro: 'Cadastro de clientes não está ligado' });
        if (req.method === 'GET' && url.pathname === '/api/clientes') return send(res, 200, await opts.repo.listarClientes());
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
        try {
          let cliente: Cliente;
          if (req.method === 'POST' && url.pathname === '/api/clientes') {
            cliente = await opts.repo.criarCliente(entrada(await readJson(req)));
          } else if (req.method === 'PUT') {
            cliente = await opts.repo.atualizarCliente(Number(url.pathname.split('/').pop()), entrada(await readJson(req)));
          } else {
            return send(res, 405, { erro: 'Método não permitido' });
          }
          await opts.clientes.refresh();
          return send(res, req.method === 'POST' ? 201 : 200, cliente);
        } catch (err) {
          if (err instanceof ContaDuplicadaError) return send(res, 409, { erro: err.message });
          throw err;
        }
      }
      send(res, 404, { erro: 'Não encontrado' });
    } catch (err) {
      send(res, 400, { erro: (err as Error).message });
    }
  });
}

export async function listen(server: Server, port: number, host = '0.0.0.0'): Promise<number> {
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const addr = server.address();
  return typeof addr === 'object' && addr ? addr.port : port;
}
