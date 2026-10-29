import type { EventCategory, EventQualifier } from './types.js';

interface SiaCodeInfo {
  description: string;
  category: EventCategory;
  priority: number;
  qualifier?: EventQualifier;
}

// Subconjunto inicial dos códigos SIA (DC-03) mais comuns.
const SIA_CODES: Record<string, SiaCodeInfo> = {
  BA: { description: 'Disparo de alarme', category: 'alarm', priority: 2 },
  BR: { description: 'Restauração de alarme', category: 'alarm', priority: 5, qualifier: 'restore' },
  BB: { description: 'Zona anulada (bypass)', category: 'other', priority: 4 },
  FA: { description: 'Incêndio', category: 'alarm', priority: 1 },
  FR: { description: 'Restauração de incêndio', category: 'alarm', priority: 5, qualifier: 'restore' },
  PA: { description: 'Pânico', category: 'alarm', priority: 1 },
  PR: { description: 'Restauração de pânico', category: 'alarm', priority: 5, qualifier: 'restore' },
  HA: { description: 'Coação', category: 'alarm', priority: 1 },
  MA: { description: 'Emergência médica', category: 'alarm', priority: 1 },
  TA: { description: 'Violação (tamper)', category: 'alarm', priority: 2 },
  TR: { description: 'Restauração de tamper', category: 'alarm', priority: 5, qualifier: 'restore' },
  AT: { description: 'Falta de energia AC', category: 'fault', priority: 3 },
  AR: { description: 'Restauração de energia AC', category: 'fault', priority: 5, qualifier: 'restore' },
  YT: { description: 'Bateria baixa', category: 'fault', priority: 3 },
  YR: { description: 'Restauração de bateria', category: 'fault', priority: 5, qualifier: 'restore' },
  XT: { description: 'Bateria baixa em sensor sem fio', category: 'fault', priority: 4 },
  XR: { description: 'Restauração de bateria de sensor sem fio', category: 'fault', priority: 5, qualifier: 'restore' },
  LB: { description: 'Entrada no modo de programação', category: 'fault', priority: 4 },
  LX: { description: 'Saída do modo de programação', category: 'fault', priority: 4 },
  JA: { description: 'Senha errada digitada', category: 'other', priority: 4 },
  YC: { description: 'Central sem comunicação (falha de comunicação)', category: 'fault', priority: 3 },
  OP: { description: 'Desarme (abertura)', category: 'openclose', priority: 5, qualifier: 'new' },
  CL: { description: 'Arme (fechamento)', category: 'openclose', priority: 5, qualifier: 'restore' },
  OA: { description: 'Desarme automático', category: 'openclose', priority: 5, qualifier: 'new' },
  CA: { description: 'Arme automático', category: 'openclose', priority: 5, qualifier: 'restore' },
  RP: { description: 'Teste periódico', category: 'test', priority: 6 },
  RX: { description: 'Teste manual', category: 'test', priority: 6 },
};

export interface SiaEvent {
  code: string;
  zoneOrUser?: string;
  partition?: string;
  qualifier?: EventQualifier;
  description: string;
  category: EventCategory;
  priority: number;
}

// Interpreta o conteúdo SIA-DCS após "#conta|", ex.: "Nri1/BA015" ou "NBA015".
// Quando a mensagem traz vários eventos, usa o primeiro.
export function parseSia(text: string): SiaEvent {
  let body = text.trim();
  if (body.startsWith('N')) body = body.slice(1);
  let partition: string | undefined;
  const fields = body.split('/');
  let eventField: string | undefined;
  for (const field of fields) {
    const ri = /^ri(\d+)$/i.exec(field);
    if (ri) {
      partition = ri[1];
      continue;
    }
    if (/^[A-Z]{2}/.test(field)) {
      eventField = field;
      break;
    }
  }
  if (!eventField) {
    throw new Error(`SIA inválido: "${text}"`);
  }
  const code = eventField.slice(0, 2);
  const zone = eventField.slice(2).replace(/^\^.*$/, '') || undefined;
  const info = SIA_CODES[code] ?? { description: `Evento SIA ${code}`, category: 'other' as const, priority: 4 };
  return {
    code,
    zoneOrUser: zone,
    partition,
    qualifier: info.qualifier,
    description: info.description,
    category: info.category,
    priority: info.priority,
  };
}
