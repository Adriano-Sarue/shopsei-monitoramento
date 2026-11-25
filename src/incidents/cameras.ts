import { fetchDigest } from '../portaria/digest.js';

// Foto de câmera para mostrar dentro da ocorrência e anexar ao atendimento. O endereço é o de "foto" (snapshot) do
// gravador ou da câmera; usuário e senha podem vir no próprio endereço (http://usuario:senha@ip/...). A autenticação
// pode ser Digest (Hikvision, Intelbras) ou Basic.

export class ErroFoto extends Error {}

export const TIPOS_IMAGEM = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const MAX_FOTO = 3 * 1024 * 1024;

export interface Foto {
  tipo: string;
  dados: Buffer;
}

// Confere os primeiros bytes: o tipo declarado tem que bater com o arquivo.
function assinaturaOk(tipo: string, d: Buffer): boolean {
  if (tipo === 'image/jpeg') return d[0] === 0xff && d[1] === 0xd8;
  if (tipo === 'image/png') return d.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (tipo === 'image/webp') return d.subarray(0, 4).toString('latin1') === 'RIFF' && d.subarray(8, 12).toString('latin1') === 'WEBP';
  return false;
}

export async function buscarFoto(endereco: string, timeoutMs = 5000): Promise<Foto> {
  let alvo: URL;
  try {
    alvo = new URL(endereco);
  } catch {
    throw new ErroFoto('Endereço da foto da câmera inválido');
  }
  if (alvo.protocol !== 'http:' && alvo.protocol !== 'https:') throw new ErroFoto('Endereço da foto da câmera inválido');
  const usuario = decodeURIComponent(alvo.username);
  const senha = decodeURIComponent(alvo.password);
  alvo.username = '';
  alvo.password = '';
  let r: Response;
  try {
    r = usuario
      ? await fetchDigest(alvo.toString(), { usuario, senha, timeoutMs })
      : await fetch(alvo, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new ErroFoto('A câmera não respondeu (confira a internet do cliente ou a VPN)');
  }
  if (r.status === 401 || r.status === 403) throw new ErroFoto('A câmera recusou o usuário e a senha');
  if (!r.ok) throw new ErroFoto(`A câmera respondeu erro ${r.status}`);
  const tipo = (r.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!(TIPOS_IMAGEM as readonly string[]).includes(tipo)) throw new ErroFoto('O endereço não devolveu uma foto (JPEG ou PNG)');
  const dados = Buffer.from(await r.arrayBuffer());
  if (dados.length > MAX_FOTO) throw new ErroFoto('Foto grande demais');
  if (!assinaturaOk(tipo, dados)) throw new ErroFoto('O endereço não devolveu uma foto (JPEG ou PNG)');
  return { tipo, dados };
}

// Imagem colada pelo operador (print da tela da câmera, foto do celular): "data:image/jpeg;base64,...".
export function lerImagemColada(v: unknown): Foto {
  const m = typeof v === 'string' ? /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(v) : null;
  if (!m) throw new ErroFoto('Imagem inválida (use JPEG, PNG ou WebP)');
  const dados = Buffer.from(m[2]!, 'base64');
  if (!dados.length) throw new ErroFoto('Imagem vazia');
  if (dados.length > MAX_FOTO) throw new ErroFoto('Imagem grande demais (máximo 3 MB)');
  if (!assinaturaOk(m[1]!, dados)) throw new ErroFoto('Imagem inválida (use JPEG, PNG ou WebP)');
  return { tipo: m[1]!, dados };
}
