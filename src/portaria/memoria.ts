import { randomBytes } from 'node:crypto';
import { NaoEncontradoError } from '../store/repositorio.js';
import {
  rotuloUnidade, UnidadeDuplicadaError, validarAtendimento, validarCondominio, validarEquipamento, validarUnidade,
  type Abertura, type Atendimento, type Equipamento, type NovoEquipamento, type Condominio, type FiltroAtendimentos, type NovaUnidade, type NovoAtendimento, type NovoCondominio, type RepoPortaria, type Unidade,
} from './tipos.js';

type Guardado<T> = T & { empresaId: number };

export class PortariaMemoria implements RepoPortaria {
  private readonly condominios: Guardado<Omit<Condominio, 'unidades'>>[] = [];
  private readonly unidades: Unidade[] = [];
  private readonly atendimentos: Guardado<Atendimento>[] = [];
  private readonly equipamentos: Equipamento[] = [];
  private readonly aberturas: Guardado<Abertura>[] = [];
  private seq = 1;

  private cond(empresaId: number, id: number) {
    const c = this.condominios.find((x) => x.id === id && x.empresaId === empresaId);
    if (!c) throw new NaoEncontradoError(`Condomínio ${id} não existe`);
    return c;
  }

  private publico(c: Guardado<Omit<Condominio, 'unidades'>>): Condominio {
    const { empresaId: _, ...resto } = structuredClone(c);
    return { ...resto, unidades: this.unidades.filter((u) => u.condominioId === c.id).length };
  }

  async listarCondominios(empresaId: number): Promise<Condominio[]> {
    return this.condominios.filter((c) => c.empresaId === empresaId).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')).map((c) => this.publico(c));
  }

  async criarCondominio(empresaId: number, entrada: NovoCondominio): Promise<Condominio> {
    const c = { ...validarCondominio(entrada), id: this.seq++, ativo: true, empresaId };
    this.condominios.push(c);
    return this.publico(c);
  }

  async atualizarCondominio(empresaId: number, id: number, entrada: NovoCondominio & { ativo?: boolean }): Promise<Condominio> {
    const c = this.cond(empresaId, id);
    Object.assign(c, validarCondominio(entrada), { ativo: entrada.ativo ?? c.ativo });
    return this.publico(c);
  }

  async listarUnidades(empresaId: number, condominioId: number): Promise<Unidade[]> {
    this.cond(empresaId, condominioId);
    return structuredClone(this.unidades.filter((u) => u.condominioId === condominioId));
  }

  async salvarUnidade(empresaId: number, condominioId: number, entrada: NovaUnidade & { id?: number }): Promise<Unidade> {
    this.cond(empresaId, condominioId);
    const v = validarUnidade(entrada);
    const igual = this.unidades.find((u) => u.condominioId === condominioId && u.id !== entrada.id && (u.bloco ?? '') === (v.bloco ?? '') && u.numero === v.numero);
    if (igual) throw new UnidadeDuplicadaError(`A unidade ${rotuloUnidade(v)} já existe`);
    if (entrada.id !== undefined) {
      const u = this.unidades.find((x) => x.id === entrada.id && x.condominioId === condominioId);
      if (!u) throw new NaoEncontradoError(`Unidade ${entrada.id} não existe`);
      Object.assign(u, { bloco: v.bloco, numero: v.numero, observacao: v.observacao, pessoas: v.pessoas });
      return structuredClone(u);
    }
    const u: Unidade = { ...v, id: this.seq++, condominioId };
    this.unidades.push(u);
    return structuredClone(u);
  }

  async removerUnidade(empresaId: number, condominioId: number, id: number): Promise<void> {
    this.cond(empresaId, condominioId);
    const i = this.unidades.findIndex((u) => u.id === id && u.condominioId === condominioId);
    if (i < 0) throw new NaoEncontradoError(`Unidade ${id} não existe`);
    this.unidades.splice(i, 1);
    // Como no banco (ON DELETE SET NULL): o histórico perde o vínculo, mas guarda o rótulo.
    for (const a of this.atendimentos) if (a.unidadeId === id) a.unidadeId = undefined;
  }

