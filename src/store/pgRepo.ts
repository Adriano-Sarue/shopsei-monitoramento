import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Ocorrencia, Situacao } from '../incidents/queue.js';
import { PortariaPg } from '../portaria/pg.js';
import type { AlarmEvent } from '../protocols/types.js';
import {
  ContaDuplicadaError, LoginDuplicadoError, NaoEncontradoError, RotaDuplicadaError, validarAjustes, validarCliente, validarEmpresa, validarUsuario,
  type Ajustes, type Cliente, type Empresa, type FiltroHistorico, type NovoCliente, type NovoUsuario, type Repositorio, type Rota, type UltimoEvento, type Usuario,
} from './repositorio.js';

const SCHEMA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'schema.sql');

interface OcorrenciaRow {
  id: string;
  empresa_id: string;
  conta: string;
  conta_cadastrada: boolean;
  prioridade: number;
  situacao: Situacao;
  operador: string | null;
  aberta_em: Date;
  atendida_em: Date | null;
  encerrada_em: Date | null;
  adiada_ate: Date | null;
  motivo: string | null;
  conclusao: string | null;
  eventos: AlarmEvent[];
  acoes: { em: string; operador?: string | null; descricao: string }[];
}

const duplicado = (err: unknown) => (err as { code?: string }).code === '23505';

export class PgRepo implements Repositorio {
  private readonly pool: pg.Pool;
  readonly portaria: PortariaPg;

  // Endereço de um PostgreSQL ou um pool pronto (ex.: o banco local embutido).
  constructor(conexao: string | pg.Pool) {
    this.pool = typeof conexao === 'string' ? new pg.Pool({ connectionString: conexao, max: 5 }) : conexao;
    this.portaria = new PortariaPg(this.pool);
  }

  async init(): Promise<void> {
    await this.pool.query(await readFile(SCHEMA, 'utf8'));
  }

  private async transacao<T>(fn: (db: pg.PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const out = await fn(db);
      await db.query('COMMIT');
      return out;
    } catch (err) {
      await db.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      db.release();
    }
  }

  // ---- Empresas e rotas

  async listarEmpresas(): Promise<Empresa[]> {
    const { rows } = await this.pool.query(`
      SELECT e.id, e.nome, e.ativo, e.ajustes,
        COALESCE((SELECT json_agg(json_build_object('canal', canal, 'receptora', receptora, 'linha', linha) ORDER BY canal, receptora, linha)
                  FROM rotas WHERE empresa_id = e.id), '[]') AS rotas
      FROM empresas e ORDER BY e.id`);
    return rows.map((r) => ({ id: Number(r.id), nome: r.nome, ativo: r.ativo, rotas: r.rotas as Rota[], ajustes: validarAjustes(r.ajustes) }));
  }

  private async gravarRotas(db: pg.PoolClient, empresaId: number, rotas: Rota[]): Promise<void> {
    await db.query('DELETE FROM rotas WHERE empresa_id = $1', [empresaId]);
    for (const r of rotas) {
      try {
        await db.query('SAVEPOINT rota');
        await db.query('INSERT INTO rotas (empresa_id, canal, receptora, linha) VALUES ($1, $2, $3, $4)', [empresaId, r.canal, r.receptora, r.linha]);
        await db.query('RELEASE SAVEPOINT rota');
      } catch (err) {
        if (duplicado(err)) throw new RotaDuplicadaError(`A rota ${r.canal} ${r.receptora}/${r.linha} já é de outra empresa`);
        throw err;
      }
    }
  }

  async criarEmpresa(entrada: { nome: string; rotas?: Rota[] }): Promise<Empresa> {
    const v = validarEmpresa(entrada);
    const id = await this.transacao(async (db) => {
      const { rows } = await db.query('INSERT INTO empresas (nome) VALUES ($1) RETURNING id', [v.nome]);
      const novo = Number(rows[0].id);
      await this.gravarRotas(db, novo, v.rotas);
      return novo;
    });
    return (await this.listarEmpresas()).find((e) => e.id === id)!;
  }

