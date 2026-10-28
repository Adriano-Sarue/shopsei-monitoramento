import type { Ocorrencia } from '../incidents/queue.js';
import type { AlarmEvent } from '../protocols/types.js';
import {
  ContaDuplicadaError, LoginDuplicadoError, NaoEncontradoError, RotaDuplicadaError, validarCliente, validarEmpresa, validarUsuario,
  type Cliente, type Empresa, type FiltroHistorico, type NovoCliente, type NovoUsuario, type Repositorio, type Rota, type UltimoEvento, type Usuario,
} from './repositorio.js';

type ClienteGuardado = Cliente & { empresaId: number };

// Implementação em memória: usada nos testes e para rodar sem banco (nada sobrevive ao reinício).
export class MemoryRepo implements Repositorio {
  readonly eventos: AlarmEvent[] = [];
  private readonly ocorrencias = new Map<number, Ocorrencia>();
  private readonly clientes: ClienteGuardado[] = [];
  private readonly usuarios: Usuario[] = [];
  private readonly empresas: Empresa[] = [];
  private nextId = 1;
  private nextUsuario = 1;
  private nextEmpresa = 1;

  async init(): Promise<void> {}

  async listarEmpresas(): Promise<Empresa[]> {
    return structuredClone(this.empresas);
  }

  private checarRotas(rotas: Rota[], exceto?: number): void {
    for (const r of rotas) {
      const dona = this.empresas.find((e) => e.id !== exceto && e.rotas.some((x) => x.canal === r.canal && x.receptora === r.receptora && x.linha === r.linha));
      if (dona) throw new RotaDuplicadaError(`A rota ${r.canal} ${r.receptora}/${r.linha} já é da empresa ${dona.nome}`);
    }
  }

  async criarEmpresa(entrada: { nome: string; rotas?: Rota[] }): Promise<Empresa> {
    const v = validarEmpresa(entrada);
    this.checarRotas(v.rotas);
    const e: Empresa = { id: this.nextEmpresa++, nome: v.nome, ativo: true, rotas: v.rotas };
    this.empresas.push(e);
    return structuredClone(e);
  }

  async atualizarEmpresa(id: number, m: { nome?: string; ativo?: boolean; rotas?: Rota[] }): Promise<Empresa> {
    const e = this.empresas.find((x) => x.id === id);
    if (!e) throw new NaoEncontradoError(`Empresa ${id} não existe`);
    const v = validarEmpresa({ nome: m.nome ?? e.nome, rotas: m.rotas ?? e.rotas });
    this.checarRotas(v.rotas, id);
    Object.assign(e, { nome: v.nome, rotas: v.rotas, ativo: m.ativo ?? e.ativo });
    return structuredClone(e);
  }

  async salvarEvento(e: AlarmEvent): Promise<void> {
    this.eventos.push(e);
  }

  async salvarOcorrencia(o: Ocorrencia): Promise<void> {
    this.ocorrencias.set(o.id, structuredClone(o));
  }

  async carregarOcorrenciasAbertas(): Promise<Ocorrencia[]> {
    return [...this.ocorrencias.values()].filter((o) => o.situacao !== 'encerrada').map((o) => structuredClone(o));
  }

  async ultimosEventos(): Promise<UltimoEvento[]> {
    const m = new Map<string, UltimoEvento>();
    for (const e of this.eventos) {
      if (e.protocol === 'INTERNO' || e.empresaId === undefined) continue;
      const chave = `${e.empresaId}|${e.account}`;
      const d = new Date(e.receivedAt);
      if (d > (m.get(chave)?.em ?? new Date(0))) m.set(chave, { empresaId: e.empresaId, conta: e.account, em: d });
    }
    return [...m.values()];
  }

