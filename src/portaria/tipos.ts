// Portaria remota: condomínios atendidos à distância, suas unidades, quem mora ou pode entrar, e o registro
// de cada atendimento do operador (visitante, entrega, prestador...).

export interface NovoCondominio {
  nome: string;
  endereco?: string;
  // Regras do condomínio para o operador (horário de mudança, entregas só na portaria, síndico etc.).
  instrucoes?: string;
}

export interface Condominio extends NovoCondominio {
  id: number;
  ativo: boolean;
  unidades: number;
}

// morador e autorizado entram; prestador entra conforme a regra do condomínio; proibido nunca é liberado.
export type TipoPessoa = 'morador' | 'autorizado' | 'prestador' | 'proibido';
export const TIPOS_PESSOA: TipoPessoa[] = ['morador', 'autorizado', 'prestador', 'proibido'];

export interface Pessoa {
  nome: string;
  tipo: TipoPessoa;
  telefone?: string;
  documento?: string;
  observacao?: string;
  // Autorização com prazo (visita de fim de semana, obra): depois dessa data vale como não cadastrada.
  validoAte?: string;
}

export interface NovaUnidade {
  bloco?: string;
  numero: string;
  observacao?: string;
  pessoas: Pessoa[];
}

export interface Unidade extends NovaUnidade {
  id: number;
  condominioId: number;
}

export type TipoAtendimento = 'visitante' | 'entrega' | 'prestador' | 'morador' | 'outro';
export const TIPOS_ATENDIMENTO: TipoAtendimento[] = ['visitante', 'entrega', 'prestador', 'morador', 'outro'];
export type Decisao = 'liberado' | 'negado' | 'sem_resposta';
export const DECISOES: Decisao[] = ['liberado', 'negado', 'sem_resposta'];

export interface NovoAtendimento {
  condominioId: number;
  unidadeId?: number;
  tipo: TipoAtendimento;
  // Quem estava no portão.
  visitante: string;
  documento?: string;
  decisao: Decisao;
  // Morador que autorizou (por telefone, interfone ou cadastro).
  autorizadoPor?: string;
  observacao?: string;
}

export interface Atendimento extends NovoAtendimento {
  id: number;
  em: Date;
  operador: string;
  // Bloco e número no momento do atendimento.
  unidade?: string;
}

export const rotuloUnidade = (u: { bloco?: string; numero: string }): string => (u.bloco ? `${u.bloco} ${u.numero}` : u.numero);

export interface FiltroAtendimentos {
  condominioId?: number;
  de?: Date;
  ate?: Date;
  limite: number;
}

// Leitor facial ou interfone do condomínio, alcançado pela VPN.
export interface NovoEquipamento {
  nome: string;
  marca: 'hikvision';
  // Endereço na VPN, ex.: http://10.8.0.12
  endereco: string;
  usuario: string;
  // Número da porta que o comando de abrir aciona (1 na maioria dos leitores).
  porta: number;
  ativo: boolean;
}

export interface Equipamento extends NovoEquipamento {
  id: number;
  condominioId: number;
  empresaId: number;
  // Senha cifrada pelo Cofre; nunca sai da API.
  senhaCifrada: string;
  // Parte secreta do endereço para onde o equipamento envia os eventos (/hik/<token>).
  tokenEventos: string;
}

export interface Abertura {
  id: number;
  // Vazio se o equipamento foi apagado depois.
  equipamentoId?: number;
  condominioId: number;
  em: Date;
  operador: string;
  ok: boolean;
  erro?: string;
}

