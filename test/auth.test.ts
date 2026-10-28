import assert from 'node:assert/strict';
import { test } from 'node:test';
import { conferirSenha, hashSenha } from '../src/auth/senha.js';
import { Sessoes } from '../src/auth/sessoes.js';

test('senha: hash confere só com a senha certa e nunca guarda a senha', async () => {
  const h = await hashSenha('minha-senha-1');
  assert.ok(!h.includes('minha-senha-1'));
  assert.notEqual(h, await hashSenha('minha-senha-1'));
  assert.equal(await conferirSenha('minha-senha-1', h), true);
  assert.equal(await conferirSenha('outra', h), false);
  assert.equal(await conferirSenha('qualquer', undefined), false);
  assert.equal(await conferirSenha('qualquer', 'lixo'), false);
});

test('sessões: expiram, mostram quem sumiu e bloqueiam tentativas', () => {
  let agora = 0;
  const s = new Sessoes(() => agora);
  const a = s.criar({ usuarioId: 1, login: 'ana', nome: 'Ana', papel: 'operador' });
  const b1 = s.criar({ usuarioId: 2, login: 'beto', nome: 'Beto', papel: 'operador' });
  s.criar({ usuarioId: 2, login: 'beto', nome: 'Beto', papel: 'operador' });
  agora = 100_000;
  s.obter(a);
  // Beto tem duas sessões paradas; Ana acabou de consultar.
  assert.deepEqual(s.ociosos(90_000), ['Beto']);
  s.encerrar(b1);
  assert.equal(s.temSessao('Beto'), true);
  agora = 13 * 3600_000;
  assert.equal(s.obter(a), undefined);
  s.limpar();
  assert.equal(s.temSessao('Beto'), false);

  for (let i = 0; i < 4; i++) s.registrarFalha('x');
  assert.equal(s.bloqueado('x'), false);
  s.registrarFalha('x');
  assert.equal(s.bloqueado('x'), true);
  assert.equal(s.bloqueado('x', 25), false);
  agora += 6 * 60_000;
  assert.equal(s.bloqueado('x'), false);
});
