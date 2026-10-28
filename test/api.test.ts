import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApi, listen } from '../src/api/server.js';
import { IncidentQueue } from '../src/incidents/queue.js';
import { parseContactId } from '../src/protocols/contactId.js';
import type { AlarmEvent } from '../src/protocols/types.js';

function ev(account: string, cid: string): AlarmEvent {
  return {
    receivedAt: new Date(0).toISOString(), transport: 'tcp', remote: 't', protocol: 'ADM-CID', account, line: '0',
    sequence: '0001', encrypted: false, raw: '', ...parseContactId(cid),
  };
}

test('API exige token, lista ocorrências e conclui como operador', async () => {
  const queue = new IncidentQueue();
  const server = createApi(queue, { token: 'segredo', publicDir: 'public', port: 0 });
  const port = await listen(server, 0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const h = { authorization: 'Bearer segredo', 'content-type': 'application/json' };
  try {
    assert.equal((await fetch(`${base}/api/ocorrencias`)).status, 401);
    assert.equal((await fetch(`${base}/api/ocorrencias`, { headers: { authorization: 'Bearer errado' } })).status, 401);

    const html = await fetch(base);
    assert.equal(html.status, 200);
    assert.match(await html.text(), /Shop Sei Monitoramento/);

    queue.handleEvent(ev('0013', '1301 00 000'));
    await fetch(`${base}/api/operadores`, { method: 'POST', headers: h, body: JSON.stringify({ nome: 'Shop Sei', disponivel: true }) });
    const lista = (await (await fetch(`${base}/api/ocorrencias`, { headers: h })).json()) as { id: number; situacao: string; operador: string }[];
    assert.equal(lista.length, 1);
    assert.equal(lista[0]!.situacao, 'em_atendimento');

    const outro = await fetch(`${base}/api/ocorrencias/${lista[0]!.id}/concluir`, { method: 'POST', headers: h, body: JSON.stringify({ operador: 'Outro', motivo: 'x' }) });
    assert.equal(outro.status, 400);
    const ok = await fetch(`${base}/api/ocorrencias/${lista[0]!.id}/concluir`, { method: 'POST', headers: h, body: JSON.stringify({ operador: 'Shop Sei', motivo: 'Falha de energia do cliente', conclusao: 'Voltou' }) });
    assert.equal(ok.status, 200);
    assert.deepEqual(await (await fetch(`${base}/api/ocorrencias`, { headers: h })).json(), []);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