  async listarEncerradas(empresaId: number, f: FiltroHistorico): Promise<Ocorrencia[]> {
    return [...this.ocorrencias.values()]
      .filter((o) => o.empresaId === empresaId && o.situacao === 'encerrada')
      .filter((o) => (!f.conta || o.conta === f.conta) && (!f.de || o.encerradaEm! >= f.de) && (!f.ate || o.encerradaEm! <= f.ate))
      .sort((a, b) => b.encerradaEm!.getTime() - a.encerradaEm!.getTime())
      .slice(0, f.limite)
      .map((o) => structuredClone(o));
  }

  private publico(c: ClienteGuardado): Cliente {
    const { empresaId: _, ...resto } = structuredClone(c);
    return resto;
  }

  async listarClientes(empresaId: number): Promise<Cliente[]> {
    return this.clientes.filter((c) => c.empresaId === empresaId).map((c) => this.publico(c));
  }

  // A mesma conta pode existir em empresas diferentes; dentro de uma empresa, só num cliente.
  private checarContas(empresaId: number, contas: string[], exceto?: number): void {
    for (const conta of contas) {
      if (this.clientes.some((c) => c.empresaId === empresaId && c.id !== exceto && c.contas.includes(conta))) {
        throw new ContaDuplicadaError(`A conta ${conta} já pertence a outro cliente`);
      }
    }
  }

  async criarCliente(empresaId: number, entrada: NovoCliente): Promise<Cliente> {
    const c = validarCliente(entrada);
    this.checarContas(empresaId, c.contas);
    const cliente: ClienteGuardado = { ...c, id: this.nextId++, ativo: true, empresaId };
    this.clientes.push(cliente);
    return this.publico(cliente);
  }

  async atualizarCliente(empresaId: number, id: number, entrada: NovoCliente): Promise<Cliente> {
    const c = validarCliente(entrada);
    const i = this.clientes.findIndex((x) => x.id === id && x.empresaId === empresaId);
    if (i < 0) throw new NaoEncontradoError(`Cliente ${id} não existe`);
    this.checarContas(empresaId, c.contas, id);
    this.clientes[i] = { ...c, id, ativo: this.clientes[i]!.ativo, empresaId };
    return this.publico(this.clientes[i]!);
  }

  async listarUsuarios(empresaId: number | null): Promise<Usuario[]> {
    return structuredClone(this.usuarios.filter((u) => u.empresaId === empresaId));
  }

  async buscarUsuario(login: string): Promise<Usuario | undefined> {
    const u = this.usuarios.find((x) => x.login === login.trim().toLowerCase());
    return u && structuredClone(u);
  }

  async criarUsuario(entrada: NovoUsuario): Promise<Usuario> {
    const v = validarUsuario(entrada);
    if (entrada.empresaId !== null && !this.empresas.some((e) => e.id === entrada.empresaId)) throw new NaoEncontradoError(`Empresa ${entrada.empresaId} não existe`);
    if (this.usuarios.some((x) => x.login === v.login)) throw new LoginDuplicadoError(`O login ${v.login} já existe`);
    const u: Usuario = { ...v, id: this.nextUsuario++, empresaId: entrada.empresaId, ativo: true, senhaHash: entrada.senhaHash };
    this.usuarios.push(u);
    return structuredClone(u);
  }

  async atualizarUsuario(empresaId: number | null, id: number, mudancas: Partial<Pick<Usuario, 'nome' | 'papel' | 'ativo' | 'senhaHash'>>): Promise<Usuario> {
    const u = this.usuarios.find((x) => x.id === id && x.empresaId === empresaId);
    if (!u) throw new NaoEncontradoError(`Usuário ${id} não existe`);
    const v = validarUsuario({ login: u.login, nome: mudancas.nome ?? u.nome, papel: mudancas.papel ?? u.papel });
    Object.assign(u, v, { ativo: mudancas.ativo ?? u.ativo, senhaHash: mudancas.senhaHash ?? u.senhaHash });
    return structuredClone(u);
  }

  async fechar(): Promise<void> {}
}
