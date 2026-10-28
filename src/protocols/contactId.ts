import type { EventCategory, EventQualifier } from './types.js';

interface CodeInfo {
  description: string;
  category: EventCategory;
  priority: number;
}

// Tabela inicial de códigos Contact ID (SIA DC-05). Prioridade: 1 = mais urgente.
// Códigos não listados caem na faixa pelo primeiro dígito (ver fallbackByRange).
const CONTACT_ID_CODES: Record<string, CodeInfo> = {
  '100': { description: 'Emergência médica', category: 'alarm', priority: 1 },
  '110': { description: 'Incêndio', category: 'alarm', priority: 1 },
  '120': { description: 'Pânico', category: 'alarm', priority: 1 },
  '121': { description: 'Coação', category: 'alarm', priority: 1 },
  '122': { description: 'Pânico silencioso', category: 'alarm', priority: 1 },
  '130': { description: 'Disparo de alarme', category: 'alarm', priority: 2 },
  '131': { description: 'Disparo perimetral', category: 'alarm', priority: 2 },
  '132': { description: 'Disparo interno', category: 'alarm', priority: 2 },
  '133': { description: 'Disparo de zona 24h', category: 'alarm', priority: 2 },
  '134': { description: 'Disparo de entrada/saída', category: 'alarm', priority: 2 },
  '137': { description: 'Violação (tamper)', category: 'alarm', priority: 2 },
  '144': { description: 'Tamper de sensor', category: 'fault', priority: 3 },
  '301': { description: 'Falta de energia AC', category: 'fault', priority: 3 },
  '302': { description: 'Bateria baixa', category: 'fault', priority: 3 },
  '305': { description: 'Reinício da central', category: 'fault', priority: 4 },
  '321': { description: 'Falha na sirene', category: 'fault', priority: 3 },
  '350': { description: 'Falha de comunicação', category: 'fault', priority: 3 },
  '351': { description: 'Falha na linha telefônica', category: 'fault', priority: 3 },
  '354': { description: 'Falha ao comunicar evento', category: 'fault', priority: 3 },
  '380': { description: 'Falha de sensor', category: 'fault', priority: 3 },
  '384': { description: 'Bateria baixa em sensor sem fio', category: 'fault', priority: 4 },
  '400': { description: 'Abertura/fechamento', category: 'openclose', priority: 5 },
  '401': { description: 'Abertura/fechamento por usuário', category: 'openclose', priority: 5 },
  '403': { description: 'Arme/desarme automático', category: 'openclose', priority: 5 },
  '407': { description: 'Arme/desarme remoto', category: 'openclose', priority: 5 },
  '408': { description: 'Arme rápido', category: 'openclose', priority: 5 },
  '409': { description: 'Arme/desarme por chave', category: 'openclose', priority: 5 },
  '456': { description: 'Arme parcial', category: 'openclose', priority: 5 },
  '570': { description: 'Zona anulada (bypass)', category: 'other', priority: 4 },
  '601': { description: 'Teste manual', category: 'test', priority: 6 },
  '602': { description: 'Teste periódico', category: 'test', priority: 6 },
};

function fallbackByRange(code: string): CodeInfo {
  switch (code[0]) {
    case '1':
      return { description: `Alarme ${code}`, category: 'alarm', priority: 2 };
    case '2':
      return { description: `Supervisão ${code}`, category: 'fault', priority: 3 };
    case '3':
      return { description: `Problema ${code}`, category: 'fault', priority: 3 };
    case '4':
      return { description: `Abertura/fechamento ${code}`, category: 'openclose', priority: 5 };
    case '6':
      return { description: `Teste ${code}`, category: 'test', priority: 6 };
    default:
      return { description: `Evento ${code}`, category: 'other', priority: 4 };
  }
}

export interface ContactIdEvent {
  qualifier: EventQualifier;
  code: string;
  partition: string;
  zoneOrUser: string;
  description: string;
  category: EventCategory;
  priority: number;
}

const QUALIFIERS: Record<string, EventQualifier> = { '1': 'new', '3': 'restore', '6': 'status' };

// Aceita "QEEEGGZZZ" com ou sem espaços, ex.: "1131 01 015" ou "113101015".
export function parseContactId(text: string): ContactIdEvent {
  const digits = text.replace(/\s+/g, '');
  const match = /^([136])(\d{3})([0-9A-F]{2})([0-9A-F]{3})$/i.exec(digits);
  if (!match) {
    throw new Error(`Contact ID inválido: "${text}"`);
  }
  const [, q, code, partition, zone] = match as unknown as [string, string, string, string, string];
  const info = CONTACT_ID_CODES[code] ?? fallbackByRange(code);
  const qualifier = QUALIFIERS[q] ?? 'new';
  let description = info.description;
  if (info.category === 'openclose') {
    description = `${qualifier === 'new' ? 'Desarme' : 'Arme'}: ${info.description}`;
  } else if (qualifier === 'restore') {
    description = `Restauração: ${info.description}`;
  }
  return {
    qualifier,
    code,
    partition,
    zoneOrUser: zone,
    description,
    category: info.category,
    // Restauração de alarme/falha não exige atendimento urgente.
    priority: qualifier === 'restore' && info.category !== 'openclose' ? 5 : info.priority,
  };
}
