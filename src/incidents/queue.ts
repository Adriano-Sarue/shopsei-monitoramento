import type { AlarmEvent } from '../protocols/types.js';

export type Situacao = 'aguardando' | 'pendente' | 'em_atendimento' | 'encerrada';

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
  conclusao?: string;
  // Preenchido quando o operador adia: volta a "aguardando" a partir desse horário.
  adiadaAte?: Date;
  eventos: AlarmEvent[];
  acoes: { em: Date; operador?: string; descricao: string }[];
}

export interface QueueOptions {
  // Quais contas existem no cadastro. Eventos de outras contas viram ocorrência marcada.
  contaCadastrada?: (conta: string) => boolean;
  now?: () => Date;
  // Chamado a cada mudança de uma ocorrência (criar, atribuir, anotar, adiar, concluir).
  onChange?: (o: Ocorrencia) => void;
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

  private changed(o: Ocorrencia): void {
    this.opts.onChange?.(o);
  }

  // Recarrega ocorrências abertas gravadas (na inicialização). Não distribui nada.
  restore(lista: Ocorrencia[]): void {
    for (const o of lista) {
      if (o.situacao === 'em_atendimento') {
        // Sem operador logado após o reinício: volta para a fila.
        o.situacao = 'aguardando';
        o.operador = undefined;
      }
      this.incidents.push(o);
      this.nextId = Math.max(this.nextId, o.id + 1);
    }
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
      this.changed(open);
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
    this.changed(incident);
    this.distribute();
    return incident;
  }

  private noteRestore(e: AlarmEvent): Ocorrencia | undefined {
    const open = this.incidents.find((i) => i.conta === e.account && i.situacao !== 'encerrada');
    if (!open) return undefined;
    open.eventos.push(e);
    open.acoes.push({ em: this.now(), descricao: `Restauração recebida: ${e.description}` });
    this.changed(open);
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
      this.changed(waiting);
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
    const incident = this.get(id);
    incident.acoes.push({ em: this.now(), operador, descricao });
    this.changed(incident);
  }

  // Adia a ocorrência: sai do operador e fica "pendente" até o horário informado.
  adiar(id: number, operador: string, ate: Date): Ocorrencia {
    const incident = this.get(id);
    if (incident.operador !== operador) throw new Error('Ocorrência está com outro operador');
    incident.situacao = 'pendente';
    incident.adiadaAte = ate;
    incident.operador = undefined;
    incident.acoes.push({ em: this.now(), operador, descricao: `Adiada até ${ate.toISOString()}` });
    this.changed(incident);
    this.distribute();
    return incident;
  }

  // Devolve à fila as ocorrências adiadas cujo prazo venceu. Chamar periodicamente.
  reativarVencidas(): Ocorrencia[] {
    const agora = this.now();
    const vencidas = this.incidents.filter((i) => i.situacao === 'pendente' && i.adiadaAte && i.adiadaAte <= agora);
    for (const i of vencidas) {
      i.situacao = 'aguardando';
      i.adiadaAte = undefined;
      this.changed(i);
    }
    this.distribute();
    return vencidas;
  }

  // Ações em lote (tela "Ações para eventos selecionados"): concluir ou agendar várias
  // ocorrências de uma vez, inclusive as que ainda não estão com ninguém. As que estão
  // com outro operador são ignoradas e devolvidas em "ignoradas".
  concluirEmLote(ids: number[], operador: string, motivo: string, conclusao?: string): { concluidas: Ocorrencia[]; ignoradas: number[] } {
    const concluidas: Ocorrencia[] = [];
    const ignoradas: number[] = [];
    for (const id of ids) {
      const incident = this.get(id);
      if (incident.situacao === 'encerrada' || (incident.operador && incident.operador !== operador)) {
        ignoradas.push(id);
        continue;
      }
      incident.situacao = 'encerrada';
      incident.operador = operador;
      incident.encerradaEm = this.now();
      incident.motivo = motivo;
      incident.conclusao = conclusao;
      this.changed(incident);
      concluidas.push(incident);
    }
    this.distribute();
    return { concluidas, ignoradas };
  }

  agendarEmLote(ids: number[], operador: string, ate: Date): { agendadas: Ocorrencia[]; ignoradas: number[] } {
    const agendadas: Ocorrencia[] = [];
    const ignoradas: number[] = [];
    for (const id of ids) {
      const incident = this.get(id);
      if (incident.situacao === 'encerrada' || (incident.operador && incident.operador !== operador)) {
        ignoradas.push(id);
        continue;
      }
      incident.situacao = 'pendente';
      incident.adiadaAte = ate;
      incident.operador = undefined;
      incident.acoes.push({ em: this.now(), operador, descricao: `Agendada para ${ate.toISOString()}` });
      this.changed(incident);
      agendadas.push(incident);
    }
    this.distribute();
    return { agendadas, ignoradas };
  }

  encerrar(id: number, operador: string, motivo: string, conclusao?: string): Ocorrencia {
    const incident = this.get(id);
    if (incident.operador !== operador) throw new Error('Ocorrência está com outro operador');
    incident.situacao = 'encerrada';
    incident.encerradaEm = this.now();
    incident.motivo = motivo;
    incident.conclusao = conclusao;
    this.changed(incident);
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