export interface RepoPortaria {
  listarCondominios(empresaId: number): Promise<Condominio[]>;
  criarCondominio(empresaId: number, c: NovoCondominio): Promise<Condominio>;
  atualizarCondominio(empresaId: number, id: number, c: NovoCondominio & { ativo?: boolean }): Promise<Condominio>;
  listarUnidades(empresaId: number, condominioId: number): Promise<Unidade[]>;
  // Cria (sem id) ou substitui a unidade e a lista de pessoas dela.
  salvarUnidade(empresaId: number, condominioId: number, u: NovaUnidade & { id?: number }): Promise<Unidade>;
  removerUnidade(empresaId: number, condominioId: number, id: number): Promise<void>;
  registrarAtendimento(empresaId: number, a: NovoAtendimento, operador: string, em: Date): Promise<Atendimento>;
  listarAtendimentos(empresaId: number, f: FiltroAtendimentos): Promise<Atendimento[]>;
  listarEquipamentos(empresaId: number, condominioId: number): Promise<Equipamento[]>;
  // Todos os equipamentos ativos de condomínios ativos, de todas as empresas (para acompanhar as chamadas).
  equipamentosAtivos(): Promise<Equipamento[]>;
  buscarEquipamento(empresaId: number, id: number): Promise<Equipamento | undefined>;
  equipamentoPorToken(token: string): Promise<Equipamento | undefined>;
  // Sem senhaCifrada numa edição, a senha atual fica.
  salvarEquipamento(empresaId: number, condominioId: number, e: NovoEquipamento & { id?: number; senhaCifrada?: string }): Promise<Equipamento>;
  removerEquipamento(empresaId: number, condominioId: number, id: number): Promise<void>;
  registrarAbertura(empresaId: number, a: Omit<Abertura, 'id'>): Promise<Abertura>;
  listarAberturas(empresaId: number, condominioId: number, limite: number): Promise<Abertura[]>;
}

export class UnidadeDuplicadaError extends Error {}

export function validarEquipamento(e: NovoEquipamento): NovoEquipamento {
  const nome = curto(e.nome, 80, 'Nome');
  if (!nome) throw new Error('Nome do equipamento é obrigatório (ex.: Portão social)');
  if (e.marca !== 'hikvision') throw new Error('Marca não suportada (por enquanto só Hikvision)');
  const endereco = curto(e.endereco, 200, 'Endereço')?.replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(endereco ?? '');
  } catch {
    throw new Error('Endereço do equipamento inválido (ex.: http://10.8.0.12)');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Endereço do equipamento deve começar com http:// ou https://');
  if (url.username || url.password || (url.pathname !== '/' && url.pathname !== '') || url.search) throw new Error('Informe só o endereço do equipamento, sem caminho nem senha (ex.: http://10.8.0.12)');
  const usuario = curto(e.usuario, 60, 'Usuário');
  if (!usuario) throw new Error('Usuário do equipamento é obrigatório');
  const porta = Number(e.porta ?? 1);
  if (!Number.isInteger(porta) || porta < 1 || porta > 8) throw new Error('Porta deve ser de 1 a 8');
  return { nome, marca: 'hikvision', endereco: `${url.protocol}//${url.host}`, usuario, porta, ativo: e.ativo !== false };
}

const curto = (v: unknown, max: number, campo: string): string | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new Error(`${campo} inválido`);
  const t = v.trim();
  if (t.length > max) throw new Error(`${campo} longo demais (máximo ${max} caracteres)`);
  return t || undefined;
};

// Campos não preenchidos ficam fora do objeto (igual ao que volta do banco).
const semVazios = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

export function validarCondominio(c: NovoCondominio): NovoCondominio {
  const nome = curto(c.nome, 120, 'Nome');
  if (!nome) throw new Error('Nome do condomínio é obrigatório');
  return { nome, endereco: curto(c.endereco, 200, 'Endereço'), instrucoes: curto(c.instrucoes, 2000, 'Instruções') };
}

// Bloco e número em maiúsculas e sem espaços sobrando: "a", " A " e "A" são o mesmo bloco.
const ident = (v: unknown, campo: string): string | undefined => curto(v, 20, campo)?.toUpperCase().replace(/\s+/g, ' ');

