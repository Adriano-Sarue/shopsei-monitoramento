import type { Ocorrencia } from '../incidents/queue.js';
import type { AlarmEvent } from '../protocols/types.js';

export interface Contato {
  nome: string;
  telefone?: string;
  ordem: number;
}

// Câmera do cliente que o operador abre ao atender um disparo (link da nuvem da marca, do gravador ou do visualizador).
export interface Camera {
  nome: string;
  marca?: string;
  url: string;
  ordem: number;
}

export interface NovoCliente {
  nome: string;
  endereco?: string;
  tipo?: string;
  observacoes?: string;
  // Instruções próprias do cliente para o operador; valem mais que o plano de ação padrão.
  instrucoes?: string;
  // Prazo máximo sem nenhum sinal das centrais do cliente antes de abrir "falta de teste periódico".
  intervaloTesteHoras?: number;
  palavraChave?: string;
  contraSenha?: string;
  contas: string[];
  contatos: Contato[];
  cameras?: Camera[];
}

export interface Cliente extends NovoCliente {
  id: number;
  ativo: boolean;
}

export class ContaDuplicadaError extends Error {}
export class LoginDuplicadoError extends Error {}

export type Papel = 'operador' | 'admin';

export interface Usuario {
  id: number;
  login: string;
  nome: string;
  papel: Papel;
  ativo: boolean;
  senhaHash: string;
}

export interface NovoUsuario {
  login: string;
  nome: string;
  papel: Papel;
  senhaHash: string;
}

export function validarUsuario(u: { login: string; nome: string; papel: string }): { login: string; nome: string; papel: Papel } {
  const login = u.login?.trim().toLowerCase();
  if (!login || !/^[a-z0-9._-]{3,32}$/.test(login)) throw new Error('Login deve ter de 3 a 32 letras minúsculas, números, ponto, hífen ou sublinhado');
  const nome = u.nome?.trim();
  if (!nome) throw new Error('Nome é obrigatório');
  if (u.papel !== 'operador' && u.papel !== 'admin') throw new Error('Perfil inválido');
  return { login, nome, papel: u.papel };
}

export interface FiltroHistorico {
  conta?: string;
  de?: Date;
  ate?: Date;
  limite: number;
}

// Contrato de persistência. Há uma implementação em PostgreSQL e uma em memória (testes e dev).
export interface Repositorio {
  init(): Promise<void>;
  salvarEvento(e: AlarmEvent): Promise<void>;
  salvarOcorrencia(o: Ocorrencia): Promise<void>;
  carregarOcorrenciasAbertas(): Promise<Ocorrencia[]>;
  listarEncerradas(filtro: FiltroHistorico): Promise<Ocorrencia[]>;
  // Último evento recebido de cada conta (para retomar a supervisão de teste após reinício).
  ultimosEventos(): Promise<Map<string, Date>>;
  listarClientes(): Promise<Cliente[]>;
  criarCliente(c: NovoCliente): Promise<Cliente>;
  atualizarCliente(id: number, c: NovoCliente): Promise<Cliente>;
  listarUsuarios(): Promise<Usuario[]>;
  buscarUsuario(login: string): Promise<Usuario | undefined>;
  criarUsuario(u: NovoUsuario): Promise<Usuario>;
  atualizarUsuario(id: number, mudancas: Partial<Pick<Usuario, 'nome' | 'papel' | 'ativo' | 'senhaHash'>>): Promise<Usuario>;
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
  const cameras = (c.cameras ?? [])
    .filter((x) => x.nome?.trim() || x.url?.trim())
    .map((x, i) => {
      const url = x.url?.trim() ?? '';
      if (!x.nome?.trim()) throw new Error('Toda câmera precisa de um nome');
      if (!/^https?:\/\/\S+$/i.test(url)) throw new Error(`Link da câmera "${x.nome.trim()}" deve começar com http:// ou https://`);
      return { nome: x.nome.trim(), marca: x.marca?.trim() || undefined, url, ordem: x.ordem || i + 1 };
    });
  const intervalo = c.intervaloTesteHoras === undefined || c.intervaloTesteHoras === null || (c.intervaloTesteHoras as unknown) === '' ? undefined : Number(c.intervaloTesteHoras);
  if (intervalo !== undefined && !(Number.isInteger(intervalo) && intervalo >= 1 && intervalo <= 720)) throw new Error('Intervalo de teste deve ser de 1 a 720 horas');
  const instrucoes = c.instrucoes?.trim() || undefined;
  return { ...c, nome, contas, contatos, cameras, instrucoes, intervaloTesteHoras: intervalo };
}

// Índice em memória conta -> cliente, para a tela não consultar o banco a cada evento.
export class ClienteIndex {
  private byConta = new Map<string, Cliente>();

  constructor(private readonly repo: Repositorio) {}

  async refresh(): Promise<void> {
    const all = await this.repo.listarClientes();
    this.byConta = new Map(all.filter((c) => c.ativo).flatMap((c) => c.contas.map((conta) => [conta.toUpperCase(), c] as const)));
  }

  todos(): Cliente[] {
    return [...new Set(this.byConta.values())];
  }

  porConta(conta: string): Cliente | undefined {
    return this.byConta.get(conta.toUpperCase());
  }
}
