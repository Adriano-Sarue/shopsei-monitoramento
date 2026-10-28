import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import type { IncidentQueue, Ocorrencia } from '../incidents/queue.js';

export interface ApiOptions {
  // Token compartilhado exigido em todas as chamadas /api (cabeçalho Authorization: Bearer).
  token: string;
  publicDir: string;
  host?: string;
  port: number;
}

function resumo(o: Ocorrencia) {
  const ultimo = o.eventos[o.eventos.length - 1]!;
  return {
    id: o.id,
    conta: o.conta,
    contaCadastrada: o.contaCadastrada,
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
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return send(res, 200, await readFile(join(opts.publicDir, 'index.html'), 'utf8'), 'text/html');
      }
      if (!url.pathname.startsWith('/api/')) return send(res, 404, { erro: 'Não encontrado' });
      if (!tokenOk(req, opts.token)) return send(res, 401, { erro: 'Token inválido' });

      if (req.method === 'GET' && url.pathname === '/api/ocorrencias') {
        return send(res, 200, queue.list().filter((o) => o.situacao !== 'encerrada').map(resumo));
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
          const o = queue.encerrar(id, operador, text(body.motivo, 'motivo'));
          if (typeof body.conclusao === 'string') o.conclusao = body.conclusao;
          return send(res, 200, resumo(o));
        }
        const ate = new Date(text(body.ate, 'ate'));
        if (Number.isNaN(ate.getTime())) throw new Error('Data inválida');
        return send(res, 200, resumo(queue.adiar(id, operador, ate)));
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