  async atualizarEmpresa(id: number, m: { nome?: string; ativo?: boolean; rotas?: Rota[]; ajustes?: Ajustes }): Promise<Empresa> {
    const atual = (await this.listarEmpresas()).find((e) => e.id === id);
    if (!atual) throw new NaoEncontradoError(`Empresa ${id} não existe`);
    const v = validarEmpresa({ nome: m.nome ?? atual.nome, rotas: m.rotas ?? atual.rotas });
    await this.transacao(async (db) => {
      const ajustes = m.ajustes ? validarAjustes(m.ajustes) : atual.ajustes;
      await db.query('UPDATE empresas SET nome = $2, ativo = $3, ajustes = $4 WHERE id = $1', [id, v.nome, m.ativo ?? atual.ativo, JSON.stringify(ajustes)]);
      if (m.rotas) await this.gravarRotas(db, id, v.rotas);
    });
    return (await this.listarEmpresas()).find((e) => e.id === id)!;
  }

  // ---- Eventos e ocorrências

  async salvarEvento(e: AlarmEvent): Promise<void> {
    await this.pool.query('INSERT INTO eventos (empresa_id, recebido_em, conta, codigo, protocolo, payload) VALUES ($1, $2, $3, $4, $5, $6)', [
      e.empresaId ?? null, e.receivedAt, e.account, e.code, e.protocol, JSON.stringify(e),
    ]);
  }

  async salvarOcorrencia(o: Ocorrencia): Promise<void> {
    await this.pool.query(
      `INSERT INTO ocorrencias (id, empresa_id, conta, conta_cadastrada, prioridade, situacao, operador, aberta_em, atendida_em,
                                encerrada_em, adiada_ate, motivo, conclusao, eventos, acoes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (id) DO UPDATE SET conta_cadastrada=$4, prioridade=$5, situacao=$6, operador=$7, atendida_em=$9,
         encerrada_em=$10, adiada_ate=$11, motivo=$12, conclusao=$13, eventos=$14, acoes=$15
       WHERE ocorrencias.empresa_id = $2`,
      [
        o.id, o.empresaId, o.conta, o.contaCadastrada, o.prioridade, o.situacao, o.operador ?? null, o.abertaEm,
        o.atendidaEm ?? null, o.encerradaEm ?? null, o.adiadaAte ?? null, o.motivo ?? null, o.conclusao ?? null,
        JSON.stringify(o.eventos), JSON.stringify(o.acoes),
      ],
    );
  }

  private ocorrencia(r: OcorrenciaRow): Ocorrencia {
    return {
      id: Number(r.id),
      empresaId: Number(r.empresa_id),
      conta: r.conta,
      contaCadastrada: r.conta_cadastrada,
      prioridade: r.prioridade,
      situacao: r.situacao,
      operador: r.operador ?? undefined,
      abertaEm: r.aberta_em,
      atendidaEm: r.atendida_em ?? undefined,
      encerradaEm: r.encerrada_em ?? undefined,
      adiadaAte: r.adiada_ate ?? undefined,
      motivo: r.motivo ?? undefined,
      conclusao: r.conclusao ?? undefined,
      eventos: r.eventos,
      acoes: r.acoes.map((a) => ({ em: new Date(a.em), operador: a.operador ?? undefined, descricao: a.descricao })),
    };
  }

  async carregarOcorrenciasAbertas(): Promise<Ocorrencia[]> {
    const { rows } = await this.pool.query<OcorrenciaRow>("SELECT * FROM ocorrencias WHERE situacao <> 'encerrada' ORDER BY id");
    return rows.map((r) => this.ocorrencia(r));
  }

  async ultimosEventos(): Promise<UltimoEvento[]> {
    const { rows } = await this.pool.query<{ empresa_id: string; conta: string; ultimo: Date }>(
      "SELECT empresa_id, conta, max(recebido_em) AS ultimo FROM eventos WHERE protocolo <> 'INTERNO' AND empresa_id IS NOT NULL GROUP BY empresa_id, conta",
    );
    return rows.map((r) => ({ empresaId: Number(r.empresa_id), conta: r.conta, em: r.ultimo }));
  }

