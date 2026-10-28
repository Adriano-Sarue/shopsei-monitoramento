import { fetchDigest } from './digest.js';

// Conversa com leitores faciais e interfones Hikvision pela API local deles (ISAPI), por dentro da VPN do
// condomínio. Endpoints da documentação pública da ISAPI; a descrição dos códigos de evento ainda precisa ser
// conferida com uma captura real do DS-K1T342MWX (marcado PROVISÓRIO abaixo).

export interface AcessoEquipamento {
  // Endereço na VPN, ex.: http://10.8.0.12 (porta opcional).
  endereco: string;
  usuario: string;
  senha: string;
}

export interface InfoEquipamento {
  modelo?: string;
  serie?: string;
  firmware?: string;
  nome?: string;
}

export type EstadoChamada = 'livre' | 'tocando' | 'em_conversa' | 'desconhecido';

const XMLNS = 'http://www.isapi.org/ver20/XMLSchema';
const tag = (xml: string, nome: string) => new RegExp(`<${nome}>([^<]*)</${nome}>`).exec(xml)?.[1]?.trim();
const escXml = (t: string) => t.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!);

export class ErroEquipamento extends Error {}

export class Hikvision {
  constructor(private readonly a: AcessoEquipamento, private readonly timeoutMs = 4000) {}

  private async chamar(caminho: string, o: { method?: string; body?: string; tipo?: string } = {}): Promise<Response> {
    const url = this.a.endereco.replace(/\/+$/, '') + caminho;
    let r: Response;
    try {
      r = await fetchDigest(url, {
        method: o.method, body: o.body, headers: o.body ? { 'content-type': o.tipo ?? 'application/xml' } : {},
        usuario: this.a.usuario, senha: this.a.senha, timeoutMs: this.timeoutMs,
      });
    } catch (err) {
      const e = err as Error & { cause?: { code?: string } };
      const motivo = e.name === 'TimeoutError' ? 'não respondeu a tempo' : e.cause?.code === 'ECONNREFUSED' ? 'recusou a conexão' : 'fora do ar ou fora da VPN';
      throw new ErroEquipamento(`Equipamento ${motivo} (${this.a.endereco})`);
    }
    if (r.status === 401) throw new ErroEquipamento('Usuário ou senha do equipamento incorretos');
    if (!r.ok) {
      const corpo = await r.text().catch(() => '');
      throw new ErroEquipamento(`Equipamento respondeu ${r.status}${tag(corpo, 'subStatusCode') ? ` (${tag(corpo, 'subStatusCode')})` : ''}`);
    }
    return r;
  }

  async info(): Promise<InfoEquipamento> {
    const xml = await (await this.chamar('/ISAPI/System/deviceInfo')).text();
    return { nome: tag(xml, 'deviceName'), modelo: tag(xml, 'model'), serie: tag(xml, 'serialNumber'), firmware: tag(xml, 'firmwareVersion') };
  }

  async abrirPorta(porta = 1): Promise<void> {
    const corpo = `<?xml version="1.0" encoding="UTF-8"?><RemoteControlDoor version="2.0" xmlns="${XMLNS}"><cmd>open</cmd></RemoteControlDoor>`;
    await this.chamar(`/ISAPI/AccessControl/RemoteControl/door/${porta}`, { method: 'PUT', body: corpo });
  }

  // Estado da chamada do botão do leitor. "ring" = visitante chamando.
  async estadoChamada(): Promise<EstadoChamada> {
    const r = await this.chamar('/ISAPI/VideoIntercom/callStatus?format=json');
    const j = (await r.json().catch(() => ({}))) as { CallStatus?: { status?: string } };
    const s = j.CallStatus?.status?.toLowerCase();
    if (s === 'idle') return 'livre';
    if (s === 'ring' || s === 'ringing') return 'tocando';
    if (s === 'oncall' || s === 'calling' || s === 'busy') return 'em_conversa';
    return 'desconhecido';
  }

  async encerrarChamada(): Promise<void> {
    await this.chamar('/ISAPI/VideoIntercom/callSignal?format=json', { method: 'PUT', tipo: 'application/json', body: JSON.stringify({ CallSignal: { cmdType: 'hangUp' } }) });
  }

  // Foto da câmera do leitor naquele instante (JPEG).
  async foto(): Promise<Buffer> {
    const r = await this.chamar('/ISAPI/Streaming/channels/101/picture');
    return Buffer.from(await r.arrayBuffer());
  }

  // Pede ao equipamento que envie os eventos (acessos, rosto não reconhecido) para o nosso servidor.
  async configurarEnvio(destino: string, slot = 1): Promise<void> {
    const u = new URL(destino);
    const ip = /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname);
    const https = u.protocol === 'https:';
    const corpo = `<?xml version="1.0" encoding="UTF-8"?>
<HttpHostNotificationList version="2.0" xmlns="${XMLNS}"><HttpHostNotification>
<id>${slot}</id><url>${escXml(u.pathname + u.search)}</url><protocolType>${https ? 'HTTPS' : 'HTTP'}</protocolType>
<parameterFormatType>JSON</parameterFormatType><addressingFormatType>${ip ? 'ipaddress' : 'hostname'}</addressingFormatType>
${ip ? `<ipAddress>${u.hostname}</ipAddress>` : `<hostName>${escXml(u.hostname)}</hostName>`}<portNo>${u.port || (https ? 443 : 80)}</portNo>
<httpAuthenticationMethod>none</httpAuthenticationMethod><SubscribeEvent><heartbeat>30</heartbeat><eventMode>all</eventMode></SubscribeEvent>
</HttpHostNotification></HttpHostNotificationList>`;
    await this.chamar(`/ISAPI/Event/notification/httpHosts/${slot}`, { method: 'PUT', body: corpo });
  }
}

