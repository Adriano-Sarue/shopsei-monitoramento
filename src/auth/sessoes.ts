import { randomBytes } from 'node:crypto';
import type { Papel } from '../store/repositorio.js';

export interface Sessao {
  usuarioId: number;
  login: string;
  nome: string;
  papel: Papel;
  expira: number;
  visto: number;
}

const DURACAO_MS = 12 * 60 * 60 * 1000;
const JANELA_MS = 5 * 60 * 1000;
const MAX_FALHAS = 5;

// Sessões ficam em memória: reiniciar o servidor desloga todo mundo (a fila, não).
export class Sessoes {
  private readonly porToken = new Map<string, Sessao>();
  private readonly falhas = new Map<string, number[]>();

  constructor(private readonly agora: () => number = Date.now) {}

  criar(u: Omit<Sessao, 'expira' | 'visto'>): string {
    const token = randomBytes(32).toString('base64url');
    this.porToken.set(token, { ...u, expira: this.agora() + DURACAO_MS, visto: this.agora() });
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
    s.visto = this.agora();
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
  bloqueado(chave: string, max = MAX_FALHAS): boolean {
    const recentes = (this.falhas.get(chave) ?? []).filter((t) => t > this.agora() - JANELA_MS);
    if (recentes.length) this.falhas.set(chave, recentes);
    else this.falhas.delete(chave);
    return recentes.length >= max;
  }

  registrarFalha(chave: string): void {
    this.falhas.set(chave, [...(this.falhas.get(chave) ?? []), this.agora()]);
  }

  limparFalhas(chave: string): void {
    this.falhas.delete(chave);
  }

  temSessao(nome: string): boolean {
    return [...this.porToken.values()].some((s) => s.nome === nome);
  }

  // Nomes cuja última chamada (o console consulta a cada 2 s) foi há mais de ms. Quem tem
  // mais de uma sessão só conta como ocioso se todas estiverem paradas.
  ociosos(ms: number): string[] {
    const ultimo = new Map<string, number>();
    for (const s of this.porToken.values()) ultimo.set(s.nome, Math.max(ultimo.get(s.nome) ?? 0, s.visto));
    return [...ultimo].filter(([, v]) => v < this.agora() - ms).map(([nome]) => nome);
  }

  // Apaga sessões vencidas e tentativas antigas que ninguém mais consulta.
  limpar(): void {
    for (const [t, s] of this.porToken) if (s.expira < this.agora()) this.porToken.delete(t);
    for (const chave of this.falhas.keys()) this.bloqueado(chave);
  }
}