  async listarEncerradas(empresaId: number, f: FiltroHistorico): Promise<Ocorrencia[]> {
    const { rows } = await this.pool.query<OcorrenciaRow>(
      `SELECT * FROM ocorrencias WHERE empresa_id = $1 AND situacao = 'encerrada'
         AND ($2::text IS NULL OR conta = $2) AND ($3::timestamptz IS NULL OR encerrada_em >= $3) AND ($4::timestamptz IS NULL OR encerrada_em <= $4)
       ORDER BY encerrada_em DESC LIMIT $5`,
      [empresaId, f.conta ?? null, f.de ?? null, f.ate ?? null, f.limite],
    );
    return rows.map((r) => this.ocorrencia(r));
  }

  // ---- Clientes

  async listarClientes(empresaId: number): Promise<Cliente[]> {
    const { rows } = await this.pool.query(`
      SELECT c.*,
        COALESCE((SELECT json_agg(numero ORDER BY numero) FROM contas WHERE cliente_id = c.id), '[]') AS contas,
        COALESCE((SELECT json_agg(json_build_object('nome', nome, 'telefone', telefone, 'ordem', ordem) ORDER BY ordem, id)
                  FROM contatos WHERE cliente_id = c.id), '[]') AS contatos,
        COALESCE((SELECT json_agg(json_build_object('nome', nome, 'marca', marca, 'url', url, 'ordem', ordem) ORDER BY ordem, id)
                  FROM cameras WHERE cliente_id = c.id), '[]') AS cameras
      FROM clientes c WHERE c.empresa_id = $1 ORDER BY c.nome`, [empresaId]);
    return rows.map((r) => ({
      id: Number(r.id),
      nome: r.nome,
      endereco: r.endereco ?? undefined,
      tipo: r.tipo ?? undefined,
      observacoes: r.observacoes ?? undefined,
      instrucoes: r.instrucoes ?? undefined,
      intervaloTesteHoras: r.intervalo_teste_horas ?? undefined,
      palavraChave: r.palavra_chave ?? undefined,
      contraSenha: r.contra_senha ?? undefined,
      ativo: r.ativo,
      contas: r.contas as string[],
      contatos: (r.contatos as { nome: string; telefone: string | null; ordem: number }[]).map((x) => ({
        nome: x.nome, telefone: x.telefone ?? undefined, ordem: x.ordem,
      })),
      cameras: (r.cameras as { nome: string; marca: string | null; url: string; ordem: number }[]).map((x) => ({
        nome: x.nome, marca: x.marca ?? undefined, url: x.url, ordem: x.ordem,
      })),
    }));
  }

  private async gravarContasEContatos(db: pg.PoolClient, empresaId: number, id: number, c: NovoCliente): Promise<void> {
    for (const conta of c.contas) {
      try {
        await db.query('SAVEPOINT conta');
        await db.query('INSERT INTO contas (empresa_id, numero, cliente_id) VALUES ($1, $2, $3)', [empresaId, conta, id]);
        await db.query('RELEASE SAVEPOINT conta');
      } catch (err) {
        if (duplicado(err)) throw new ContaDuplicadaError(`A conta ${conta} já pertence a outro cliente`);
        throw err;
      }
    }
    for (const ct of c.contatos) {
      await db.query('INSERT INTO contatos (cliente_id, nome, telefone, ordem) VALUES ($1, $2, $3, $4)', [id, ct.nome, ct.telefone ?? null, ct.ordem]);
    }
    for (const cam of c.cameras ?? []) {
      await db.query('INSERT INTO cameras (cliente_id, nome, marca, url, ordem) VALUES ($1, $2, $3, $4, $5)', [id, cam.nome, cam.marca ?? null, cam.url, cam.ordem]);
    }
  }

