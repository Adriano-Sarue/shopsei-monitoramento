import { randomBytes } from 'node:crypto';
import type { Cofre } from './cofre.js';
import { Hikvision, type EstadoChamada, type EventoEquipamento, type InfoEquipamento } from './hikvision.js';
import type { Equipamento, RepoPortaria } from './tipos.js';

// O que o sistema precisa de um equipamento; nos testes entra um falso.
export interface Conexao {
  info(): Promise<InfoEquipamento>;
  abrirPorta(porta: number): Promise<void>;
  estadoChamada(): Promise<EstadoChamada>;
  encerrarChamada(): Promise<void>;
  foto(): Promise<Buffer>;
  configurarEnvio(destino: string): Promise<void>;
}

export interface EstadoEquipamento {
  online: boolean;
  erro?: string;
  vistoEm?: string;
  // Visitante chamando no botão do leitor desde esse horário.
  chamandoDesde?: string;
}

export interface EventoAoVivo extends Omit<EventoEquipamento, 'foto'> {
  id: string;
  empresaId: number;
  condominioId: number;
  equipamentoId: number;
  equipamento: string;
  temFoto: boolean;
}

const MAX_EVENTOS = 100;
const MAX_FOTOS = 300;

// Acompanha os equipamentos de todas as empresas: consulta a chamada de cada um a cada intervalo e guarda os
// últimos eventos que eles enviam. Tudo em memória: depois de um reinício, recomeça do zero.
export class PortariaAoVivo {
  private equipamentos: Equipamento[] = [];
  private readonly estados = new Map<number, EstadoEquipamento>();
  private readonly eventos: EventoAoVivo[] = [];
  private readonly fotos = new Map<string, Buffer>();
  private rodando = false;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly repo: RepoPortaria,
    private readonly cofre: Cofre | undefined,
    private readonly opts: { conectar?: (e: Equipamento, senha: string) => Conexao; agora?: () => Date } = {},
  ) {}

  private agora(): Date {
    return this.opts.agora?.() ?? new Date();
  }

  conexao(e: Equipamento): Conexao {
    if (!this.cofre) throw new Error('Defina CHAVE_EQUIPAMENTOS no servidor para usar os equipamentos');
    const senha = this.cofre.decifrar(e.senhaCifrada);
    return this.opts.conectar?.(e, senha) ?? new Hikvision({ endereco: e.endereco, usuario: e.usuario, senha });
  }

  async recarregar(): Promise<void> {
    this.equipamentos = await this.repo.equipamentosAtivos();
    const ids = new Set(this.equipamentos.map((e) => e.id));
    for (const id of this.estados.keys()) if (!ids.has(id)) this.estados.delete(id);
  }

  iniciar(intervaloMs = 2000): void {
    this.timer = setInterval(() => void this.verificar(), intervaloMs);
    this.timer.unref();
  }

  parar(): void {
    clearInterval(this.timer);
  }

  // Uma rodada: pergunta a cada equipamento se há chamada. Rodada ainda em andamento não é repetida.
  async verificar(): Promise<void> {
    if (this.rodando || !this.cofre) return;
    this.rodando = true;
    try {
      await Promise.all(this.equipamentos.map(async (e) => {
        const antes = this.estados.get(e.id) ?? { online: false };
        try {
          const estado = await this.conexao(e).estadoChamada();
          const tocando = estado === 'tocando';
          const agora = this.agora().toISOString();
          this.estados.set(e.id, { online: true, vistoEm: agora, chamandoDesde: tocando ? (antes.chamandoDesde ?? agora) : undefined });
          if (tocando && !antes.chamandoDesde) this.adicionar(e, { tipo: 'chamada', descricao: 'Visitante chamando no leitor', em: agora });
        } catch (err) {
          this.estados.set(e.id, { ...antes, online: false, erro: (err as Error).message, chamandoDesde: undefined });
        }
      }));
    } finally {
      this.rodando = false;
    }
  }

  estado(equipamentoId: number): EstadoEquipamento {
    return this.estados.get(equipamentoId) ?? { online: false };
  }

  // Chamadas tocando agora, da empresa.
  chamadas(empresaId: number): { equipamentoId: number; condominioId: number; equipamento: string; desde: string }[] {
    return this.equipamentos
      .filter((e) => e.empresaId === empresaId && this.estados.get(e.id)?.chamandoDesde)
      .map((e) => ({ equipamentoId: e.id, condominioId: e.condominioId, equipamento: e.nome, desde: this.estados.get(e.id)!.chamandoDesde! }));
  }

  // Evento que o equipamento mandou para /hik/<token>.
  receber(e: Equipamento, ev: EventoEquipamento): void {
    const antes = this.estados.get(e.id) ?? { online: false };
    this.estados.set(e.id, { ...antes, online: true, erro: undefined, vistoEm: this.agora().toISOString() });
    if (ev.tipo === 'sinal') return;
    this.adicionar(e, ev);
  }

  private adicionar(e: Equipamento, ev: EventoEquipamento): void {
    const id = randomBytes(9).toString('base64url');
    const { foto, ...resto } = ev;
    if (foto) {
      this.fotos.set(id, foto);
      if (this.fotos.size > MAX_FOTOS) this.fotos.delete(this.fotos.keys().next().value!);
    }
    this.eventos.unshift({ ...resto, id, empresaId: e.empresaId, condominioId: e.condominioId, equipamentoId: e.id, equipamento: e.nome, temFoto: !!foto });
    this.eventos.length = Math.min(this.eventos.length, MAX_EVENTOS * 20);
  }

  eventosDa(empresaId: number, condominioId?: number): EventoAoVivo[] {
    return this.eventos.filter((x) => x.empresaId === empresaId && (!condominioId || x.condominioId === condominioId)).slice(0, MAX_EVENTOS);
  }

  fotoDoEvento(empresaId: number, id: string): Buffer | undefined {
    return this.eventos.some((x) => x.id === id && x.empresaId === empresaId) ? this.fotos.get(id) : undefined;
  }
}
