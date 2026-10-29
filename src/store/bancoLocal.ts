import type pg from 'pg';

// Banco local para teste sem instalar nada: PostgreSQL embutido (PGlite) gravando numa pasta. O PgRepo usa este
// adaptador no lugar do pool do pg. Uma operação por vez: quem abre uma transação segura o banco até liberar.
export async function abrirBancoLocal(pasta: string): Promise<pg.Pool> {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create(pasta);
  let fila: Promise<void> = Promise.resolve();
  const vez = async (): Promise<() => void> => {
    let liberar!: () => void;
    const anterior = fila;
    fila = new Promise<void>((r) => { liberar = r; });
    await anterior;
    return liberar;
  };
  const executar = async (texto: string, valores?: unknown[]) => {
    // Sem parâmetros pode haver vários comandos (o schema.sql), que só o exec aceita.
    if (!valores || valores.length === 0) {
      const res = await db.exec(texto);
      const ultimo = res.at(-1);
      return { rows: ultimo?.rows ?? [], rowCount: Math.max(ultimo?.affectedRows ?? 0, ultimo?.rows.length ?? 0) };
    }
    const r = await db.query(texto, valores);
    // Como no pg: SELECT conta as linhas devolvidas; INSERT/UPDATE/DELETE, as afetadas.
    return { rows: r.rows, rowCount: Math.max(r.affectedRows ?? 0, r.rows.length) };
  };
  const pool = {
    async query(texto: string, valores?: unknown[]) {
      const liberar = await vez();
      try { return await executar(texto, valores); } finally { liberar(); }
    },
    async connect() {
      const liberar = await vez();
      return { query: executar, release: liberar };
    },
    async end() { await fila; await db.close(); },
  };
  return pool as unknown as pg.Pool;
}
