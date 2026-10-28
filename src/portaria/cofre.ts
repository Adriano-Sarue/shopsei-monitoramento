import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// Guarda a senha dos equipamentos cifrada no banco (AES-256-GCM). A chave vem de CHAVE_EQUIPAMENTOS e fica
// só no servidor: um backup do banco vazado não entrega a senha dos leitores dos condomínios.
export class Cofre {
  private readonly chave: Buffer;

  constructor(segredo: string) {
    if (segredo.length < 16) throw new Error('CHAVE_EQUIPAMENTOS precisa ter ao menos 16 caracteres');
    this.chave = createHash('sha256').update(segredo).digest();
  }

  cifrar(texto: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.chave, iv);
    const dados = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
    return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), dados.toString('base64')].join(':');
  }

  decifrar(guardado: string): string {
    const [versao, iv, etiqueta, dados] = guardado.split(':');
    if (versao !== 'v1' || !iv || !etiqueta || dados === undefined) throw new Error('Senha guardada em formato desconhecido');
    const d = createDecipheriv('aes-256-gcm', this.chave, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(etiqueta, 'base64'));
    try {
      return Buffer.concat([d.update(Buffer.from(dados, 'base64')), d.final()]).toString('utf8');
    } catch {
      throw new Error('Não foi possível ler a senha do equipamento: CHAVE_EQUIPAMENTOS mudou?');
    }
  }
}
