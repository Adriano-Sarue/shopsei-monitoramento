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
    quando: (e) => ['137', '144', '145', '341', '383', '344', '461', '413', 'TA', 'JA'].includes(e.code),
    passos: [
      'Violação de equipamento ou senha errada: pode ser tentativa de sabotagem',
      'Conferir as câmeras do cliente, se houver',
      'Ligar para o local e pedir a palavra-chave',
      'Sem confirmação: tratar como disparo (providências e Polícia ou equipe de apoio)',
      'Confirmado pelo cliente: abrir ordem de serviço para o técnico, se preciso',
      'Registrar o desfecho',
    ],
  },
  {
    quando: (e) => ['306', '412', '625', '627', '628', 'LB', 'LX'].includes(e.code),
    passos: [
      'Conferir se havia técnico da empresa mexendo na central agora',
      'Ninguém autorizado: ligar para o cliente e pedir a palavra-chave',
      'Sem explicação: tratar como violação e avisar o responsável técnico',
      'Registrar o desfecho',
    ],
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
    quando: (e) => ['301', '302', '309', '311', '313', '342', '384', 'AT', 'YT', 'XT'].includes(e.code),
    passos: [
      'Ver se já chegou a restauração',
      'Ligar para o cliente e informar a falha de energia ou bateria (bateria de sensor: trocar a pilha do sensor indicado na zona)',
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

// O evento mais urgente da ocorrência (o primeiro, em empate), sem contar restaurações.
export function eventoPrincipal(o: Ocorrencia): AlarmEvent {
  return [...o.eventos].filter((e) => e.qualifier !== 'restore').sort((a, b) => a.priority - b.priority)[0] ?? o.eventos[0]!;
}

// Título da ocorrência na fila: o evento principal, avisando se ele já foi restaurado.
export function tituloOcorrencia(o: Ocorrencia): string {
  const p = eventoPrincipal(o);
  const i = o.eventos.indexOf(p);
  const restaurado = p.qualifier !== 'restore' && o.eventos.slice(i + 1).some((e) => e.qualifier === 'restore' && e.code === p.code && e.zoneOrUser === p.zoneOrUser);
  return restaurado ? `${p.description} (já restaurado)` : p.description;
}

export function planoPara(o: Ocorrencia, contaCadastrada: boolean): string[] {
  // O plano segue o evento mais urgente da ocorrência.
  const principal = eventoPrincipal(o);
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
