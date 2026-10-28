import { parseContactId } from './contactId.js';
import type { Dc09Message } from './dc09.js';
import { parseSia } from './sia.js';
import type { AlarmEvent } from './types.js';

export interface Origin {
  transport: 'tcp' | 'udp';
  remote: string;
  raw: string;
  receivedAt?: Date;
}

// O bloco de dados costuma vir como "#conta|conteúdo"; algumas centrais omitem "#conta|".
function stripAccount(data: string): string {
  const bar = data.indexOf('|');
  return data.startsWith('#') && bar >= 0 ? data.slice(bar + 1) : data;
}

// Converte uma mensagem DC-09 em evento normalizado. Protocolos ainda não suportados
// (por exemplo um formato próprio da JFL) entram como "other" com o conteúdo bruto,
// para nunca perder um evento.
export function toAlarmEvent(msg: Dc09Message, origin: Origin): AlarmEvent {
  const base = {
    receivedAt: (origin.receivedAt ?? new Date()).toISOString(),
    transport: origin.transport,
    remote: origin.remote,
    protocol: msg.id,
    account: msg.account,
    receiver: msg.receiver,
    line: msg.line,
    sequence: msg.sequence,
    encrypted: msg.encrypted,
    panelTimestamp: msg.timestamp,
    raw: origin.raw,
  };
  const content = stripAccount(msg.data);

  if (msg.id === 'NULL') {
    return { ...base, code: 'NULL', description: 'Teste de supervisão do link', category: 'supervision', priority: 7 };
  }
  try {
    if (msg.id === 'ADM-CID') {
      return { ...base, ...parseContactId(content) };
    }
    if (msg.id === 'SIA-DCS') {
      return { ...base, ...parseSia(content) };
    }
  } catch (err) {
    return { ...base, code: '???', description: `Evento não decodificado: ${(err as Error).message}`, category: 'other', priority: 3 };
  }
  return { ...base, code: msg.id, description: `Protocolo ${msg.id} ainda não suportado: ${content}`, category: 'other', priority: 3 };
}