// ---- Eventos que o equipamento envia (HTTP POST para o endereço configurado em configurarEnvio).

export interface EventoEquipamento {
  tipo: 'acesso' | 'negado' | 'porta' | 'chamada' | 'sinal' | 'outro';
  descricao: string;
  em: string;
  nome?: string;
  foto?: Buffer;
  // Códigos originais, para conferir a tabela abaixo com o equipamento real.
  codigo?: string;
}

// PROVISÓRIO: subtipos do evento de controle de acesso (major 5) da documentação pública da ISAPI.
const SUBTIPOS: Record<number, [EventoEquipamento['tipo'], string]> = {
  1: ['acesso', 'Cartão aceito'],
  9: ['negado', 'Cartão não cadastrado'],
  21: ['porta', 'Porta destrancada'],
  22: ['porta', 'Porta trancada'],
  38: ['acesso', 'Digital reconhecida'],
  39: ['negado', 'Digital não reconhecida'],
  75: ['acesso', 'Rosto reconhecido'],
  76: ['negado', 'Rosto não reconhecido'],
};

function partesMultipart(corpo: Buffer, tipo: string): { tipo: string; nome: string; dados: Buffer }[] {
  const limite = /boundary="?([^";]+)"?/i.exec(tipo)?.[1];
  if (!limite) return [];
  const sep = Buffer.from(`--${limite}`);
  const partes: { tipo: string; nome: string; dados: Buffer }[] = [];
  let i = corpo.indexOf(sep);
  while (i >= 0) {
    const inicio = i + sep.length;
    const fim = corpo.indexOf(sep, inicio);
    if (fim < 0) break;
    const bloco = corpo.subarray(inicio, fim);
    const cab = bloco.indexOf('\r\n\r\n');
    if (cab >= 0) {
      const cabecalho = bloco.subarray(0, cab).toString('latin1');
      let dados = bloco.subarray(cab + 4);
      if (dados.subarray(-2).toString() === '\r\n') dados = dados.subarray(0, -2);
      partes.push({ tipo: /content-type:\s*([^\r\n;]+)/i.exec(cabecalho)?.[1]?.trim().toLowerCase() ?? '', nome: /name="([^"]*)"/i.exec(cabecalho)?.[1] ?? '', dados });
    }
    i = fim;
  }
  return partes;
}

export function lerEventoEquipamento(corpo: Buffer, tipoConteudo: string, agora = new Date()): EventoEquipamento {
  let texto = '';
  let foto: Buffer | undefined;
  if (/multipart/i.test(tipoConteudo)) {
    for (const p of partesMultipart(corpo, tipoConteudo)) {
      if (p.tipo.startsWith('image/')) foto ??= p.dados;
      else if (!texto) texto = p.dados.toString('utf8');
    }
  } else {
    texto = corpo.toString('utf8');
  }
  const t = texto.trim();
  let tipoEvento: string | undefined, sub: number | undefined, major: number | undefined, nome: string | undefined, quando: string | undefined;
  if (t.startsWith('{')) {
    const j = JSON.parse(t) as Record<string, unknown>;
    const ace = (j.AccessControllerEvent ?? {}) as Record<string, unknown>;
    tipoEvento = String(j.eventType ?? '');
    quando = typeof j.dateTime === 'string' ? j.dateTime : undefined;
    major = ace.majorEventType === undefined ? undefined : Number(ace.majorEventType);
    sub = ace.subEventType === undefined ? undefined : Number(ace.subEventType);
    nome = typeof ace.name === 'string' && ace.name.trim() ? ace.name.trim() : undefined;
  } else if (t.startsWith('<')) {
    tipoEvento = tag(t, 'eventType');
    quando = tag(t, 'dateTime');
    const ma = tag(t, 'majorEventType'), su = tag(t, 'subEventType');
    major = ma === undefined ? undefined : Number(ma);
    sub = su === undefined ? undefined : Number(su);
    nome = tag(t, 'name') || undefined;
  } else {
    throw new Error('Evento em formato desconhecido');
  }
  const em = quando && !Number.isNaN(new Date(quando).getTime()) ? new Date(quando).toISOString() : agora.toISOString();
  const codigo = major !== undefined || sub !== undefined ? `${major ?? '?'}/${sub ?? '?'}` : tipoEvento;
  if (/^heartbeat$/i.test(tipoEvento ?? '')) return { tipo: 'sinal', descricao: 'Sinal de vida', em, codigo };
  if (/call|ring|doorbell|intercom/i.test(tipoEvento ?? '')) return { tipo: 'chamada', descricao: 'Chamada no leitor', em, nome, foto, codigo };
  if (/AccessControllerEvent/i.test(tipoEvento ?? '')) {
    const conhecido = major === 5 && sub !== undefined ? SUBTIPOS[sub] : undefined;
    if (conhecido) return { tipo: conhecido[0], descricao: conhecido[1], em, nome, foto, codigo };
    return { tipo: 'outro', descricao: `Evento do leitor (código ${codigo})`, em, nome, foto, codigo };
  }
  return { tipo: 'outro', descricao: `Evento ${tipoEvento || 'sem tipo'}`, em, nome, foto, codigo };
}
