import { createApi, listen } from './api/server.js';
import { randomBytes } from 'node:crypto';
import { hashSenha } from './auth/senha.js';
import { Sessoes } from './auth/sessoes.js';
import { eventoInterno } from './incidents/planos.js';
import { PortariaAoVivo } from './portaria/aoVivo.js';
import { Cofre } from './portaria/cofre.js';
import { Central, type Canal } from './central.js';
import { AccountRegistry } from './receiver/accounts.js';
import { Receiver, type RawFrame } from './receiver/server.js';
import { SurgardServer } from './receiver/surgardServer.js';
import { JsonlStore } from './store/jsonlStore.js';
import { MemoryRepo } from './store/memoryRepo.js';
import { PgRepo } from './store/pgRepo.js';
import type { Repositorio } from './store/repositorio.js';
import type { AlarmEvent } from './protocols/types.js';

const tcpPort = Number(process.env.RECEPTORA_TCP_PORTA ?? 9000);
const udpPort = Number(process.env.RECEPTORA_UDP_PORTA ?? 9000);
const accounts = AccountRegistry.fromFile(process.env.CONTAS_ARQUIVO ?? 'config/accounts.json');

// Com DATABASE_URL usa PostgreSQL; sem ela roda em memória (nada sobrevive ao reinício).
const repo: Repositorio = process.env.DATABASE_URL ? new PgRepo(process.env.DATABASE_URL) : new MemoryRepo();
if (!process.env.DATABASE_URL) console.warn('DATABASE_URL não definida: rodando sem banco, fila e clientes somem ao reiniciar');
await repo.init();

// Primeira subida: cria a empresa dona do servidor (a Shop Sei) com rotas coringa, para receber tudo que chegar.
// Bancos de antes do multiempresa já ganharam a empresa 1 no esquema; ela recebe as rotas coringa se ninguém tiver rota.
let empresas = await repo.listarEmpresas();
const coringa = [{ canal: 'surgard' as const, receptora: '*', linha: '*' }, { canal: 'dc09' as const, receptora: '*', linha: '*' }];
if (empresas.length === 0) {
  await repo.criarEmpresa({ nome: process.env.EMPRESA_NOME ?? 'Shop Sei', rotas: coringa });
  empresas = await repo.listarEmpresas();
} else if (empresas.length === 1 && empresas[0]!.rotas.length === 0) {
  await repo.atualizarEmpresa(empresas[0]!.id, { rotas: coringa });
}
const empresaPrincipal = (await repo.listarEmpresas())[0]!;

// As gravações da mesma ocorrência vão em fila, para o estado mais novo ser sempre o último a chegar ao banco.
let gravacao: Promise<unknown> = Promise.resolve();
function gravar(fn: () => Promise<unknown>): void {
  gravacao = gravacao.then(fn).catch((err) => console.error('Falha ao gravar no banco:', err));
}
// Falha de energia costuma voltar sozinha: espera esse tempo em "pendente" antes de ir à fila (0 desliga).
const esperaEnergiaMin = Number(process.env.FALHA_ENERGIA_ESPERA_MIN ?? 30);
const central = new Central(repo, {
  esperaMin: (e) => (e.code === '301' && e.qualifier !== 'restore' ? esperaEnergiaMin : 0),
  onChange: (o) => gravar(() => repo.salvarOcorrencia(o)),
});
await central.iniciar();
const store = new JsonlStore(process.env.DADOS_DIR ?? 'data');

const receiver = new Receiver({ tcpPort, udpPort, keyFor: accounts.keyFor });

receiver.on('raw', (raw: RawFrame) => {
  // O registro bruto é gravado antes de qualquer outra coisa.
  store.appendRaw(raw).catch((err) => console.error('Falha ao gravar quadro bruto:', err));
  if (!raw.ok) console.warn(`[NAK] ${raw.remote}: ${raw.error}`);
});

const ultimoEvento = new Map<number, Date>();

function onEvent(event: AlarmEvent, canal: Canal): void {
  store.appendEvent(event).catch((err) => console.error('Falha ao gravar evento:', err));
  const empresaId = central.rotear(event, canal);
  gravar(() => repo.salvarEvento(event));
  if (empresaId === undefined) {
    console.warn(`[SEM ROTA] ${canal} receptora ${event.receiver ?? '-'} linha ${event.line} conta ${event.account}: ${event.description}`);
    return;
  }
  if (event.protocol !== 'INTERNO') {
    ultimoEvento.set(empresaId, new Date());
    central.supervisao(empresaId).registrar(event.account, new Date(event.receivedAt));
  }
  central.fila(empresaId).handleEvent(event);
  if (event.category === 'supervision') return;
  const name = central.clientes(empresaId).porConta(event.account)?.nome ?? 'conta não cadastrada';
  const zone = event.zoneOrUser ? ` zona/usuário ${event.zoneOrUser}` : '';
  console.log(`[E${empresaId} P${event.priority}] conta ${event.account} (${name}): ${event.description}${zone}`);
}

