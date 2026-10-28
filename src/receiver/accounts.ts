import { readFileSync, existsSync } from 'node:fs';

export interface AccountConfig {
  name?: string;
  // Chave AES em hexadecimal (32, 48 ou 64 caracteres), se a central usar criptografia.
  key?: string;
}

export class AccountRegistry {
  constructor(private readonly accounts: Record<string, AccountConfig> = {}) {}

  static fromFile(path: string): AccountRegistry {
    if (!existsSync(path)) return new AccountRegistry();
    return new AccountRegistry(JSON.parse(readFileSync(path, 'utf8')) as Record<string, AccountConfig>);
  }

  get(account: string): AccountConfig | undefined {
    return this.accounts[account.toUpperCase()] ?? this.accounts[account];
  }

  keyFor = (account: string): Buffer | undefined => {
    const key = this.get(account)?.key;
    return key ? Buffer.from(key, 'hex') : undefined;
  };
}
