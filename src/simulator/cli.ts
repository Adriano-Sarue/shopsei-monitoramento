import { createSocket } from 'node:dgram';
import { connect } from 'node:net';
import { parseArgs } from 'node:util';
import { buildFrame, extractFrames, parseFrame } from '../protocols/dc09.js';

// Simulador de central: envia um evento DC-09 para a receptora e mostra a resposta.
// Exemplo: npm run simular -- --conta 1234 --evento "1130 01 003"
const { values } = parseArgs({
  options: {
    host: { type: 'string', default: '127.0.0.1' },
    porta: { type: 'string', default: '9000' },
    udp: { type: 'boolean', default: false },
    conta: { type: 'string', default: '1234' },
    protocolo: { type: 'string', default: 'ADM-CID' },
    evento: { type: 'string', default: '1130 01 003' },
    sequencia: { type: 'string', default: '0001' },
    linha: { type: 'string', default: '0' },
    chave: { type: 'string' },
  },
});

const key = values.chave ? Buffer.from(values.chave, 'hex') : undefined;
const id = values.protocolo.toUpperCase();
const frame = buildFrame(
  {
    id,
    sequence: values.sequencia.padStart(4, '0'),
    line: values.linha,
    account: values.conta,
    data: id === 'NULL' ? '' : `#${values.conta}|${values.evento}`,
  },
  { key },
);
const port = Number(values.porta);

function show(reply: string): void {
  const [first] = extractFrames(reply).frames;
  if (!first) {
    console.log('Resposta vazia ou incompleta:', JSON.stringify(reply));
    return;
  }
  const msg = parseFrame(first, () => key);
  console.log(`Resposta: ${msg.id} (sequência ${msg.sequence})`);
}

console.log('Enviando:', JSON.stringify(frame));
if (values.udp) {
  const socket = createSocket('udp4');
  socket.on('message', (buf) => {
    show(buf.toString('latin1'));
    socket.close();
  });
  socket.send(Buffer.from(frame, 'latin1'), port, values.host);
  setTimeout(() => {
    console.log('Sem resposta em 5s');
    socket.close();
  }, 5000).unref();
} else {
  const socket = connect(port, values.host, () => socket.write(Buffer.from(frame, 'latin1')));
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('latin1');
    if (buffer.includes('\r')) {
      show(buffer);
      socket.end();
    }
  });
  socket.on('error', (err) => console.error('Erro:', err.message));
}