export function validarUnidade(u: NovaUnidade): NovaUnidade {
  const numero = ident(u.numero, 'Número');
  if (!numero) throw new Error('Número da unidade é obrigatório');
  if (!Array.isArray(u.pessoas)) throw new Error('Lista de pessoas inválida');
  if (u.pessoas.length > 50) throw new Error('No máximo 50 pessoas por unidade');
  const pessoas = u.pessoas
    .filter((p) => typeof p?.nome === 'string' && p.nome.trim())
    .map((p): Pessoa => {
      if (!TIPOS_PESSOA.includes(p.tipo)) throw new Error(`Tipo de pessoa inválido: ${String(p.tipo)}`);
      const validoAte = curto(p.validoAte, 10, 'Validade');
      if (validoAte && !/^\d{4}-\d{2}-\d{2}$/.test(validoAte)) throw new Error('Validade deve ser uma data (AAAA-MM-DD)');
      return semVazios({
        nome: curto(p.nome, 120, 'Nome')!, tipo: p.tipo, telefone: curto(p.telefone, 30, 'Telefone'),
        documento: curto(p.documento, 30, 'Documento'), observacao: curto(p.observacao, 300, 'Observação'), validoAte,
      });
    });
  return { bloco: ident(u.bloco, 'Bloco'), numero, observacao: curto(u.observacao, 300, 'Observação'), pessoas };
}

export function validarAtendimento(a: NovoAtendimento): NovoAtendimento {
  if (!Number.isInteger(a.condominioId) || a.condominioId < 1) throw new Error('Escolha o condomínio');
  if (a.unidadeId !== undefined && (!Number.isInteger(a.unidadeId) || a.unidadeId < 1)) throw new Error('Unidade inválida');
  if (!TIPOS_ATENDIMENTO.includes(a.tipo)) throw new Error('Tipo de atendimento inválido');
  if (!DECISOES.includes(a.decisao)) throw new Error('Decisão inválida');
  const visitante = curto(a.visitante, 120, 'Nome de quem está no portão');
  if (!visitante) throw new Error('Informe quem está no portão');
  return {
    condominioId: a.condominioId, unidadeId: a.unidadeId, tipo: a.tipo, visitante, decisao: a.decisao,
    documento: curto(a.documento, 30, 'Documento'), autorizadoPor: curto(a.autorizadoPor, 120, 'Autorizado por'),
    observacao: curto(a.observacao, 500, 'Observação'),
  };
}

// Autorização vencida não vale: o operador vê a pessoa riscada e precisa confirmar com o morador.
export function pessoaValida(p: Pessoa, hoje: Date): boolean {
  if (!p.validoAte) return true;
  const dia = hoje.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  return p.validoAte >= dia;
}

// Importação em lote (colar do Excel): uma pessoa por linha, "bloco;número;nome;telefone;tipo".
// Linhas da mesma unidade se juntam; sem nome, a linha só cria a unidade.
export function lerImportacao(texto: string): NovaUnidade[] {
  const unidades = new Map<string, NovaUnidade>();
  const linhas = texto.split(/\r?\n/);
  linhas.forEach((linha, i) => {
    if (!linha.trim()) return;
    const c = linha.split(/[;\t]/).map((x) => x.trim());
    if (i === 0 && /^bloco$/i.test(c[0] ?? '')) return; // cabeçalho
    const [bloco, numero, nome, telefone, tipo] = c;
    if (!numero) throw new Error(`Linha ${i + 1}: falta o número da unidade`);
    const t = (tipo || 'morador').toLowerCase() as TipoPessoa;
    if (!TIPOS_PESSOA.includes(t)) throw new Error(`Linha ${i + 1}: tipo "${tipo}" (use ${TIPOS_PESSOA.join(', ')})`);
    const u = validarUnidade({ bloco, numero, pessoas: [] });
    const chave = `${u.bloco ?? ''}|${u.numero}`;
    const atual = unidades.get(chave) ?? u;
    if (nome) atual.pessoas.push({ nome, telefone: telefone || undefined, tipo: t });
    unidades.set(chave, atual);
  });
  if (unidades.size > 2000) throw new Error('No máximo 2000 unidades por importação');
  return [...unidades.values()].map(validarUnidade);
}