  async criarCliente(empresaId: number, entrada: NovoCliente): Promise<Cliente> {
    const c = validarCliente(entrada);
    const id = await this.transacao(async (db) => {
      const { rows } = await db.query(
        `INSERT INTO clientes (empresa_id, nome, endereco, tipo, observacoes, palavra_chave, contra_senha, instrucoes, intervalo_teste_horas)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [empresaId, c.nome, c.endereco ?? null, c.tipo ?? null, c.observacoes ?? null, c.palavraChave ?? null, c.contraSenha ?? null, c.instrucoes ?? null, c.intervaloTesteHoras ?? null],
      );
      const novo = Number(rows[0].id);
      await this.gravarContasEContatos(db, empresaId, novo, c);
      return novo;
    });
    return (await this.listarClientes(empresaId)).find((x) => x.id === id)!;
  }

  async atualizarCliente(empresaId: number, id: number, entrada: NovoCliente): Promise<Cliente> {
    const c = validarCliente(entrada);
    await this.transacao(async (db) => {
      const r = await db.query(
        `UPDATE clientes SET nome=$3, endereco=$4, tipo=$5, observacoes=$6, palavra_chave=$7, contra_senha=$8, instrucoes=$9,
           intervalo_teste_horas=$10 WHERE id=$1 AND empresa_id=$2`,
        [id, empresaId, c.nome, c.endereco ?? null, c.tipo ?? null, c.observacoes ?? null, c.palavraChave ?? null, c.contraSenha ?? null, c.instrucoes ?? null, c.intervaloTesteHoras ?? null],
      );
      if (r.rowCount === 0) throw new NaoEncontradoError(`Cliente ${id} não existe`);
      await db.query('DELETE FROM contas WHERE cliente_id = $1', [id]);
      await db.query('DELETE FROM contatos WHERE cliente_id = $1', [id]);
      await db.query('DELETE FROM cameras WHERE cliente_id = $1', [id]);
      await this.gravarContasEContatos(db, empresaId, id, c);
    });
    return (await this.listarClientes(empresaId)).find((x) => x.id === id)!;
  }

  // ---- Usuários

  private usuario(r: Record<string, unknown>): Usuario {
    return {
      id: Number(r.id), empresaId: r.empresa_id === null ? null : Number(r.empresa_id), login: r.login as string, nome: r.nome as string,
      papel: r.papel as Usuario['papel'], ativo: r.ativo as boolean, senhaHash: r.senha_hash as string,
    };
  }

  async listarUsuarios(empresaId: number | null): Promise<Usuario[]> {
    const { rows } = await this.pool.query('SELECT * FROM usuarios WHERE empresa_id IS NOT DISTINCT FROM $1 ORDER BY nome', [empresaId]);
    return rows.map((r) => this.usuario(r));
  }

  async buscarUsuario(login: string): Promise<Usuario | undefined> {
    const { rows } = await this.pool.query('SELECT * FROM usuarios WHERE login = $1', [login.trim().toLowerCase()]);
    return rows[0] ? this.usuario(rows[0]) : undefined;
  }

  async criarUsuario(entrada: NovoUsuario): Promise<Usuario> {
    const v = validarUsuario(entrada);
    try {
      const { rows } = await this.pool.query(
        'INSERT INTO usuarios (empresa_id, login, nome, papel, senha_hash) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [entrada.empresaId, v.login, v.nome, v.papel, entrada.senhaHash],
      );
      return this.usuario(rows[0]);
    } catch (err) {
      if (duplicado(err)) throw new LoginDuplicadoError(`O login ${v.login} já existe`);
      if ((err as { code?: string }).code === '23503') throw new NaoEncontradoError(`Empresa ${entrada.empresaId} não existe`);
      throw err;
    }
  }

  async atualizarUsuario(empresaId: number | null, id: number, m: Partial<Pick<Usuario, 'nome' | 'papel' | 'ativo' | 'senhaHash'>>): Promise<Usuario> {
    const { rows: atual } = await this.pool.query('SELECT * FROM usuarios WHERE id = $1 AND empresa_id IS NOT DISTINCT FROM $2', [id, empresaId]);
    if (!atual[0]) throw new NaoEncontradoError(`Usuário ${id} não existe`);
    const u = this.usuario(atual[0]);
    const v = validarUsuario({ login: u.login, nome: m.nome ?? u.nome, papel: m.papel ?? u.papel });
    const { rows } = await this.pool.query('UPDATE usuarios SET nome=$2, papel=$3, ativo=$4, senha_hash=$5 WHERE id=$1 RETURNING *', [id, v.nome, v.papel, m.ativo ?? u.ativo, m.senhaHash ?? u.senhaHash]);
    return this.usuario(rows[0]);
  }

  async fechar(): Promise<void> {
    await this.pool.end();
  }
}
