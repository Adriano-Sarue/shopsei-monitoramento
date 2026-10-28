import type { Ocorrencia } from '../incidents/queue.js';
import type { AlarmEvent } from '../protocols/types.js';
import { ContaDuplicadaError, LoginDuplicadoError, validarCliente, validarUsuario, type Cliente, type FiltroHistorico, type NovoCliente, type NovoUsuario, type Repositorio, type Usuario } from './repositorio.js';

// Implementação em memória: usada nos testes e para rodar sem banco (nada sobrevive ao reinício).
export class MemoryRepo implements Repositorio {
  readonly eventos: AlarmEvent[] = [];
  private readonly ocorrencias = new Map<number, Ocorrencia>();
  private readonly clientes: Cliente[] = [];
  private readonly usuarios: Usuario[] = [];
  private nextId = 1;
  private nextUsuario = 1;

  async init(): Promise<void> {}

  async salvarEvento(e: AlarmEvent): Promise<void> {
    this.eventos.push(e);
  }

  async salvarOcorrencia(o: Ocorrencia): Promise<void> {
    this.ocorrencias.set(o.id, structuredClone(o));
  }

  async carregarOcorrenciasAbertas(): Promise<Ocorrencia[]> {
    return [...this.ocorrencias.values()].filter((o) => o.situacao !== 'encerrada').map((o) => structuredClone(o));
  }

  async listarEncerradas(f: FiltroHistorico): Promise<Ocorrencia[]> {
    return [...this.ocorrencias.values()]
      .filter((o) => o.situacao === 'encerrada' && (!f.conta || o.conta === f.conta) && (!f.de || o.encerradaEm! >= f.de) && (!f.ate || o.encerradaEm! <= f.ate))
      .sort((a, b) => b.encerradaEm!.getTime() - a.encerradaEm!.getTime())
      .slice(0, f.limite)
      .map((o) => structuredClone(o));
  }

  async listarClientes(): Promise<Cliente[]> {
    return structuredClone(this.clientes);
  }

  private checarContas(contas: string[], exceto?: number): void {
    for (const conta of contas) {
      if (this.clientes.some((c) => c.id !== exceto && c.contas.includes(conta))) {
        throw new ContaDuplicadaError(`A conta ${conta} já pertence a outro cliente`);
      }
    }
  }

  async criarCliente(entrada: NovoCliente): Promise<Cliente> {
    const c = validarCliente(entrada);
    this.checarContas(c.contas);
    const cliente: Cliente = { ...c, id: this.nextId++, ativo: true };
    this.clientes.push(cliente);
    return structuredClone(cliente);
  }

  async atualizarCliente(id: number, entrada: NovoCliente): Promise<Cliente> {
    const c = validarCliente(entrada);
    const i = this.clientes.findIndex((x) => x.id === id);
    if (i < 0) throw new Error(`Cliente ${id} não existe`);
    this.checarContas(c.contas, id);
    this.clientes[i] = { ...c, id, ativo: this.clientes[i]!.ativo };
    return structuredClone(this.clientes[i]!);
  }

  async listarUsuarios(): Promise<Usuario[]> {
    return structuredClone(this.usuarios);
  }

  async buscarUsuario(login: string): Promise<Usuario | undefined> {
    const u = this.usuarios.find((x) => x.login === login.trim().toLowerCase());
    return u && structuredClone(u);
  }

  async criarUsuario(entrada: NovoUsuario): Promise<Usuario> {
    const v = validarUsuario(entrada);
    if (this.usuarios.some((x) => x.login === v.login)) throw new LoginDuplicadoError(`O login ${v.login} já existe`);
    const u: Usuario = { ...v, id: this.nextUsuario++, ativo: true, senhaHash: entrada.senhaHash };
    this.usuarios.push(u);
    return structuredClone(u);
  }

  async atualizarUsuario(id: number, mudancas: Partial<Pick<Usuario, 'nome' | 'papel' | 'ativo' | 'senhaHash'>>): Promise<Usuario> {
    const u = this.usuarios.find((x) => x.id === id);
    if (!u) throw new Error(`Usuário ${id} não existe`);
    const v = validarUsuario({ login: u.login, nome: mudancas.nome ?? u.nome, papel: mudancas.papel ?? u.papel });
    Object.assign(u, v, { ativo: mudancas.ativo ?? u.ativo, senhaHash: mudancas.senhaHash ?? u.senhaHash });
    return structuredClone(u);
  }

  async fechar(): Promise<void> {}
}
