import { randomBytes } from 'node:crypto';
import type { Papel } from '../store/repositorio.js';

export interface Sessao {
  usuarioId: number;
  // Empresa do usuário; null = dono do sistema.
  empresaId: number | null;
  login: string;
  nome: string;
  papel: Papel;
  expira: number;
  visto: number;
  // Tela travada na troca de turno: só passa o turno ou destrava com a senha de quem está saindo.
  travada?: boolean;
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

  revogarEmpresa(empresaId: number): void {
    for (const [t, s] of this.porToken) if (s.empresaId === empresaId) this.porToken.delete(t);
  }

  temSessao(empresaId: number | null, nome: string): boolean {
    return [...this.porToken.values()].some((s) => s.empresaId === empresaId && s.nome === nome);
  }

  // Nomes cuja última chamada (o console consulta a cada 2 s) foi há mais de ms. Quem tem
  // mais de uma sessão só conta como ocioso se todas estiverem paradas.
  ociosos(ms: number): { empresaId: number; nome: string }[] {
    const ultimo = new Map<string, { empresaId: number; nome: string; visto: number }>();
    for (const s of this.porToken.values()) {
      if (s.empresaId === null) continue;
      const chave = `${s.empresaId}|${s.nome}`;
      const v = ultimo.get(chave);
      if (!v || s.visto > v.visto) ultimo.set(chave, { empresaId: s.empresaId, nome: s.nome, visto: s.visto });
    }
    return [...ultimo.values()].filter((v) => v.visto < this.agora() - ms).map(({ empresaId, nome }) => ({ empresaId, nome }));
  }

  // Apaga sessões vencidas e tentativas antigas que ninguém mais consulta.
  limpar(): void {
    for (const [t, s] of this.porToken) if (s.expira < this.agora()) this.porToken.delete(t);
    for (const chave of this.falhas.keys()) this.bloqueado(chave);
  }
}
