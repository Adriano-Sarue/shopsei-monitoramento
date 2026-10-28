import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
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
}

function clienteResumo(c: Cliente | undefined, completo: boolean) {
  if (!c) return null;
  return {
    id: c.id, nome: c.nome, endereco: c.endereco ?? null, tipo: c.tipo ?? null, contatos: c.contatos,
    // Palavra-chave e contra-senha só vão para quem está atendendo a ocorrência.
    palavraChave: completo ? (c.palavraChave ?? null) : null,
    contraSenha: completo ? (c.contraSenha ?? null) : null,
  };
}

function resumo(o: Ocorrencia, cliente?: Cliente) {
  const ultimo = o.eventos[o.eventos.length - 1]!;
  return {
    id: o.id,
    conta: o.conta,
    contaCadastrada: o.contaCadastrada,
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

function cookieDe(req: IncomingMessage): string | undefined {
  for (const parte of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return undefined;
}

function cookieSessao(req: IncomingMessage, token: string, maxAge: number): string {
  const seguro = req.headers['x-forwarded-proto'] === 'https' || process.env.COOKIE_SEGURO === '1';
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
      if (!url.pathname.startsWith('/api/')) return send(res, 404, { erro: 'Não encontrado' });

      // Chamadas que mudam algo só valem como JSON: formulários de outros sites não conseguem enviá-las.
      if (req.method !== 'GET' && !/^application\/json/i.test(req.headers['content-type'] ?? '')) {
        return send(res, 415, { erro: 'Use application/json' });
      }

      if (req.method === 'POST' && url.pathname === '/api/login') {
        if (!opts.repo) return send(res, 501, { erro: 'Login não está ligado' });
        const body = await readJson(req);
        const login = String(body.login ?? '').trim().toLowerCase();
        const chave = `${login}|${req.socket.remoteAddress}`;
        if (sessoes.bloqueado(chave)) return send(res, 429, { erro: 'Muitas tentativas. Aguarde alguns minutos.' });
        const u = await opts.repo.buscarUsuario(login);
        const certo = await conferirSenha(String(body.senha ?? ''), u?.senhaHash);
        if (!u || !u.ativo || !certo) {
          sessoes.registrarFalha(chave);
          return send(res, 401, { erro: 'Usuário ou senha incorretos' });
        }
        sessoes.limparFalhas(chave);
        const token = sessoes.criar({ usuarioId: u.id, login: u.login, nome: u.nome, papel: u.papel });
        return send(res, 200, usuarioPublico(u), 'application/json', { 'set-cookie': cookieSessao(req, token, 12 * 3600) });
      }
      if (!q) return send(res, 401, { erro: 'Faça login' });

      if (req.method === 'POST' && url.pathname === '/api/logout') {
        if (q.nome) queue.setOperator(q.nome, false);
        sessoes.encerrar(q.token);
        return send(res, 200, { ok: true }, 'application/json', { 'set-cookie': cookieSessao(req, '', 0) });
      }
      if (req.method === 'GET' && url.pathname === '/api/eu') {
        return send(res, 200, { login: q.sessao?.login ?? null, nome: q.nome ?? null, papel: q.papel, disponivel: q.nome ? queue.estaDisponivel(q.nome) : false });
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
              queue.setOperator(u.nome, false);
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
        return send(res, 200, queue.list().filter((o) => o.situacao !== 'encerrada').map((o) => resumo(o, opts.clientes?.porConta(o.conta))));
      }
      if (req.method === 'POST' && url.pathname === '/api/operadores') {
        const body = await readJson(req);
        queue.setOperator(q.nome ?? text(body.nome, 'nome'), body.disponivel === true);
        return send(res, 200, { ok: true });
      }
      const m = /^\/api\/ocorrencias\/(\d+)\/(concluir|adiar)$/.exec(url.pathname);
      if (req.method === 'POST' && m) {
        const id = Number(m[1]);
        const body = await readJson(req);
        const operador = q.nome ?? text(body.operador, 'operador');
        if (m[2] === 'concluir') {
          const conclusao = typeof body.conclusao === 'string' ? body.conclusao : undefined;
          const o = queue.encerrar(id, operador, text(body.motivo, 'motivo'), conclusao);
          return send(res, 200, resumo(o, opts.clientes?.porConta(o.conta)));
        }
        const ate = new Date(text(body.ate, 'ate'));
        if (Number.isNaN(ate.getTime())) throw new Error('Data inválida');
        const o = queue.adiar(id, operador, ate);
        return send(res, 200, resumo(o, opts.clientes?.porConta(o.conta)));
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
          palavraChave: typeof b.palavraChave === 'string' ? b.palavraChave : undefined,
          contraSenha: typeof b.contraSenha === 'string' ? b.contraSenha : undefined,
          contas: Array.isArray(b.contas) ? b.contas.map(String) : [],
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
