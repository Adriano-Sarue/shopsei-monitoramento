export type EventCategory = 'alarm' | 'fault' | 'openclose' | 'test' | 'supervision' | 'other';
export type EventQualifier = 'new' | 'restore' | 'status';

// Evento normalizado, independente do protocolo de origem.
export interface AlarmEvent {
  receivedAt: string;
  transport: 'tcp' | 'udp';
  remote: string;
  protocol: string;
  account: string;
  receiver?: string;
  line: string;
  sequence: string;
  encrypted: boolean;
  panelTimestamp?: string;
  code: string;
  qualifier?: EventQualifier;
  partition?: string;
  zoneOrUser?: string;
  description: string;
  category: EventCategory;
  priority: number;
  raw: string;
}
