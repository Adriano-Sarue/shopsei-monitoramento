import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { Ocorrencia, Situacao } from '../incidents/queue.js';
import type { AlarmEvent } from '../protocols/types.js';
import { ContaDuplicadaError, validarCliente, type Cliente, type NovoCliente, type Repositorio } from './repositorio.js';

const SCHEMA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'schema.sql');

interface OcorrenciaRow {
  id: string;
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

export class PgRepo implements Repositorio {
  private readonly pool: pg.Pool;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 5 });
  }

  async init(): Promise<void> {
    await this.pool.query(await readFile(SCHEMA, 'utf8'));
  }

  async salvarEvento(e: AlarmEvent): Promise<void> {
    await this.pool.query('INSERT INTO eventos (recebido_em, conta, codigo, protocolo, payload) VALUES ($1, $2, $3, $4, $5)', [
      e.receivedAt, e.account, e.code, e.protocol, JSON.stringify(e),
    ]);
  }

  async salvarOcorrencia(o: Ocorrencia): Promise<void> {
    await this.pool.query(
      `INSERT INTO ocorrencias (id, conta, conta_cadastrada, prioridade, situacao, operador, aberta_em, atendida_em,
                                encerrada_em, adiada_ate, motivo, conclusao, eventos, acoes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO UPDATE SET conta_cadastrada=$3, prioridade=$4, situacao=$5, operador=$6, atendida_em=$8,
         encerrada_em=$9, adiada_ate=$10, motivo=$11, conclusao=$12, eventos=$13, acoes=$14`,
      [
        o.id, o.conta, o.contaCadastrada, o.prioridade, o.situacao, o.operador ?? null, o.abertaEm,
        o.atendidaEm ?? null, o.encerradaEm ?? null, o.adiadaAte ?? null, o.motivo ?? null, o.conclusao ?? null,
        JSON.stringify(o.eventos), JSON.stringify(o.acoes),
      ],
    );
  }

  async carregarOcorrenciasAbertas(): Promise<Ocorrencia[]> {
    const { rows } = await this.pool.query<OcorrenciaRow>("SELECT * FROM ocorrencias WHERE situacao <> 'encerrada' ORDER BY id");
    return rows.map((r) => ({
      id: Number(r.id),
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
    }));
  }

  async listarClientes(): Promise<Cliente[]> {
    const { rows } = await this.pool.query(`
      SELECT c.*,
        COALESCE((SELECT json_agg(numero ORDER BY numero) FROM contas WHERE cliente_id = c.id), '[]') AS contas,
        COALESCE((SELECT json_agg(json_build_object('nome', nome, 'telefone', telefone, 'ordem', ordem) ORDER BY ordem, id)
                  FROM contatos WHERE cliente_id = c.id), '[]') AS contatos
      FROM clientes c ORDER BY c.nome`);
    return rows.map((r) => ({
      id: Number(r.id),
      nome: r.nome,
      endereco: r.endereco ?? undefined,
      tipo: r.tipo ?? undefined,
      observacoes: r.observacoes ?? undefined,
      palavraChave: r.palavra_chave ?? undefined,
      contraSenha: r.contra_senha ?? undefined,
      ativo: r.ativo,
      contas: r.contas as string[],
      contatos: (r.contatos as { nome: string; telefone: string | null; ordem: number }[]).map((x) => ({
        nome: x.nome, telefone: x.telefone ?? undefined, ordem: x.ordem,
      })),
    }));
  }

  private async gravarContasEContatos(db: pg.PoolClient, id: number, c: NovoCliente): Promise<void> {
    for (const conta of c.contas) {
      try {
        await db.query('SAVEPOINT conta');
        await db.query('INSERT INTO contas (numero, cliente_id) VALUES ($1, $2)', [conta, id]);
        await db.query('RELEASE SAVEPOINT conta');
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw new ContaDuplicadaError(`A conta ${conta} já pertence a outro cliente`);
        throw err;
      }
    }
    for (const ct of c.contatos) {
      await db.query('INSERT INTO contatos (cliente_id, nome, telefone, ordem) VALUES ($1, $2, $3, $4)', [id, ct.nome, ct.telefone ?? null, ct.ordem]);
    }
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

  async criarCliente(entrada: NovoCliente): Promise<Cliente> {
    const c = validarCliente(entrada);
    const id = await this.transacao(async (db) => {
      const { rows } = await db.query(
        'INSERT INTO clientes (nome, endereco, tipo, observacoes, palavra_chave, contra_senha) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
        [c.nome, c.endereco ?? null, c.tipo ?? null, c.observacoes ?? null, c.palavraChave ?? null, c.contraSenha ?? null],
      );
      const novo = Number(rows[0].id);
      await this.gravarContasEContatos(db, novo, c);
      return novo;
    });
    return (await this.listarClientes()).find((x) => x.id === id)!;
  }

  async atualizarCliente(id: number, entrada: NovoCliente): Promise<Cliente> {
    const c = validarCliente(entrada);
    await this.transacao(async (db) => {
      const r = await db.query(
        'UPDATE clientes SET nome=$2, endereco=$3, tipo=$4, observacoes=$5, palavra_chave=$6, contra_senha=$7 WHERE id=$1',
        [id, c.nome, c.endereco ?? null, c.tipo ?? null, c.observacoes ?? null, c.palavraChave ?? null, c.contraSenha ?? null],
      );
      if (r.rowCount === 0) throw new Error(`Cliente ${id} não existe`);
      await db.query('DELETE FROM contas WHERE cliente_id = $1', [id]);
      await db.query('DELETE FROM contatos WHERE cliente_id = $1', [id]);
      await this.gravarContasEContatos(db, id, c);
    });
    return (await this.listarClientes()).find((x) => x.id === id)!;
  }

  async fechar(): Promise<void> {
    await this.pool.end();
  }
}
