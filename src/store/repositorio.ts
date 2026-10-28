import type { Ocorrencia } from '../incidents/queue.js';
import type { AlarmEvent } from '../protocols/types.js';

export interface Contato {
  nome: string;
  telefone?: string;
  ordem: number;
}

export interface NovoCliente {
  nome: string;
  endereco?: string;
  tipo?: string;
  observacoes?: string;
  palavraChave?: string;
  contraSenha?: string;
  contas: string[];
  contatos: Contato[];
}

export interface Cliente extends NovoCliente {
  id: number;
  ativo: boolean;
}

export class ContaDuplicadaError extends Error {}

// Contrato de persistência. Há uma implementação em PostgreSQL e uma em memória (testes e dev).
export interface Repositorio {
  init(): Promise<void>;
  salvarEvento(e: AlarmEvent): Promise<void>;
  salvarOcorrencia(o: Ocorrencia): Promise<void>;
  carregarOcorrenciasAbertas(): Promise<Ocorrencia[]>;
  listarClientes(): Promise<Cliente[]>;
  criarCliente(c: NovoCliente): Promise<Cliente>;
  atualizarCliente(id: number, c: NovoCliente): Promise<Cliente>;
  fechar(): Promise<void>;
}

export function validarCliente(c: NovoCliente): NovoCliente {
  const nome = c.nome?.trim();
  if (!nome) throw new Error('Nome do cliente é obrigatório');
  const contas = [...new Set((c.contas ?? []).map((n) => n.trim().toUpperCase()).filter(Boolean))];
  if (contas.length === 0) throw new Error('Informe ao menos uma conta');
  for (const conta of contas) {
    if (!/^[0-9A-F]{1,16}$/.test(conta)) throw new Error(`Conta inválida: "${conta}"`);
  }
  const contatos = (c.contatos ?? [])
    .filter((x) => x.nome?.trim())
    .map((x, i) => ({ nome: x.nome.trim(), telefone: x.telefone?.trim() || undefined, ordem: x.ordem || i + 1 }));
  return { ...c, nome, contas, contatos };
}

// Índice em memória conta -> cliente, para a tela não consultar o banco a cada evento.
export class ClienteIndex {
  private byConta = new Map<string, Cliente>();

  constructor(private readonly repo: Repositorio) {}

  async refresh(): Promise<void> {
    const all = await this.repo.listarClientes();
    this.byConta = new Map(all.filter((c) => c.ativo).flatMap((c) => c.contas.map((conta) => [conta.toUpperCase(), c] as const)));
  }

  porConta(conta: string): Cliente | undefined {
    return this.byConta.get(conta.toUpperCase());
  }
}