  async registrarAtendimento(empresaId: number, entrada: NovoAtendimento, operador: string, em: Date): Promise<Atendimento> {
    const v = validarAtendimento(entrada);
    this.cond(empresaId, v.condominioId);
    const unidade = v.unidadeId === undefined ? undefined : this.unidades.find((u) => u.id === v.unidadeId && u.condominioId === v.condominioId);
    if (v.unidadeId !== undefined && !unidade) throw new NaoEncontradoError(`Unidade ${v.unidadeId} não existe`);
    const a = { ...v, id: this.seq++, em, operador, empresaId, unidade: unidade && rotuloUnidade(unidade) };
    this.atendimentos.push(a);
    const { empresaId: _, ...resto } = structuredClone(a);
    return resto;
  }

  async listarAtendimentos(empresaId: number, f: FiltroAtendimentos): Promise<Atendimento[]> {
    return this.atendimentos
      .filter((a) => a.empresaId === empresaId && (!f.condominioId || a.condominioId === f.condominioId) && (!f.de || a.em >= f.de) && (!f.ate || a.em <= f.ate))
      .sort((a, b) => b.em.getTime() - a.em.getTime() || b.id - a.id)
      .slice(0, f.limite)
      .map((a) => {
        const { empresaId: _, ...resto } = structuredClone(a);
        return resto;
      });
  }

  async listarEquipamentos(empresaId: number, condominioId: number): Promise<Equipamento[]> {
    this.cond(empresaId, condominioId);
    return structuredClone(this.equipamentos.filter((e) => e.condominioId === condominioId));
  }

  async equipamentosAtivos(): Promise<Equipamento[]> {
    const ativos = new Set(this.condominios.filter((c) => c.ativo).map((c) => c.id));
    return structuredClone(this.equipamentos.filter((e) => e.ativo && ativos.has(e.condominioId)));
  }

  async buscarEquipamento(empresaId: number, id: number): Promise<Equipamento | undefined> {
    const e = this.equipamentos.find((x) => x.id === id && x.empresaId === empresaId);
    return e && structuredClone(e);
  }

  async equipamentoPorToken(token: string): Promise<Equipamento | undefined> {
    const e = this.equipamentos.find((x) => x.tokenEventos === token);
    return e && structuredClone(e);
  }

  async salvarEquipamento(empresaId: number, condominioId: number, entrada: NovoEquipamento & { id?: number; senhaCifrada?: string }): Promise<Equipamento> {
    this.cond(empresaId, condominioId);
    const v = validarEquipamento(entrada);
    if (entrada.id !== undefined) {
      const e = this.equipamentos.find((x) => x.id === entrada.id && x.condominioId === condominioId);
      if (!e) throw new NaoEncontradoError(`Equipamento ${entrada.id} não existe`);
      Object.assign(e, v, { senhaCifrada: entrada.senhaCifrada ?? e.senhaCifrada });
      return structuredClone(e);
    }
    if (!entrada.senhaCifrada) throw new Error('Senha do equipamento é obrigatória');
    const e: Equipamento = { ...v, id: this.seq++, condominioId, empresaId, senhaCifrada: entrada.senhaCifrada, tokenEventos: randomBytes(18).toString('base64url') };
    this.equipamentos.push(e);
    return structuredClone(e);
  }

  async removerEquipamento(empresaId: number, condominioId: number, id: number): Promise<void> {
    this.cond(empresaId, condominioId);
    const i = this.equipamentos.findIndex((e) => e.id === id && e.condominioId === condominioId);
    if (i < 0) throw new NaoEncontradoError(`Equipamento ${id} não existe`);
    this.equipamentos.splice(i, 1);
    for (const a of this.aberturas) if (a.equipamentoId === id) a.equipamentoId = undefined;
  }

  async registrarAbertura(empresaId: number, a: Omit<Abertura, 'id'>): Promise<Abertura> {
    const g = { ...structuredClone(a), id: this.seq++, empresaId };
    this.aberturas.push(g);
    const { empresaId: _, ...resto } = structuredClone(g);
    return resto;
  }

  async listarAberturas(empresaId: number, condominioId: number, limite: number): Promise<Abertura[]> {
    return this.aberturas
      .filter((a) => a.empresaId === empresaId && a.condominioId === condominioId)
      .sort((a, b) => b.em.getTime() - a.em.getTime() || b.id - a.id)
      .slice(0, limite)
      .map((a) => {
        const { empresaId: _, ...resto } = structuredClone(a);
        return resto;
      });
  }
}
