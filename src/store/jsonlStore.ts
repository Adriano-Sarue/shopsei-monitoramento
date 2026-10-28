import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AlarmEvent } from '../protocols/types.js';

// Armazenamento simples em arquivos JSON Lines, um por dia. Substituído por
// PostgreSQL na próxima etapa; serve para não perder nada desde o primeiro dia.
export class JsonlStore {
  constructor(private readonly dir: string) {}

  private file(prefix: string): string {
    return join(this.dir, `${prefix}-${new Date().toISOString().slice(0, 10)}.jsonl`);
  }

  async appendRaw(entry: { receivedAt: string; transport: string; remote: string; frame: string; ok: boolean; error?: string }): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.file('bruto'), `${JSON.stringify(entry)}\n`);
  }

  async appendEvent(event: AlarmEvent): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await appendFile(this.file('eventos'), `${JSON.stringify(event)}\n`);
  }
}
