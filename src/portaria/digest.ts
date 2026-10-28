import { createHash, randomBytes } from 'node:crypto';

// Requisição HTTP com autenticação Digest (RFC 7616, MD5, qop=auth), que é o que os equipamentos Hikvision
// exigem na ISAPI. A primeira chamada recebe o desafio (401) e a segunda vai assinada.

export interface OpcoesDigest {
  method?: string;
  body?: string;
  headers?: Record<string, string>;
  usuario: string;
  senha: string;
  timeoutMs?: number;
}

const md5 = (t: string) => createHash('md5').update(t).digest('hex');

function lerDesafio(cabecalho: string): Record<string, string> {
  const campos: Record<string, string> = {};
  for (const m of cabecalho.replace(/^Digest\s+/i, '').matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) campos[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? '';
  return campos;
}

export function autorizacaoDigest(desafio: string, metodo: string, uri: string, usuario: string, senha: string, cnonce = randomBytes(8).toString('hex'), nc = '00000001'): string {
  const d = lerDesafio(desafio);
  if (d.algorithm && !/^md5$/i.test(d.algorithm)) throw new Error(`Algoritmo de autenticação não suportado: ${d.algorithm}`);
  const ha1 = md5(`${usuario}:${d.realm ?? ''}:${senha}`);
  const ha2 = md5(`${metodo}:${uri}`);
  const qop = d.qop?.split(',').map((x) => x.trim()).includes('auth') ? 'auth' : undefined;
  const resposta = qop ? md5(`${ha1}:${d.nonce}:${nc}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${d.nonce}:${ha2}`);
  const partes = [`username="${usuario}"`, `realm="${d.realm ?? ''}"`, `nonce="${d.nonce ?? ''}"`, `uri="${uri}"`, `response="${resposta}"`];
  if (d.opaque !== undefined) partes.push(`opaque="${d.opaque}"`);
  if (qop) partes.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (d.algorithm) partes.push(`algorithm=${d.algorithm}`);
  return `Digest ${partes.join(', ')}`;
}

export async function fetchDigest(url: string, o: OpcoesDigest): Promise<Response> {
  const metodo = o.method ?? 'GET';
  const alvo = new URL(url);
  const uri = alvo.pathname + alvo.search;
  const chamar = (extra: Record<string, string> = {}) => fetch(url, {
    method: metodo, body: o.body, headers: { ...o.headers, ...extra }, signal: AbortSignal.timeout(o.timeoutMs ?? 5000),
  });
  const primeira = await chamar();
  if (primeira.status !== 401) return primeira;
  const desafio = primeira.headers.get('www-authenticate') ?? '';
  await primeira.arrayBuffer().catch(() => undefined);
  if (/^Basic/i.test(desafio)) {
    return chamar({ authorization: `Basic ${Buffer.from(`${o.usuario}:${o.senha}`).toString('base64')}` });
  }
  if (!/^Digest/i.test(desafio)) return primeira;
  return chamar({ authorization: autorizacaoDigest(desafio, metodo, uri, o.usuario, o.senha) });
}
