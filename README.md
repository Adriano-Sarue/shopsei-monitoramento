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

## Banco de dados e clientes

Com `DATABASE_URL` (PostgreSQL 14+), o sistema cria as tabelas sozinho (`db/schema.sql`),
guarda eventos, ocorrências e clientes, e **retoma a fila depois de um reinício**
(ocorrências que estavam em atendimento voltam para "aguardando"). Sem `DATABASE_URL` ele
roda em memória, só para desenvolvimento.

Os clientes são cadastrados em `http://servidor:8090/clientes.html` (nome, contas, endereço,
palavra-chave, contra-senha e até 3 providências). A palavra-chave e a contra-senha só
aparecem para o operador que está atendendo a ocorrência. Uma conta só pode pertencer a um cliente.

```bash
DATABASE_URL=postgres://usuario:senha@localhost:5432/shopsei ADMIN_SENHA=troque-esta-senha npm start
```

Testes com PostgreSQL: `PG_TEST_URL=postgres://... npm test` (sem a variável, esses testes são pulados).

## Console web e login

Defina `CONSOLE_PORTA` (padrão 8090) e abra `http://servidor:8090/`. Cada pessoa entra com **usuário e senha**
(senha guardada só como hash scrypt; sessão em cookie `HttpOnly`/`SameSite=Strict`, 12 h; 5 senhas erradas
bloqueiam o login por 5 minutos). Há dois perfis: **operador** (atende a fila) e **administrador** (também
cadastra clientes e usuários em *Clientes* e *Usuários*).

Na primeira subida o sistema cria o administrador `admin` (ou `ADMIN_LOGIN`) com a senha de `ADMIN_SENHA`;
se ela não for definida, uma senha aleatória aparece uma vez no log. Troque-a em *Usuários*.
`CONSOLE_TOKEN` é opcional e serve só para scripts (acesso de administrador por `Authorization: Bearer`).

A fila mostra Aguardando, Pendente e Em atendimento; o operador clica em *Ficar disponível* e a receptora
distribui as ocorrências (mais urgente primeiro). Ele conclui (motivo e texto) ou adia 15/30/60 min. As cores
da Shop Sei ficam em `public/app.css` (variáveis no topo). **Ponha atrás de HTTPS** antes de expor na internet
(com HTTPS o cookie sai como `Secure` quando o proxy envia `X-Forwarded-Proto: https`, ou defina `COOKIE_SEGURO=1`).

## O que mais o console faz

- **Feed parado:** o selo "Último evento" fica vermelho se nenhuma central mandar nada (nem teste/keep alive) por 10 minutos.
- **Operador que sumiu:** se o navegador do operador fica 90 s sem consultar (fechou, caiu a internet), ele sai da escala e as ocorrências dele voltam para a fila. O mesmo vale no Sair.
- **Câmeras:** cada cliente pode ter até 3 links de câmera (visualizador web ou nuvem da marca); aparecem como botões só para quem está atendendo.
- **Histórico:** ocorrências encerradas com filtro por conta e data, e exportação CSV (abre no Excel).
- **Plano de ação:** cada ocorrência mostra os passos do tipo de evento (disparo, pânico, coação, incêndio, falha de energia, comunicação) para o operador marcar, mais as instruções próprias do cliente, que valem mais que o padrão.
- **Registro de ligações e anotações:** botões Atendeu / Não atendeu / Recado em cada providência e campo livre; tudo fica no histórico da ocorrência com hora e operador.
- **Falta de teste periódico:** no cadastro do cliente, escolha o prazo máximo sem sinal das centrais (1 a 48 h); passou, abre ocorrência.
- **Falha de energia espera:** falha AC fica `FALHA_ENERGIA_ESPERA_MIN` minutos (padrão 30, 0 desliga) em pendente antes de ir à fila; um disparo na mesma conta traz a ocorrência de volta na hora. Quem conclui é sempre o operador.
- **Trocar senha:** cada usuário troca a própria em *Senha*.

## Várias empresas (venda do sistema)

Um servidor atende várias empresas de monitoramento. Cada uma tem a **sua fila, os seus clientes, o seu histórico e
os seus usuários**, e uma não vê nada da outra (a mesma conta pode existir em empresas diferentes).

- **De quem é cada evento:** pelas *rotas* da empresa, que dizem canal (Sur-Gard ou IP/DC-09), receptora e linha
  (`*` = qualquer). A rota mais específica vale: receptora exata ganha de linha exata, que ganha de `*`.
  Evento que nenhuma rota reconhece não entra em fila nenhuma e aparece em *Eventos sem empresa*.
- **Primeira subida:** cria a empresa `EMPRESA_NOME` (padrão Shop Sei) com rotas `*` nos dois canais, então tudo
  continua funcionando como antes. Bancos antigos são migrados sozinhos: os dados viram da empresa 1.
- **Dono do sistema:** com `PLATAFORMA_SENHA` definida, a primeira subida cria o usuário `PLATAFORMA_LOGIN`
  (padrão `plataforma`). Ele entra em *Empresas*: cria empresa com o primeiro administrador, ajusta rotas,
  cria usuário numa empresa (para recuperar acesso) e suspende/reativa. Suspender derruba quem está dentro e
  impede novo login; os eventos continuam chegando à fila da empresa. O dono do sistema não vê fila nem clientes.

## Feed Sur-Gard (Active Net 3)

Na Shop Sei os eventos chegam ao Moni pelo Active Net 3, que os repassa por porta
serial no protocolo Sur-Gard. Definindo `SURGARD_TCP_PORTA`, a receptora também ouve esse
feed por TCP (uma ponte no PC da empresa leva a porta serial até aqui) e responde
ACK/NAK por mensagem. O decodificador usa o formato público e é **provisório** até
validarmos com uma captura real do feed.

## Pendente

- Validar o decodificador Sur-Gard com uma mensagem bruta atual (o `Monitor.Txt` do Moni
  só vai até 12/2024) e a ponte que leva o feed serial do PC da empresa até o servidor.
- HTTPS (certificado/proxy) e logo oficial da Shop Sei.
- Relatórios, envio de e-mail ao cliente e importação dos clientes existentes.

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
`DATABASE_URL`, `ADMIN_LOGIN`, `ADMIN_SENHA`, `EMPRESA_NOME`, `PLATAFORMA_LOGIN`, `PLATAFORMA_SENHA`, `SURGARD_TCP_PORTA` (opcional), `CONTAS_ARQUIVO` (padrão `config/accounts.json`), `DADOS_DIR` (padrão `data`).

Para colocar no ar num servidor (com banco, HTTPS e backup), siga [deploy/LEIAME.md](deploy/LEIAME.md).

Só a aplicação, com Docker:

```bash
docker build -t shopsei-receptora .
docker run -p 9000:9000/tcp -p 9000:9000/udp -v $PWD/data:/app/data -v $PWD/config:/app/config shopsei-receptora
```

## Testes

```bash
npm test
npm run typecheck
```
