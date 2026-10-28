import type { AlarmEvent } from '../protocols/types.js';

export type Situacao = 'aguardando' | 'em_atendimento' | 'encerrada';

export interface Ocorrencia {
  id: number;
  conta: string;
  contaCadastrada: boolean;
  prioridade: number;
  situacao: Situacao;
  operador?: string;
  abertaEm: Date;
  atendidaEm?: Date;
  encerradaEm?: Date;
  motivo?: string;
  eventos: AlarmEvent[];
  acoes: { em: Date; operador?: string; descricao: string }[];
}

export interface QueueOptions {
  // Quais contas existem no cadastro. Eventos de outras contas viram ocorrência marcada.
  contaCadastrada?: (conta: string) => boolean;
  now?: () => Date;
}

// Eventos que exigem atendimento de um operador. Arme/desarme, teste e supervisão só
// ficam no histórico; restaurações encerram a ocorrência aberta da mesma conta e zona.
function exigeAtendimento(e: AlarmEvent): boolean {
  if (e.qualifier === 'restore') return false;
  return e.category === 'alarm' || e.category === 'fault' || e.category === 'other';
}

// Fila em memória; a versão com PostgreSQL segue o mesmo contrato (db/schema.sql).
export class IncidentQueue {
  private readonly incidents: Ocorrencia[] = [];
  private readonly operators = new Map<string, { disponivel: boolean }>();
  private nextId = 1;
  private readonly now: () => Date;

  constructor(private readonly opts: QueueOptions = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  setOperator(nome: string, disponivel: boolean): Ocorrencia[] {
    this.operators.set(nome, { disponivel });
    return disponivel ? this.distribute() : [];
  }

  // Recebe um evento. Devolve a ocorrência afetada, se houver.
  handleEvent(e: AlarmEvent): Ocorrencia | undefined {
    if (e.qualifier === 'restore') return this.noteRestore(e);
    if (!exigeAtendimento(e)) return undefined;

    // Eventos repetidos da mesma conta entram na ocorrência aberta em vez de criar outra.
    const open = this.incidents.find((i) => i.conta === e.account && i.situacao !== 'encerrada');
    if (open) {
      open.eventos.push(e);
      open.prioridade = Math.min(open.prioridade, e.priority);
      return open;
    }
    const incident: Ocorrencia = {
      id: this.nextId++,
      conta: e.account,
      contaCadastrada: this.opts.contaCadastrada?.(e.account) ?? true,
      prioridade: e.priority,
      situacao: 'aguardando',
      abertaEm: this.now(),
      eventos: [e],
      acoes: [],
    };
    this.incidents.push(incident);
    this.distribute();
    return incident;
  }

  private noteRestore(e: AlarmEvent): Ocorrencia | undefined {
    const open = this.incidents.find((i) => i.conta === e.account && i.situacao !== 'encerrada');
    if (!open) return undefined;
    open.eventos.push(e);
    open.acoes.push({ em: this.now(), descricao: `Restauração recebida: ${e.description}` });
    return open;
  }

  // Entrega ocorrências aguardando aos operadores livres: mais urgente e mais antiga primeiro,
  // para o operador com menos atendimentos em andamento.
  distribute(): Ocorrencia[] {
    const assigned: Ocorrencia[] = [];
    for (;;) {
      const waiting = this.waiting()[0];
      const operator = this.leastBusyOperator();
      if (!waiting || !operator) return assigned;
      waiting.situacao = 'em_atendimento';
      waiting.operador = operator;
      waiting.atendidaEm = this.now();
      assigned.push(waiting);
    }
  }

  private leastBusyOperator(): string | undefined {
    let best: string | undefined;
    let bestLoad = Infinity;
    for (const [nome, { disponivel }] of this.operators) {
      if (!disponivel) continue;
      const load = this.incidents.filter((i) => i.operador === nome && i.situacao === 'em_atendimento').length;
      if (load < bestLoad) {
        best = nome;
        bestLoad = load;
      }
    }
    // Um operador atende até 3 ocorrências ao mesmo tempo.
    return bestLoad < 3 ? best : undefined;
  }

  waiting(): Ocorrencia[] {
    return this.incidents
      .filter((i) => i.situacao === 'aguardando')
      .sort((a, b) => a.prioridade - b.prioridade || a.abertaEm.getTime() - b.abertaEm.getTime());
  }

  registrarAcao(id: number, operador: string, descricao: string): void {
    this.get(id).acoes.push({ em: this.now(), operador, descricao });
  }

  encerrar(id: number, operador: string, motivo: string): Ocorrencia {
    const incident = this.get(id);
    if (incident.operador !== operador) throw new Error('Ocorrência está com outro operador');
    incident.situacao = 'encerrada';
    incident.encerradaEm = this.now();
    incident.motivo = motivo;
    this.distribute();
    return incident;
  }

  get(id: number): Ocorrencia {
    const incident = this.incidents.find((i) => i.id === id);
    if (!incident) throw new Error(`Ocorrência ${id} não existe`);
    return incident;
  }

  list(): Ocorrencia[] {
    return [...this.incidents];
  }
}
