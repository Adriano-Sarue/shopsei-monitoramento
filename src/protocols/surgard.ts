import { parseContactId } from './contactId.js';
import type { AlarmEvent } from './types.js';

// Decodificador PROVISÓRIO do feed serial no estilo Sur-Gard (MLR2/System I-II) que o
// Active Net 3 envia ao Moni. O layout abaixo é o público e comum:
//   "5 R LLL 18 AAAA QEEE GG ZZZ S" terminado em 0x14 (DC4), onde 18 = Contact ID,
//   R = receptora, LLL = linha/grupo, AAAA = conta, S = dígito de verificação.
// Deve ser confirmado e ajustado com uma captura real do feed (ver README).
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

export function parseSurgardLine(text: string): SurgardMessage {
  const raw = text.replace(/[\x00-\x08\x0a-\x1f]/g, '').trim();
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
