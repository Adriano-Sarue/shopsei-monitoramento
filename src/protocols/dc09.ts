import { createCipheriv, createDecipheriv, randomInt } from 'node:crypto';
import { crc16 } from './crc16.js';

// Implementação do quadro SIA DC-09 (ANSI/SIA DC-09):
//   <LF><CRC 4 hex><0LLL><"ID"><seq 4><Rrcvr><Lpref><#conta>[dados][x...]_HH:MM:SS,MM-DD-YYYY<CR>
// O CRC e o comprimento cobrem do primeiro aspas até antes do <CR>.

export interface Dc09Message {
  id: string; // ex.: ADM-CID, SIA-DCS, NULL, ACK, NAK
  encrypted: boolean;
  sequence: string;
  receiver?: string;
  line: string;
  account: string;
  data: string; // conteúdo dentro do primeiro [...], sem os colchetes
  extended: string[];
  timestamp?: string; // "HH:MM:SS,MM-DD-YYYY" (UTC)
}

export class Dc09Error extends Error {}

const LF = '\n';
const CR = '\r';
const ZERO_IV = Buffer.alloc(16, 0);

function cipherName(key: Buffer): string {
  if (![16, 24, 32].includes(key.length)) {
    throw new Dc09Error('Chave AES deve ter 128, 192 ou 256 bits');
  }
  return `aes-${key.length * 8}-cbc`;
}

