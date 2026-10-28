import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';

// Leitor facial Hikvision de mentira: fala a mesma ISAPI (com autenticação Digest) que o sistema usa, para
// testar sem o equipamento real. Guarda as portas abertas, deixa simular chamada e envia eventos.

const md5 = (t: string) => createHash('md5').update(t).digest('hex');
// JPEG mínimo (1x1) para a foto da câmera.
export const FOTO_TESTE = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

export class LeitorSimulado {
  readonly aberturas: { porta: number; em: Date }[] = [];
  chamada: 'idle' | 'ring' | 'onCall' = 'idle';
  destinoEventos?: string;
  private server?: Server;
  private readonly realm = 'DS-K1T342MWX';
  private readonly nonce = randomBytes(8).toString('hex');

  constructor(readonly usuario = 'admin', readonly senha = 'senha-do-leitor') {}

  private autorizado(req: IncomingMessage): boolean {
    const h = req.headers.authorization ?? '';
    if (!h.startsWith('Digest ')) return false;
    const c: Record<string, string> = {};
    for (const m of h.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]*))/g)) c[m[1]!] = m[2] ?? m[3] ?? '';
    if (c.username !== this.usuario || c.nonce !== this.nonce || c.uri !== req.url) return false;
    const ha1 = md5(`${this.usuario}:${this.realm}:${this.senha}`);
    const ha2 = md5(`${req.method}:${c.uri}`);
    return c.response === md5(`${ha1}:${this.nonce}:${c.nc}:${c.cnonce}:${c.qop}:${ha2}`);
  }

  async iniciar(porta = 0): Promise<string> {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const corpo = Buffer.concat(chunks).toString('utf8');
      if (!this.autorizado(req)) {
        res.writeHead(401, { 'www-authenticate': `Digest qop="auth", realm="${this.realm}", nonce="${this.nonce}"` });
        return res.end();
      }
      const url = req.url ?? '';
      const xml = (status: number, s: string) => { res.writeHead(status, { 'content-type': 'application/xml' }); res.end(s); };
      if (req.method === 'GET' && url === '/ISAPI/System/deviceInfo') {
        return xml(200, '<?xml version="1.0"?><DeviceInfo><deviceName>Portaria</deviceName><model>DS-K1T342MWX</model><serialNumber>DS-K1T342MWX20240314V031601ENL42196876</serialNumber><firmwareVersion>V3.16.1</firmwareVersion></DeviceInfo>');
      }
      const porta = /^\/ISAPI\/AccessControl\/RemoteControl\/door\/(\d+)$/.exec(url);
      if (req.method === 'PUT' && porta) {
        if (!/<cmd>open<\/cmd>/.test(corpo)) return xml(400, '<ResponseStatus><statusCode>4</statusCode><subStatusCode>badParameters</subStatusCode></ResponseStatus>');
        if (Number(porta[1]) !== 1) return xml(400, '<ResponseStatus><statusCode>4</statusCode><subStatusCode>invalidID</subStatusCode></ResponseStatus>');
        this.aberturas.push({ porta: Number(porta[1]), em: new Date() });
        return xml(200, '<ResponseStatus><statusCode>1</statusCode><statusString>OK</statusString></ResponseStatus>');
      }
      if (req.method === 'GET' && url === '/ISAPI/VideoIntercom/callStatus?format=json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ CallStatus: { status: this.chamada } }));
      }
      if (req.method === 'PUT' && url === '/ISAPI/VideoIntercom/callSignal?format=json') {
        if (JSON.parse(corpo || '{}').CallSignal?.cmdType === 'hangUp') this.chamada = 'idle';
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{"statusCode":1}');
      }
      if (req.method === 'GET' && url === '/ISAPI/Streaming/channels/101/picture') {
        res.writeHead(200, { 'content-type': 'image/jpeg' });
        return res.end(FOTO_TESTE);
      }
      const host = /^\/ISAPI\/Event\/notification\/httpHosts\/(\d+)$/.exec(url);
      if (req.method === 'PUT' && host) {
        const pegar = (t: string) => new RegExp(`<${t}>([^<]*)</${t}>`).exec(corpo)?.[1];
        const proto = pegar('protocolType') === 'HTTPS' ? 'https' : 'http';
        this.destinoEventos = `${proto}://${pegar('ipAddress') ?? pegar('hostName')}:${pegar('portNo')}${pegar('url')}`;
        return xml(200, '<ResponseStatus><statusCode>1</statusCode><statusString>OK</statusString></ResponseStatus>');
      }
      xml(404, '<ResponseStatus><statusCode>4</statusCode><subStatusCode>notSupport</subStatusCode></ResponseStatus>');
    });
    await new Promise<void>((r) => this.server!.listen(porta, '127.0.0.1', r));
    const addr = this.server.address();
    return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : porta}`;
  }

  // Envia um evento como o equipamento faz: multipart com o JSON e, se houver, a foto.
  async enviarEvento(evento: Record<string, unknown>, comFoto = true): Promise<number> {
    if (!this.destinoEventos) throw new Error('Envio de eventos não configurado');
    const limite = 'MIME_boundary';
    const partes = [Buffer.from(`--${limite}\r\nContent-Disposition: form-data; name="event_log"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(evento)}\r\n`)];
    if (comFoto) partes.push(Buffer.from(`--${limite}\r\nContent-Disposition: form-data; name="Picture"; filename="Picture.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), FOTO_TESTE, Buffer.from('\r\n'));
    partes.push(Buffer.from(`--${limite}--\r\n`));
    const r = await fetch(this.destinoEventos, { method: 'POST', headers: { 'content-type': `multipart/form-data; boundary=${limite}` }, body: Buffer.concat(partes) });
    await r.arrayBuffer();
    return r.status;
  }

  async parar(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}

// Evento típico de rosto reconhecido (formato JSON da ISAPI).
export function eventoRosto(nome: string, reconhecido = true): Record<string, unknown> {
  return {
    ipAddress: '10.8.0.12', portNo: 80, protocol: 'HTTP', dateTime: new Date().toISOString(), activePostCount: 1,
    eventType: 'AccessControllerEvent', eventState: 'active', eventDescription: 'Access Controller Event',
    AccessControllerEvent: { deviceName: 'Portaria', majorEventType: 5, subEventType: reconhecido ? 75 : 76, name: reconhecido ? nome : undefined, doorNo: 1, picturesNumber: 1 },
  };
}
