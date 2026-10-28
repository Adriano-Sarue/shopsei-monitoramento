import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const N = 16384;
const KEYLEN = 32;

function derive(senha: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(senha, salt, KEYLEN, { N }, (err, key) => (err ? reject(err) : resolve(key))));
}

export const SENHA_MINIMA = 8;

export async function hashSenha(senha: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${N}$${salt.toString('base64')}$${(await derive(senha, salt)).toString('base64')}`;
}

export async function conferirSenha(senha: string, hash: string | undefined): Promise<boolean> {
  // Sem hash (usuário inexistente) ainda gasta o mesmo tempo, para não revelar quais logins existem.
  const [tipo, , salt, esperado] = (hash ?? 'scrypt$0$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=').split('$');
  if (tipo !== 'scrypt' || !salt || !esperado) return false;
  const got = await derive(senha, Buffer.from(salt, 'base64'));
  const want = Buffer.from(esperado, 'base64');
  return got.length === want.length && timingSafeEqual(got, want) && hash !== undefined;
}
