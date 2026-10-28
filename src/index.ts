import { AccountRegistry } from './receiver/accounts.js';
import { Receiver, type RawFrame } from './receiver/server.js';
import { SurgardServer } from './receiver/surgardServer.js';
import { JsonlStore } from './store/jsonlStore.js';
import type { AlarmEvent } from './protocols/types.js';

const tcpPort = Number(process.env.RECEPTORA_TCP_PORTA ?? 9000);
const udpPort = Number(process.env.RECEPTORA_UDP_PORTA ?? 9000);
const accounts = AccountRegistry.fromFile(process.env.CONTAS_ARQUIVO ?? 'config/accounts.json');
const store = new JsonlStore(process.env.DADOS_DIR ?? 'data');

const receiver = new Receiver({ tcpPort, udpPort, keyFor: accounts.keyFor });

receiver.on('raw', (raw: RawFrame) => {
  // O registro bruto é gravado antes de qualquer outra coisa.
  store.appendRaw(raw).catch((err) => console.error('Falha ao gravar quadro bruto:', err));
  if (!raw.ok) console.warn(`[NAK] ${raw.remote}: ${raw.error}`);
});

function onEvent(event: AlarmEvent): void {
  store.appendEvent(event).catch((err) => console.error('Falha ao gravar evento:', err));
  if (event.category === 'supervision') return;
  const name = accounts.get(event.account)?.name ?? 'conta não cadastrada';
  const zone = event.zoneOrUser ? ` zona/usuário ${event.zoneOrUser}` : '';
  console.log(`[P${event.priority}] conta ${event.account} (${name}): ${event.description}${zone}`);
}

receiver.on('event', onEvent);

const ports = await receiver.start();
console.log(`Receptora ouvindo TCP ${ports.tcpPort} e UDP ${ports.udpPort}`);

// Feed Sur-Gard do Active Net 3 (via ponte serial para TCP). Desligado se a porta não for definida.
let surgard: SurgardServer | undefined;
if (process.env.SURGARD_TCP_PORTA) {
  surgard = new SurgardServer({ port: Number(process.env.SURGARD_TCP_PORTA) });
  surgard.on('raw', (raw: RawFrame) => {
    store.appendRaw(raw).catch((err) => console.error('Falha ao gravar quadro bruto:', err));
    if (!raw.ok) console.warn(`[NAK] Sur-Gard ${raw.remote}: ${raw.error}`);
  });
  surgard.on('event', onEvent);
  console.log(`Feed Sur-Gard ouvindo TCP ${await surgard.start()}`);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    Promise.all([receiver.stop(), surgard?.stop()]).finally(() => process.exit(0));
  });
}