receiver.on('event', (e: AlarmEvent) => onEvent(e, 'dc09'));

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
  surgard.on('event', (e: AlarmEvent) => onEvent(e, 'surgard'));
  console.log(`Feed Sur-Gard ouvindo TCP ${await surgard.start()}`);
}

// Console web: pessoas entram com usuário e senha. Na primeira subida cria o administrador da empresa principal
// e, se PLATAFORMA_SENHA for definida, o dono do sistema (cadastra as empresas compradoras).
if ((await repo.listarUsuarios(empresaPrincipal.id)).length === 0) {
  const login = (process.env.ADMIN_LOGIN ?? 'admin').toLowerCase();
  const senha = process.env.ADMIN_SENHA ?? randomBytes(9).toString('base64url');
  await repo.criarUsuario({ empresaId: empresaPrincipal.id, login, nome: 'Administrador', papel: 'admin', senhaHash: await hashSenha(senha) });
  console.log(`Administrador criado: login "${login}"${process.env.ADMIN_SENHA ? '' : `, senha "${senha}" (anote e troque em Usuários)`}`);
}
if (process.env.PLATAFORMA_SENHA && (await repo.listarUsuarios(null)).length === 0) {
  const login = (process.env.PLATAFORMA_LOGIN ?? 'plataforma').toLowerCase();
  await repo.criarUsuario({ empresaId: null, login, nome: 'Dono do sistema', papel: 'admin', senhaHash: await hashSenha(process.env.PLATAFORMA_SENHA) });
  console.log(`Dono do sistema criado: login "${login}"`);
}
// Portaria: equipamentos dos condomínios (pela VPN). Sem CHAVE_EQUIPAMENTOS, o cadastro e o atendimento
// funcionam, mas o sistema não guarda senha de equipamento nem fala com eles.
const cofre = process.env.CHAVE_EQUIPAMENTOS ? new Cofre(process.env.CHAVE_EQUIPAMENTOS) : undefined;
if (!cofre) console.warn('CHAVE_EQUIPAMENTOS não definida: integração com leitores e interfones desligada');
const aoVivo = new PortariaAoVivo(repo.portaria, cofre);
await aoVivo.recarregar();
aoVivo.iniciar(Number(process.env.PORTARIA_INTERVALO_MS ?? 2000));
setInterval(() => void aoVivo.recarregar().catch((err) => console.error('Falha ao recarregar equipamentos:', err)), 60_000).unref();

const sessoes = new Sessoes();
const api = createApi(central, {
  token: process.env.CONSOLE_TOKEN, tokenEmpresa: empresaPrincipal.id, sessoes, publicDir: 'public', port: 0, repo,
  ultimoEvento: (empresaId) => ultimoEvento.get(empresaId),
  aoVivo, cofre, urlEventos: process.env.PORTARIA_URL_EVENTOS,
});
console.log(`Console web ouvindo na porta ${await listen(api, Number(process.env.CONSOLE_PORTA ?? 8090))}`);
setInterval(() => {
  for (const [, fila] of central.todasAsFilas()) fila.reativarVencidas();
}, 30_000).unref();
// O console consulta a fila a cada 2 s. Operador sem sinal há 90 s sai da escala e devolve o que estava com ele.
setInterval(() => {
  for (const { empresaId, nome } of sessoes.ociosos(90_000)) {
    if (!central.empresa(empresaId)) continue;
    const fila = central.fila(empresaId);
    if (fila.estaDisponivel(nome) || fila.list().some((o) => o.operador === nome && o.situacao === 'em_atendimento')) {
      console.warn(`Operador ${nome} (empresa ${empresaId}) sem sinal: ocorrências devolvidas à fila`);
      fila.desconectar(nome);
    }
  }
  for (const e of central.listaEmpresas()) {
    const contas = [...new Set(central.clientes(e.id).todos().flatMap((c) => c.contas))];
    for (const { conta, desde, horas } of central.supervisao(e.id).atrasadas(contas)) {
      const ev = eventoInterno(conta, 'TST', `Falta de teste periódico: nenhum sinal há mais de ${horas} h (desde ${desde.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })})`, new Date());
      ev.empresaId = e.id;
      onEvent(ev, 'dc09');
    }
  }
  sessoes.limpar();
  for (const [, fila] of central.todasAsFilas()) fila.podar(60 * 60_000);
}, 15_000).unref();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    aoVivo.parar();
    Promise.all([receiver.stop(), surgard?.stop(), new Promise<void>((r) => api.close(() => r()))])
      .then(() => gravacao)
      .then(() => repo.fechar())
      .finally(() => process.exit(0));
  });
}
