import type { AlarmEvent } from '../protocols/types.js';
import type { Ocorrencia } from './queue.js';

// Plano de ação padrão: os passos que o operador segue em cada tipo de evento. As instruções
// próprias de cada cliente (cadastro) aparecem acima e valem mais que este roteiro.
const PLANOS: { quando: (e: AlarmEvent) => boolean; passos: string[] }[] = [
  {
    quando: (e) => e.code === '121',
    passos: [
      'Coação: não revele ao local que o alarme chegou',
      'Acionar a Polícia (190) imediatamente',
      'Avisar as providências, sem deixar recado',
      'Registrar o desfecho',
    ],
  },
  {
    quando: (e) => e.code === '120' || e.code === '122',
    passos: [
      'Acionar a Polícia (190) imediatamente',
      'Conferir as câmeras do cliente, se houver',
      'Ligar para o local e pedir a palavra-chave',
      'Ligar para as providências em ordem',
      'Registrar o desfecho',
    ],
  },
  {
    quando: (e) => e.code.startsWith('11'),
    passos: [
      'Ligar para o local',
      'Confirmado ou sem resposta: acionar os Bombeiros (193)',
      'Ligar para as providências em ordem',
      'Registrar o desfecho',
    ],
  },
  {
    quando: (e) => e.code.startsWith('10'),
    passos: ['Ligar para o local', 'Confirmado ou sem resposta: acionar o SAMU (192)', 'Ligar para as providências em ordem', 'Registrar o desfecho'],
  },
  {
    quando: (e) => e.category === 'alarm',
    passos: [
      'Conferir as câmeras do cliente, se houver',
      'Ligar para o local e pedir a palavra-chave',
      'Sem resposta ou palavra-chave errada: ligar para as providências em ordem',
      'Ninguém confirma ou há suspeita: acionar a Polícia (190) ou a equipe de apoio',
      'Registrar o desfecho',
    ],
  },
  {
    quando: (e) => ['250', '350', '351', '354', 'TST'].includes(e.code),
    passos: [
      'Ver se outras contas também pararam (pode ser o Active Net ou a internet da central)',
      'Ligar para o cliente e informar a falha',
      'Persistindo: abrir ordem de serviço para o técnico',
      'Registrar o desfecho',
    ],
  },
  {
    quando: (e) => ['301', '302', '313', '384'].includes(e.code),
    passos: [
      'Ver se já chegou a restauração',
      'Ligar para o cliente e informar a falha de energia ou bateria',
      'Persistindo: abrir ordem de serviço para o técnico',
      'Registrar o desfecho',
    ],
  },
  {
    quando: () => true,
    passos: ['Conferir os eventos da conta', 'Ligar para o cliente e informar', 'Registrar o desfecho'],
  },
];

export const PREFIXO_PASSO = 'Passo concluído: ';

export function planoPara(o: Ocorrencia, contaCadastrada: boolean): string[] {
  // O plano segue o evento mais urgente da ocorrência.
  const principal = [...o.eventos].filter((e) => e.qualifier !== 'restore').sort((a, b) => a.priority - b.priority)[0] ?? o.eventos[0]!;
  const passos = PLANOS.find((p) => p.quando(principal))!.passos;
  return contaCadastrada ? passos : ['Conta não cadastrada: identificar o cliente e cadastrar', ...passos];
}

// Evento gerado pelo próprio sistema (ex.: falta de teste periódico), no mesmo formato dos que chegam das centrais.
export function eventoInterno(conta: string, code: string, description: string, agora: Date): AlarmEvent {
  return {
    receivedAt: agora.toISOString(), transport: 'tcp', remote: 'sistema', protocol: 'INTERNO', account: conta, line: '0',
    sequence: '0000', encrypted: false, code, qualifier: 'new', description, category: 'fault', priority: 3, raw: '',
  };
}
