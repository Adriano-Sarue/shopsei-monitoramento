import { createApi, listen } from './api/server.js';
import { randomBytes } from 'node:crypto';
import { hashSenha } from './auth/senha.js';
import { Sessoes } from './auth/sessoes.js';
import { eventoInterno } from './incidents/planos.js';
import { IncidentQueue } from './incidents/queue.js';
import { SupervisaoTeste } from './incidents/supervisao.js';
import { AccountRegistry } from './receiver/accounts.js';
import { Receiver, type RawFrame } from './receiver/server.js';
import { SurgardServer } from './receiver/surgardServer.js';
import { JsonlStore } from './store/jsonlStore.js';
import { MemoryRepo } from './store/memoryRepo.js';
import { PgRepo } from './store/pgRepo.js';
import { ClienteIndex, type Repositorio } from './store/repositorio.js';
import type { AlarmEvent } from './protocols/types.js';

const tcpPort = Number(process.env.RECEPTORA_TCP_PORTA ?? 9000);
const udpPort = Number(process.env.RECEPTORA_UDP_PORTA ?? 9000);
const accounts = AccountRegistry.fromFile(process.env.CONTAS_ARQUIVO ?? 'config/accounts.json');

// Com DATABASE_URL usa PostgreSQL; sem ela roda em memória (nada sobrevive ao reinício).
const repo: Repositorio = process.env.DATABASE_URL ? new PgRepo(process.env.DATABASE_URL) : new MemoryRepo();
if (!process.env.DATABASE_URL) console.warn('DATABASE_URL não definida: rodando sem banco, fila e clientes somem ao reiniciar');
await repo.init();
const clientes = new ClienteIndex(repo);
await clientes.refresh();

// As gravações da mesma ocorrência vão em fila, para o estado mais novo ser sempre o último a chegar ao banco.
let gravacao: Promise<unknown> = Promise.resolve();
function gravar(fn: () => Promise<unknown>): void {
  gravacao = gravacao.then(fn).catch((err) => console.error('Falha ao gravar no banco:', err));
}
// Falha de energia costuma voltar sozinha: espera esse tempo em "pendente" antes de ir à fila (0 desliga).
const esperaEnergiaMin = Number(process.env.FALHA_ENERGIA_ESPERA_MIN ?? 30);
const queue = new IncidentQueue({
  contaCadastrada: (conta) => clientes.porConta(conta) !== undefined,
  esperaMin: (e) => (e.code === '301' && e.qualifier !== 'restore' ? esperaEnergiaMin : 0),
  onChange: (o) => gravar(() => repo.salvarOcorrencia(o)),
});
queue.restore(await repo.carregarOcorrenciasAbertas());
const store = new JsonlStore(process.env.DADOS_DIR ?? 'data');

const receiver = new Receiver({ tcpPort, udpPort, keyFor: accounts.keyFor });

receiver.on('raw', (raw: RawFrame) => {
  // O registro bruto é gravado antes de qualquer outra coisa.
  store.appendRaw(raw).catch((err) => console.error('Falha ao gravar quadro bruto:', err));
  if (!raw.ok) console.warn(`[NAK] ${raw.remote}: ${raw.error}`);
});

let ultimoEvento: Date | undefined;
const supervisao = new SupervisaoTeste((conta) => clientes.porConta(conta)?.intervaloTesteHoras);
supervisao.carregar(await repo.ultimosEventos());

function onEvent(event: AlarmEvent): void {
  if (event.protocol !== 'INTERNO') {
    ultimoEvento = new Date();
    supervisao.registrar(event.account, new Date(event.receivedAt));
  }
  store.appendEvent(event).catch((err) => console.error('Falha ao gravar evento:', err));
  gravar(() => repo.salvarEvento(event));
  queue.handleEvent(event);
  if (event.category === 'supervision') return;
  const name = clientes.porConta(event.account)?.nome ?? 'conta não cadastrada';
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

// Console web: pessoas entram com usuário e senha. Na primeira subida cria o administrador inicial.
if ((await repo.listarUsuarios()).length === 0) {
  const login = (process.env.ADMIN_LOGIN ?? 'admin').toLowerCase();
  const senha = process.env.ADMIN_SENHA ?? randomBytes(9).toString('base64url');
  await repo.criarUsuario({ login, nome: 'Administrador', papel: 'admin', senhaHash: await hashSenha(senha) });
  console.log(`Administrador criado: login "${login}"${process.env.ADMIN_SENHA ? '' : `, senha "${senha}" (anote e troque em Usuários)`}`);
}
const sessoes = new Sessoes();
const api = createApi(queue, { token: process.env.CONSOLE_TOKEN, sessoes, publicDir: 'public', port: 0, repo, clientes, ultimoEvento: () => ultimoEvento });
console.log(`Console web ouvindo na porta ${await listen(api, Number(process.env.CONSOLE_PORTA ?? 8090))}`);
setInterval(() => queue.reativarVencidas(), 30_000).unref();
// O console consulta a fila a cada 2 s. Operador sem sinal há 90 s sai da escala e devolve o que estava com ele.
setInterval(() => {
  for (const nome of sessoes.ociosos(90_000)) {
    if (queue.estaDisponivel(nome) || queue.list().some((o) => o.operador === nome && o.situacao === 'em_atendimento')) {
      console.warn(`Operador ${nome} sem sinal: ocorrências devolvidas à fila`);
      queue.desconectar(nome);
    }
  }
  const contas = [...new Set(clientes.todos().flatMap((c) => c.contas))];
  for (const { conta, desde, horas } of supervisao.atrasadas(contas)) {
    onEvent(eventoInterno(conta, 'TST', `Falta de teste periódico: nenhum sinal há mais de ${horas} h (desde ${desde.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })})`, new Date()));
  }
  sessoes.limpar();
  queue.podar(60 * 60_000);
}, 15_000).unref();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    Promise.all([receiver.stop(), surgard?.stop(), new Promise<void>((r) => api.close(() => r()))])
      .then(() => gravacao)
      .then(() => repo.fechar())
      .finally(() => process.exit(0));
  });
}
