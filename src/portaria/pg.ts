import type pg from 'pg';
import { NaoEncontradoError } from '../store/repositorio.js';
import {
  rotuloUnidade, UnidadeDuplicadaError, validarAtendimento, validarCondominio, validarUnidade,
  type Atendimento, type Condominio, type FiltroAtendimentos, type NovaUnidade, type NovoAtendimento, type NovoCondominio, type Pessoa, type RepoPortaria, type Unidade,
} from './tipos.js';

const duplicado = (err: unknown) => (err as { code?: string }).code === '23505';
const ou = <T>(v: T | null): T | undefined => v ?? undefined;

const COND = `SELECT c.id, c.nome, c.endereco, c.instrucoes, c.ativo, (SELECT count(*) FROM unidades u WHERE u.condominio_id = c.id) AS unidades FROM condominios c`;

function condominio(r: Record<string, unknown>): Condominio {
  return {
    id: Number(r.id), nome: r.nome as string, endereco: ou(r.endereco as string | null), instrucoes: ou(r.instrucoes as string | null),
    ativo: r.ativo as boolean, unidades: Number(r.unidades),
  };
}

function unidade(r: Record<string, unknown>): Unidade {
  return {
    id: Number(r.id), condominioId: Number(r.condominio_id), bloco: (r.bloco as string) || undefined, numero: r.numero as string,
    observacao: ou(r.observacao as string | null), pessoas: r.pessoas as Pessoa[],
  };
}

function atendimento(r: Record<string, unknown>): Atendimento {
  return {
    id: Number(r.id), condominioId: Number(r.condominio_id), unidadeId: r.unidade_id === null ? undefined : Number(r.unidade_id),
    unidade: ou(r.unidade as string | null), em: r.em as Date, operador: r.operador as string, tipo: r.tipo as Atendimento['tipo'],
    visitante: r.visitante as string, documento: ou(r.documento as string | null), decisao: r.decisao as Atendimento['decisao'],
    autorizadoPor: ou(r.autorizado_por as string | null), observacao: ou(r.observacao as string | null),
  };
}

// Pessoas são gravadas sem campos vazios, para o JSON ficar igual ao da versão em memória.
const limpar = (ps: Pessoa[]) => ps.map((p) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)));

export class PortariaPg implements RepoPortaria {
  constructor(private readonly pool: pg.Pool) {}

  private async exigirCondominio(empresaId: number, id: number): Promise<void> {
    const { rowCount } = await this.pool.query('SELECT 1 FROM condominios WHERE id = $1 AND empresa_id = $2', [id, empresaId]);
    if (!rowCount) throw new NaoEncontradoError(`Condomínio ${id} não existe`);
  }

  async listarCondominios(empresaId: number): Promise<Condominio[]> {
    const { rows } = await this.pool.query(`${COND} WHERE c.empresa_id = $1 ORDER BY c.nome`, [empresaId]);
    return rows.map(condominio);
  }

  async criarCondominio(empresaId: number, entrada: NovoCondominio): Promise<Condominio> {
    const v = validarCondominio(entrada);
    const { rows } = await this.pool.query('INSERT INTO condominios (empresa_id, nome, endereco, instrucoes) VALUES ($1, $2, $3, $4) RETURNING id',
      [empresaId, v.nome, v.endereco ?? null, v.instrucoes ?? null]);
    return (await this.pool.query(`${COND} WHERE c.id = $1`, [rows[0].id])).rows.map(condominio)[0]!;
  }

  async atualizarCondominio(empresaId: number, id: number, entrada: NovoCondominio & { ativo?: boolean }): Promise<Condominio> {
    const v = validarCondominio(entrada);
    const { rowCount } = await this.pool.query(
      'UPDATE condominios SET nome = $3, endereco = $4, instrucoes = $5, ativo = COALESCE($6, ativo) WHERE id = $1 AND empresa_id = $2',
      [id, empresaId, v.nome, v.endereco ?? null, v.instrucoes ?? null, entrada.ativo ?? null]);
    if (!rowCount) throw new NaoEncontradoError(`Condomínio ${id} não existe`);
    return (await this.pool.query(`${COND} WHERE c.id = $1`, [id])).rows.map(condominio)[0]!;
  }

