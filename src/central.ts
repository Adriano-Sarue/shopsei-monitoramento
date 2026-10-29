import { IncidentQueue, type Ocorrencia, type QueueOptions } from './incidents/queue.js';
import { CONTA_BASE } from './incidents/planos.js';
import { SupervisaoTeste } from './incidents/supervisao.js';
import type { AlarmEvent } from './protocols/types.js';
import { AJUSTES_PADRAO, ClienteIndex, normalizarNumero, type Empresa, type Repositorio, type Rota } from './store/repositorio.js';

export type Canal = Rota['canal'];

// Decide de qual empresa é um evento pela receptora e linha que a central usou. A rota mais específica
// ganha: número exato vale mais que "*". Sem rota, o evento não é de ninguém e não entra em fila nenhuma.
export class Roteador {
  constructor(private readonly empresas: Empresa[]) {}

  empresaDe(canal: Canal, receptora: string | undefined, linha: string | undefined): number | undefined {
    const rec = normalizarNumero(receptora);
    const lin = normalizarNumero(linha);
    let melhor: { empresa: number; pontos: number } | undefined;
    for (const e of this.empresas) {
      for (const r of e.rotas) {
        if (r.canal !== canal) continue;
        if (r.receptora !== '*' && r.receptora !== rec) continue;
        if (r.linha !== '*' && r.linha !== lin) continue;
        const pontos = (r.receptora === '*' ? 0 : 2) + (r.linha === '*' ? 0 : 1);
        if (!melhor || pontos > melhor.pontos) melhor = { empresa: e.id, pontos };
      }
    }
    return melhor?.empresa;
  }
}

export interface CentralOptions {
  onChange?: (o: Ocorrencia) => void;
  // Espera em "pendente" de cada evento, conforme os ajustes da empresa.
  esperaMin?: (e: AlarmEvent, empresa: Empresa) => number;
  now?: () => Date;
}

// O estado vivo do sistema, separado por empresa: fila, índice de clientes e supervisão de teste de cada uma.
export class Central {
  private empresas: Empresa[] = [];
  private roteador = new Roteador([]);
  private readonly filas = new Map<number, IncidentQueue>();
  private readonly indices = new Map<number, ClienteIndex>();
  private readonly supervisoes = new Map<number, SupervisaoTeste>();
  private proximo = 1;
  // Últimos eventos que nenhuma rota reconheceu, para o dono do sistema ajustar as rotas.
  readonly semRota: { em: string; canal: Canal; receptora: string; linha: string; conta: string; descricao: string }[] = [];

  constructor(private readonly repo: Repositorio, private readonly opts: CentralOptions = {}) {}

  async iniciar(): Promise<void> {
    await this.recarregarEmpresas();
    const abertas = await this.repo.carregarOcorrenciasAbertas();
    for (const o of abertas) this.proximo = Math.max(this.proximo, o.id + 1);
    for (const e of this.empresas) this.fila(e.id).restore(abertas.filter((o) => o.empresaId === e.id));
    for (const u of await this.repo.ultimosEventos()) this.supervisoes.get(u.empresaId)?.registrar(u.conta, u.em);
  }

  // Lê empresas e rotas do banco e cria a fila das empresas novas.
  async recarregarEmpresas(): Promise<void> {
    this.empresas = await this.repo.listarEmpresas();
    this.roteador = new Roteador(this.empresas);
    for (const e of this.empresas) {
      if (this.filas.has(e.id)) continue;
      const indice = new ClienteIndex(this.repo, e.id);
      await indice.refresh();
      this.indices.set(e.id, indice);
      this.filas.set(e.id, new IncidentQueue({
        empresaId: e.id,
        proximoId: () => this.proximo++,
        contaCadastrada: (conta) => conta === CONTA_BASE || indice.porConta(conta) !== undefined,
        onChange: this.opts.onChange,
        esperaMin: this.opts.esperaMin && ((ev) => this.opts.esperaMin!(ev, this.empresa(e.id) ?? e)),
        limitePorOperador: () => (this.empresa(e.id) ?? e).ajustes.limitePorOperador ?? AJUSTES_PADRAO.limitePorOperador,
        now: this.opts.now,
      }));
      this.supervisoes.set(e.id, new SupervisaoTeste((conta) => indice.porConta(conta)?.intervaloTesteHoras, this.opts.now));
    }
  }

  listaEmpresas(): Empresa[] {
    return this.empresas;
  }

  empresa(id: number): Empresa | undefined {
    return this.empresas.find((e) => e.id === id);
  }

  fila(empresaId: number): IncidentQueue {
    const f = this.filas.get(empresaId);
    if (!f) throw new Error(`Empresa ${empresaId} não existe`);
    return f;
  }

  clientes(empresaId: number): ClienteIndex {
    const c = this.indices.get(empresaId);
    if (!c) throw new Error(`Empresa ${empresaId} não existe`);
    return c;
  }

  supervisao(empresaId: number): SupervisaoTeste {
    return this.supervisoes.get(empresaId)!;
  }

  todasAsFilas(): [number, IncidentQueue][] {
    return [...this.filas];
  }

  // Marca a empresa no evento. Devolve undefined (e guarda para consulta) quando nenhuma rota casa.
  rotear(e: AlarmEvent, canal: Canal): number | undefined {
    const empresaId = e.empresaId ?? this.roteador.empresaDe(canal, e.receiver, e.line);
    if (empresaId === undefined) {
      this.semRota.unshift({ em: e.receivedAt, canal, receptora: e.receiver ?? '', linha: e.line, conta: e.account, descricao: e.description });
      this.semRota.length = Math.min(this.semRota.length, 50);
      return undefined;
    }
    e.empresaId = empresaId;
    return empresaId;
  }
}
