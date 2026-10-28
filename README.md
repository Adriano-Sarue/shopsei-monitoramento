# Shop Sei Monitoramento

Sistema próprio de monitoramento de alarmes da Shop Sei. Esta primeira parte é a
**receptora de eventos**: recebe os eventos das centrais de alarme por IP, responde
à central, decodifica e grava tudo.

## O que já funciona

- Receptora **SIA DC-09** por TCP e UDP: confere CRC e comprimento, responde ACK
  (evento aceito) ou NAK (quadro inválido, com data/hora para a central acertar o relógio).
- Criptografia **AES** (128/192/256 bits) por conta, configurada em `config/accounts.json`.
- Decodificação de **Contact ID** (`ADM-CID`) e **SIA** (`SIA-DCS`), com descrição
  em português, categoria (alarme, falha, arme/desarme, teste, supervisão) e prioridade.
- Mensagens de supervisão (`NULL`) registradas como teste de link.
- Qualquer formato ainda não suportado é gravado como evento "outro", com o conteúdo
  bruto, para nunca perder um evento.
- Registro bruto de todo quadro recebido em `data/bruto-AAAA-MM-DD.jsonl` e dos eventos
  em `data/eventos-AAAA-MM-DD.jsonl`.
- **Simulador de central** para testar sem mexer nos clientes reais.

## Feed Sur-Gard (Active Net 3)

Na Shop Sei os eventos chegam ao Moni pelo Active Net 3, que os repassa por porta
serial no protocolo Sur-Gard. Definindo `SURGARD_TCP_PORTA`, a receptora também ouve esse
feed por TCP (uma ponte no PC da empresa leva a porta serial até aqui) e responde
ACK/NAK por mensagem. O decodificador usa o formato público e é **provisório** até
validarmos com uma captura real do feed.

## Pendente

- Confirmar o formato que as centrais **JFL** usam ao reportar por IP. Se for
  Contact ID/SIA dentro do DC-09, já funciona; se for um formato próprio da JFL,
  entra como um novo decodificador em `src/protocols/`.
- Banco PostgreSQL, fila de ocorrências, console do operador e relatórios (próximas etapas).

## Como rodar

Requer Node.js 22.

```bash
npm install
cp config/accounts.example.json config/accounts.json   # cadastre as contas
npm start                                              # ouve TCP e UDP na porta 9000
```

Em outro terminal, simule uma central:

```bash
npm run simular -- --conta 1234 --evento "1130 01 003"                 # disparo, zona 3
npm run simular -- --conta 1234 --protocolo SIA-DCS --evento "Nri1/FA002" --udp
npm run simular -- --conta 5678 --chave 00112233445566778899AABBCCDDEEFF --evento "1120 01 000"
npm run simular -- --conta 1234 --protocolo NULL                       # supervisão
```

Variáveis de ambiente: `RECEPTORA_TCP_PORTA`, `RECEPTORA_UDP_PORTA` (padrão 9000),
`SURGARD_TCP_PORTA` (opcional), `CONTAS_ARQUIVO` (padrão `config/accounts.json`), `DADOS_DIR` (padrão `data`).

Com Docker:

```bash
docker build -t shopsei-receptora .
docker run -p 9000:9000/tcp -p 9000:9000/udp -v $PWD/data:/app/data -v $PWD/config:/app/config shopsei-receptora
```

## Testes

```bash
npm test
npm run typecheck
```