  async listarUnidades(empresaId: number, condominioId: number): Promise<Unidade[]> {
    await this.exigirCondominio(empresaId, condominioId);
    const { rows } = await this.pool.query('SELECT * FROM unidades WHERE condominio_id = $1 ORDER BY id', [condominioId]);
    return rows.map(unidade);
  }

  async salvarUnidade(empresaId: number, condominioId: number, entrada: NovaUnidade & { id?: number }): Promise<Unidade> {
    await this.exigirCondominio(empresaId, condominioId);
    const v = validarUnidade(entrada);
    const valores = [condominioId, v.bloco ?? '', v.numero, v.observacao ?? null, JSON.stringify(limpar(v.pessoas))];
    try {
      const { rows } = entrada.id === undefined
        ? await this.pool.query('INSERT INTO unidades (condominio_id, bloco, numero, observacao, pessoas) VALUES ($1, $2, $3, $4, $5) RETURNING *', valores)
        : await this.pool.query('UPDATE unidades SET bloco = $2, numero = $3, observacao = $4, pessoas = $5 WHERE condominio_id = $1 AND id = $6 RETURNING *', [...valores, entrada.id]);
      if (!rows[0]) throw new NaoEncontradoError(`Unidade ${entrada.id} não existe`);
      return unidade(rows[0]);
    } catch (err) {
      if (duplicado(err)) throw new UnidadeDuplicadaError(`A unidade ${rotuloUnidade(v)} já existe`);
      throw err;
    }
  }

  async removerUnidade(empresaId: number, condominioId: number, id: number): Promise<void> {
    await this.exigirCondominio(empresaId, condominioId);
    const { rowCount } = await this.pool.query('DELETE FROM unidades WHERE condominio_id = $1 AND id = $2', [condominioId, id]);
    if (!rowCount) throw new NaoEncontradoError(`Unidade ${id} não existe`);
  }

  async registrarAtendimento(empresaId: number, entrada: NovoAtendimento, operador: string, em: Date): Promise<Atendimento> {
    const v = validarAtendimento(entrada);
    await this.exigirCondominio(empresaId, v.condominioId);
    let rotulo: string | undefined;
    if (v.unidadeId !== undefined) {
      const { rows } = await this.pool.query('SELECT bloco, numero FROM unidades WHERE id = $1 AND condominio_id = $2', [v.unidadeId, v.condominioId]);
      if (!rows[0]) throw new NaoEncontradoError(`Unidade ${v.unidadeId} não existe`);
      rotulo = rotuloUnidade({ bloco: rows[0].bloco || undefined, numero: rows[0].numero });
    }
    const { rows } = await this.pool.query(
      `INSERT INTO atendimentos_portaria (empresa_id, condominio_id, unidade_id, unidade, em, operador, tipo, visitante, documento, decisao, autorizado_por, observacao)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
      [empresaId, v.condominioId, v.unidadeId ?? null, rotulo ?? null, em, operador, v.tipo, v.visitante, v.documento ?? null, v.decisao, v.autorizadoPor ?? null, v.observacao ?? null]);
    return atendimento(rows[0]);
  }

  async listarAtendimentos(empresaId: number, f: FiltroAtendimentos): Promise<Atendimento[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM atendimentos_portaria WHERE empresa_id = $1 AND ($2::bigint IS NULL OR condominio_id = $2)
       AND ($3::timestamptz IS NULL OR em >= $3) AND ($4::timestamptz IS NULL OR em <= $4) ORDER BY em DESC, id DESC LIMIT $5`,
      [empresaId, f.condominioId ?? null, f.de ?? null, f.ate ?? null, f.limite]);
    return rows.map(atendimento);
  }
}
