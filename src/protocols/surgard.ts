import { parseContactId } from './contactId.js';
import type { AlarmEvent } from './types.js';

// Decodificador do feed serial no estilo Sur-Gard que o Active Net 3 envia ao Moni.
// Formato observado no Monitor.Txt da Shop Sei (mensagem sem espaços internos):
//   "5011 180043E13001003" = cabeçalho "5RLL", espaço, "18" (Contact ID), conta (4),
//   E (evento novo) ou R (restauração), código (3), partição (2) e zona/usuário (3).
// Também aceita o layout público com espaços ("5 1 011 18 1234 1130 01 003 8").
// Ainda falta validar com tráfego recente (o Monitor.Txt vai só até 03/12/2024).
export const SURGARD_ACK = Buffer.from([0x06]);
export const SURGARD_NAK = Buffer.from([0x15]);
const TERMINATOR = 0x14;

export interface SurgardMessage {
  receiver: string;
  line: string;
  account: string;
  event: string; // "QEEE GG ZZZ", como no Contact ID
  raw: string;
}

const COMPACT = /^5(\d)(\d{2,3})\s+18([0-9A-F]{4})([ER])(\d{3})(\d{2})([0-9A-F]{3})/i;

export function parseSurgardLine(text: string): SurgardMessage {
  const raw = text.replace(/[\x00-\x08\x0a-\x1f]/g, '').trim();
  const compact = COMPACT.exec(raw);
  if (compact) {
    const [, receiver, line, account, flag, code, partition, zone] = compact as unknown as string[];
    const qualifier = flag!.toUpperCase() === 'R' ? '3' : '1';
    return { receiver: receiver!, line: line!, account: account!, event: `${qualifier}${code} ${partition} ${zone}`, raw };
  }
  const tokens = raw.split(/\s+/);
  // tokens: ["5", R, LLL, "18", AAAA, QEEE, GG, ZZZ, S?]
  const fmt = tokens.indexOf('18');
  if (fmt < 2 || tokens.length < fmt + 5) {
    throw new Error(`Formato Sur-Gard não reconhecido: "${raw}"`);
  }
  const account = tokens[fmt + 1]!;
  const event = tokens.slice(fmt + 2, fmt + 5).join(' ');
  return {
    receiver: tokens[fmt - 2] ?? '',
    line: tokens[fmt - 1] ?? '',
    account,
    event,
    raw,
  };
}

export function surgardToAlarmEvent(msg: SurgardMessage, remote: string, receivedAt = new Date()): AlarmEvent {
  const base = {
    receivedAt: receivedAt.toISOString(),
    transport: 'tcp' as const,
    remote,
    protocol: 'SURGARD',
    account: msg.account,
    receiver: msg.receiver,
    line: msg.line,
    sequence: '0000',
    encrypted: false,
    raw: msg.raw,
  };
  try {
    return { ...base, ...parseContactId(msg.event) };
  } catch (err) {
    return { ...base, code: '???', description: `Evento não decodificado: ${(err as Error).message}`, category: 'other', priority: 3 };
  }
}

// Extrai mensagens de um fluxo de bytes, separadas por 0x14 (ou por quebra de linha).
export function extractSurgardLines(buffer: Buffer): { lines: string[]; rest: Buffer } {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i++) {
    const b = buffer[i];
    if (b === TERMINATOR || b === 0x0a || b === 0x0d) {
      if (i > start) lines.push(buffer.subarray(start, i).toString('latin1'));
      start = i + 1;
    }
  }
  return { lines, rest: buffer.subarray(start) };
}
