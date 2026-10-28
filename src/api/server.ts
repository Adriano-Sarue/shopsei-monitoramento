import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { IncidentQueue, Ocorrencia } from '../incidents/queue.js';
import { ContaDuplicadaError, type Cliente, type ClienteIndex, type NovoCliente, type Repositorio } from '../store/repositorio.js';

export interface ApiOptions {
  // Token compartilhado exigido em todas as chamadas /api (cabeçalho Authorization: Bearer).
  token: string;
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

function tokenOk(req: IncomingMessage, token: string): boolean {
  const given = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
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

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json'): void {
  res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function text(v: unknown, campo: string): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`Campo "${campo}" é obrigatório`);
  return v.trim();
}

export function createApi(queue: IncidentQueue, opts: ApiOptions): Server {
  if (!opts.token) throw new Error('Token do console não definido');

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const pagina = url.pathname === '/' ? 'index.html' : url.pathname === '/index.html' || url.pathname === '/clientes.html' ? url.pathname.slice(1) : undefined;
      if (req.method === 'GET' && pagina) {
        return send(res, 200, await readFile(join(opts.publicDir, pagina), 'utf8'), 'text/html');
      }
      if (!url.pathname.startsWith('/api/')) return send(res, 404, { erro: 'Não encontrado' });
      if (!tokenOk(req, opts.token)) return send(res, 401, { erro: 'Token inválido' });

      if (req.method === 'GET' && url.pathname === '/api/ocorrencias') {
        return send(res, 200, queue.list().filter((o) => o.situacao !== 'encerrada').map((o) => resumo(o, opts.clientes?.porConta(o.conta))));
      }
      if (req.method === 'POST' && url.pathname === '/api/operadores') {
        const body = await readJson(req);
        queue.setOperator(text(body.nome, 'nome'), body.disponivel === true);
        return send(res, 200, { ok: true });
      }
      const m = /^\/api\/ocorrencias\/(\d+)\/(concluir|adiar)$/.exec(url.pathname);
      if (req.method === 'POST' && m) {
        const id = Number(m[1]);
        const body = await readJson(req);
        const operador = text(body.operador, 'operador');
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
