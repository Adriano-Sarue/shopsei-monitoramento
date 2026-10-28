import { randomBytes } from 'node:crypto';
import type { Papel } from '../store/repositorio.js';

export interface Sessao {
  usuarioId: number;
  login: string;
  nome: string;
  papel: Papel;
  expira: number;
}

const DURACAO_MS = 12 * 60 * 60 * 1000;
const JANELA_MS = 5 * 60 * 1000;
const MAX_FALHAS = 5;

// Sessões ficam em memória: reiniciar o servidor desloga todo mundo (a fila, não).
export class Sessoes {
  private readonly porToken = new Map<string, Sessao>();
  private readonly falhas = new Map<string, number[]>();

  constructor(private readonly agora: () => number = Date.now) {}

  criar(u: Omit<Sessao, 'expira'>): string {
    const token = randomBytes(32).toString('base64url');
    this.porToken.set(token, { ...u, expira: this.agora() + DURACAO_MS });
    return token;
  }

  obter(token: string | undefined): Sessao | undefined {
    if (!token) return undefined;
    const s = this.porToken.get(token);
    if (!s) return undefined;
    if (s.expira < this.agora()) {
      this.porToken.delete(token);
      return undefined;
    }
    s.expira = this.agora() + DURACAO_MS;
    return s;
  }

  encerrar(token: string | undefined): Sessao | undefined {
    const s = token ? this.porToken.get(token) : undefined;
    if (token) this.porToken.delete(token);
    return s;
  }

  revogarUsuario(usuarioId: number): void {
    for (const [t, s] of this.porToken) if (s.usuarioId === usuarioId) this.porToken.delete(t);
  }

  // Limite de tentativas por chave (login + IP): 5 falhas em 5 minutos bloqueiam novas tentativas.
  bloqueado(chave: string): boolean {
    const recentes = (this.falhas.get(chave) ?? []).filter((t) => t > this.agora() - JANELA_MS);
    this.falhas.set(chave, recentes);
    return recentes.length >= MAX_FALHAS;
  }

  registrarFalha(chave: string): void {
    this.falhas.set(chave, [...(this.falhas.get(chave) ?? []), this.agora()]);
  }

  limparFalhas(chave: string): void {
    this.falhas.delete(chave);
  }
}