export function formatTimestamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())},` +
    `${p(date.getUTCMonth() + 1)}-${p(date.getUTCDate())}-${date.getUTCFullYear()}`
  );
}

// Na mensagem criptografada o quadro mantém o "[" e segue o hexadecimal do texto cifrado.
// O texto claro (sem o "[") recebe na frente enchimento aleatório + "|", completando
// múltiplo de 16 bytes. IV zero, sem padding PKCS.
export function encryptPayload(plain: string, key: Buffer): string {
  const body = plain.startsWith('[') ? plain.slice(1) : plain;
  const padLen = 16 - ((body.length + 1) % 16 || 16);
  const padChars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let pad = '';
  for (let i = 0; i < padLen; i++) pad += padChars[randomInt(padChars.length)];
  const cipher = createCipheriv(cipherName(key), key, ZERO_IV).setAutoPadding(false);
  const out = Buffer.concat([cipher.update(`${pad}|${body}`, 'latin1'), cipher.final()]);
  return out.toString('hex').toUpperCase();
}

export function decryptPayload(hex: string, key: Buffer): string {
  if (!/^[0-9A-F]+$/i.test(hex) || hex.length % 32 !== 0) {
    throw new Dc09Error('Conteúdo criptografado inválido');
  }
  const decipher = createDecipheriv(cipherName(key), key, ZERO_IV).setAutoPadding(false);
  const plain = Buffer.concat([decipher.update(Buffer.from(hex, 'hex')), decipher.final()]).toString('latin1');
  const bar = plain.indexOf('|');
  if (bar < 0) throw new Dc09Error('Falha ao descriptografar (chave errada?)');
  return `[${plain.slice(bar + 1)}`;
}

function splitPayload(payload: string): Pick<Dc09Message, 'data' | 'extended' | 'timestamp'> {
  const blocks: string[] = [];
  let rest = payload;
  while (rest.startsWith('[')) {
    const end = rest.indexOf(']');
    if (end < 0) throw new Dc09Error('Bloco de dados sem "]"');
    blocks.push(rest.slice(1, end));
    rest = rest.slice(end + 1);
  }
  let timestamp: string | undefined;
  const ts = /^_(\d{2}:\d{2}:\d{2},\d{2}-\d{2}-\d{4})$/.exec(rest);
  if (ts) {
    timestamp = ts[1];
  } else if (rest.length > 0) {
    throw new Dc09Error(`Conteúdo inesperado após os dados: "${rest}"`);
  }
  return { data: blocks[0] ?? '', extended: blocks.slice(1), timestamp };
}

export type KeyLookup = (account: string) => Buffer | undefined;

// Recebe um quadro completo (com ou sem LF/CR nas pontas) e devolve a mensagem.
export function parseFrame(frame: string, keyFor: KeyLookup = () => undefined): Dc09Message {
  let f = frame;
  if (f.startsWith(LF)) f = f.slice(1);
  if (f.endsWith(CR)) f = f.slice(0, -1);
  const header = /^([0-9A-F]{4})0([0-9A-F]{3})(".*)$/is.exec(f);
  if (!header) throw new Dc09Error('Cabeçalho DC-09 inválido');
  const [, crcHex, lenHex, body] = header as unknown as [string, string, string, string];
  if (parseInt(lenHex, 16) !== body.length) {
    throw new Dc09Error(`Comprimento não confere (${parseInt(lenHex, 16)} != ${body.length})`);
  }
  if (parseInt(crcHex, 16) !== crc16(body)) {
    throw new Dc09Error('CRC não confere');
  }
  const m = /^"(\*?)([A-Z0-9-]+)"(\d{4})(?:R([0-9A-F]{1,6}))?L([0-9A-F]{1,6})#([0-9A-F]{1,16})(.*)$/is.exec(body);
  if (!m) throw new Dc09Error('Corpo DC-09 inválido');
  const [, star, id, sequence, receiver, line, account, payloadRaw] = m as unknown as [
    string, string, string, string, string | undefined, string, string, string,
  ];
  const encrypted = star === '*';
  let payload = payloadRaw;
  if (encrypted) {
    const key = keyFor(account);
    if (!key) throw new Dc09Error(`Mensagem criptografada da conta ${account} sem chave cadastrada`);
    if (!payloadRaw.startsWith('[')) throw new Dc09Error('Conteúdo criptografado sem "["');
    payload = decryptPayload(payloadRaw.slice(1), key);
  }
  return { id: id.toUpperCase(), encrypted, sequence, receiver, line, account, ...splitPayload(payload) };
}

export interface BuildOptions {
  key?: Buffer;
  timestamp?: Date | false;
}

export function buildFrame(msg: Omit<Dc09Message, 'encrypted' | 'timestamp' | 'extended'> & { extended?: string[] }, opts: BuildOptions = {}): string {
  const encrypted = Boolean(opts.key);
  let payload = `[${msg.data}]${(msg.extended ?? []).map((x) => `[${x}]`).join('')}`;
  // Mensagens criptografadas exigem data/hora.
  const ts = opts.timestamp === false && !encrypted ? undefined : (opts.timestamp || new Date());
  if (ts) payload += `_${formatTimestamp(ts)}`;
  if (opts.key) payload = `[${encryptPayload(payload, opts.key)}`;
  const body =
    `"${encrypted ? '*' : ''}${msg.id}"${msg.sequence}` +
    `${msg.receiver ? `R${msg.receiver}` : ''}L${msg.line}#${msg.account}${payload}`;
  const crc = crc16(body).toString(16).toUpperCase().padStart(4, '0');
  const len = body.length.toString(16).toUpperCase().padStart(3, '0');
  return `${LF}${crc}0${len}${body}${CR}`;
}

export function buildAck(msg: Dc09Message, key?: Buffer): string {
  return buildFrame(
    { id: 'ACK', sequence: msg.sequence, receiver: msg.receiver, line: msg.line, account: msg.account, data: '' },
    { key: msg.encrypted ? key : undefined, timestamp: msg.encrypted ? new Date() : false },
  );
}

// NAK sempre leva data/hora para a central acertar o relógio, e conta/linha zeradas.
export function buildNak(): string {
  return buildFrame({ id: 'NAK', sequence: '0000', receiver: '0', line: '0', account: '0', data: '' }, { timestamp: new Date() });
}

// Extrai quadros completos de um buffer TCP. Devolve os quadros e o resto incompleto.
export function extractFrames(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = [];
  let rest = buffer;
  for (;;) {
    const start = rest.indexOf(LF);
    if (start < 0) return { frames, rest: '' };
    const end = rest.indexOf(CR, start);
    if (end < 0) return { frames, rest: rest.slice(start) };
    frames.push(rest.slice(start, end + 1));
    rest = rest.slice(end + 1);
  }
}
