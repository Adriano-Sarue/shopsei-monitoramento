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
  '144': { description: 'Tamper de sensor (tampa aberta)', category: 'fault', priority: 3 },
  '145': { description: 'Tamper de módulo de expansão', category: 'fault', priority: 3 },
  '250': { description: 'Falha de keep alive', category: 'fault', priority: 3 },
  '301': { description: 'Falha AC', category: 'fault', priority: 3 },
  '302': { description: 'Bateria baixa', category: 'fault', priority: 3 },
  '305': { description: 'Reinício da central', category: 'fault', priority: 4 },
  '306': { description: 'Programação da central alterada', category: 'fault', priority: 4 },
  '307': { description: 'Falha no autoteste da central', category: 'fault', priority: 3 },
  '309': { description: 'Falha no teste da bateria', category: 'fault', priority: 3 },
  '311': { description: 'Bateria descarregada ou ausente', category: 'fault', priority: 3 },
  '313': { description: 'Falha na restauração da bateria', category: 'fault', priority: 3 },
  '321': { description: 'Falha na sirene', category: 'fault', priority: 3 },
  '333': { description: 'Falha em módulo de expansão', category: 'fault', priority: 3 },
  '341': { description: 'Tamper de módulo expansor', category: 'fault', priority: 3 },
  '342': { description: 'Falha AC em módulo expansor', category: 'fault', priority: 3 },
  '344': { description: 'Interferência no receptor sem fio (jammer)', category: 'fault', priority: 2 },
  '350': { description: 'Falha de comunicação', category: 'fault', priority: 3 },
  '351': { description: 'Falha na linha telefônica', category: 'fault', priority: 3 },
  '354': { description: 'Falha ao comunicar evento', category: 'fault', priority: 3 },
  '360': { description: 'Restauração na supervisão da central', category: 'supervision', priority: 5 },
  '373': { description: 'Falha no circuito de incêndio', category: 'fault', priority: 3 },
  '380': { description: 'Falha de sensor', category: 'fault', priority: 3 },
  '381': { description: 'Perda de supervisão de sensor sem fio', category: 'fault', priority: 3 },
  '383': { description: 'Tamper de sensor (tampa aberta)', category: 'fault', priority: 3 },
  '384': { description: 'Bateria baixa em sensor sem fio', category: 'fault', priority: 4 },
  '400': { description: 'Arme/desarme', category: 'openclose', priority: 5 },
  '401': { description: 'Arme/desarme pelo usuário', category: 'openclose', priority: 5 },
  '403': { description: 'Arme/desarme automático', category: 'openclose', priority: 5 },
  '407': { description: 'Arme/desarme remoto', category: 'openclose', priority: 5 },
  '408': { description: 'Arme rápido', category: 'openclose', priority: 5 },
  '409': { description: 'Arme/desarme por chave', category: 'openclose', priority: 5 },
  '411': { description: 'Pedido de retorno (callback)', category: 'other', priority: 5 },
  '412': { description: 'Programação remota da central', category: 'fault', priority: 4 },
  '413': { description: 'Tentativa de acesso remoto sem sucesso', category: 'fault', priority: 3 },
  '421': { description: 'Acesso negado', category: 'other', priority: 4 },
  '441': { description: 'Arme/desarme em modo parcial (stay)', category: 'openclose', priority: 5 },
  '456': { description: 'Arme parcial', category: 'openclose', priority: 5 },
  '461': { description: 'Senha errada digitada', category: 'other', priority: 4 },
  '570': { description: 'Zona anulada (bypass)', category: 'other', priority: 4 },
  '601': { description: 'Teste manual', category: 'test', priority: 6 },
  '602': { description: 'Auto teste', category: 'test', priority: 6 },
  '625': { description: 'Data e hora da central alteradas', category: 'fault', priority: 4 },
  '627': { description: 'Entrada no modo de programação', category: 'fault', priority: 4 },
  '628': { description: 'Saída do modo de programação', category: 'fault', priority: 4 },
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
      // Só 40x, 44x e 45x são arme/desarme; 41x (acesso remoto), 42x (acesso) e 46x (senha) pedem atenção.
      if ('045'.includes(code[1]!)) return { description: `Arme/desarme ${code}`, category: 'openclose', priority: 5 };
      return { description: `Evento ${code}`, category: 'other', priority: 4 };
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
    // Contact ID: E (novo) é abertura = desarme; R (restauração) é fechamento = arme.
    const acao = qualifier === 'new' ? 'Desarme' : 'Arme';
    if (info.description.startsWith('Arme/desarme')) description = acao + info.description.slice('Arme/desarme'.length);
    else if (!info.description.startsWith(acao)) description = `${acao}: ${info.description}`;
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
