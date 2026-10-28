import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { NaoEncontradoError } from '../store/repositorio.js';
import {
  rotuloUnidade, UnidadeDuplicadaError, validarAtendimento, validarCondominio, validarEquipamento, validarUnidade,
  type Abertura, type Atendimento, type Equipamento, type NovoEquipamento, type Condominio, type FiltroAtendimentos, type NovaUnidade, type NovoAtendimento, type NovoCondominio, type Pessoa, type RepoPortaria, type Unidade,
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

function equipamento(r: Record<string, unknown>): Equipamento {
  return {
    id: Number(r.id), empresaId: Number(r.empresa_id), condominioId: Number(r.condominio_id), nome: r.nome as string, marca: r.marca as 'hikvision',
    endereco: r.endereco as string, usuario: r.usuario as string, senhaCifrada: r.senha_cifrada as string, porta: Number(r.porta),
    ativo: r.ativo as boolean, tokenEventos: r.token_eventos as string,
  };
}

function abertura(r: Record<string, unknown>): Abertura {
  return {
    id: Number(r.id), condominioId: Number(r.condominio_id), equipamentoId: r.equipamento_id === null ? undefined : Number(r.equipamento_id),
    em: r.em as Date, operador: r.operador as string, ok: r.ok as boolean, erro: ou(r.erro as string | null),
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

  async listarEquipamentos(empresaId: number, condominioId: number): Promise<Equipamento[]> {
    await this.exigirCondominio(empresaId, condominioId);
    const { rows } = await this.pool.query('SELECT * FROM equipamentos_portaria WHERE condominio_id = $1 ORDER BY id', [condominioId]);
    return rows.map(equipamento);
  }

  async equipamentosAtivos(): Promise<Equipamento[]> {
    const { rows } = await this.pool.query(`SELECT e.* FROM equipamentos_portaria e JOIN condominios c ON c.id = e.condominio_id
      WHERE e.ativo AND c.ativo ORDER BY e.id`);
    return rows.map(equipamento);
  }

  async buscarEquipamento(empresaId: number, id: number): Promise<Equipamento | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM equipamentos_portaria WHERE id = $1 AND empresa_id = $2', [id, empresaId]);
    return rows[0] && equipamento(rows[0]);
  }

  async equipamentoPorToken(token: string): Promise<Equipamento | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM equipamentos_portaria WHERE token_eventos = $1', [token]);
    return rows[0] && equipamento(rows[0]);
  }

  async salvarEquipamento(empresaId: number, condominioId: number, entrada: NovoEquipamento & { id?: number; senhaCifrada?: string }): Promise<Equipamento> {
    await this.exigirCondominio(empresaId, condominioId);
    const v = validarEquipamento(entrada);
    const valores = [condominioId, v.nome, v.marca, v.endereco, v.usuario, v.porta, v.ativo];
    if (entrada.id !== undefined) {
      const { rows } = await this.pool.query(
        `UPDATE equipamentos_portaria SET nome = $2, marca = $3, endereco = $4, usuario = $5, porta = $6, ativo = $7, senha_cifrada = COALESCE($8, senha_cifrada)
         WHERE condominio_id = $1 AND id = $9 RETURNING *`, [...valores, entrada.senhaCifrada ?? null, entrada.id]);
      if (!rows[0]) throw new NaoEncontradoError(`Equipamento ${entrada.id} não existe`);
      return equipamento(rows[0]);
    }
    if (!entrada.senhaCifrada) throw new Error('Senha do equipamento é obrigatória');
    const { rows } = await this.pool.query(
      `INSERT INTO equipamentos_portaria (condominio_id, nome, marca, endereco, usuario, porta, ativo, senha_cifrada, token_eventos, empresa_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`, [...valores, entrada.senhaCifrada, randomBytes(18).toString('base64url'), empresaId]);
    return equipamento(rows[0]);
  }

  async removerEquipamento(empresaId: number, condominioId: number, id: number): Promise<void> {
    await this.exigirCondominio(empresaId, condominioId);
    const { rowCount } = await this.pool.query('DELETE FROM equipamentos_portaria WHERE condominio_id = $1 AND id = $2', [condominioId, id]);
    if (!rowCount) throw new NaoEncontradoError(`Equipamento ${id} não existe`);
  }

  async registrarAbertura(empresaId: number, a: Omit<Abertura, 'id'>): Promise<Abertura> {
    const { rows } = await this.pool.query(
      `INSERT INTO aberturas_porta (empresa_id, condominio_id, equipamento_id, em, operador, ok, erro) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [empresaId, a.condominioId, a.equipamentoId ?? null, a.em, a.operador, a.ok, a.erro ?? null]);
    return abertura(rows[0]);
  }

  async listarAberturas(empresaId: number, condominioId: number, limite: number): Promise<Abertura[]> {
    const { rows } = await this.pool.query('SELECT * FROM aberturas_porta WHERE empresa_id = $1 AND condominio_id = $2 ORDER BY em DESC, id DESC LIMIT $3', [empresaId, condominioId, limite]);
    return rows.map(abertura);
  }
}
