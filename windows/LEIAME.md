# Teste prático no Windows

Roda o sistema inteiro num PC com Windows, sem servidor e sem instalar banco de dados. Os dados ficam na pasta `dados`.
Dá para usar o PC do Active Net ou outro da mesma rede.

## 1. Instalar o Node.js (uma vez)

Baixe a versão **LTS** em https://nodejs.org e instale com as opções padrão.

## 2. Abrir o sistema

1. Extraia o arquivo `shopsei-monitoramento.zip` numa pasta, por exemplo `C:\ShopSei`.
2. Dê dois cliques em `windows\1-iniciar-sistema.cmd`.
   Na primeira vez ele baixa os componentes, o que leva alguns minutos e precisa de internet.
3. O navegador abre em **http://localhost:8090**. Entre com o usuário `admin` e a senha `shopsei-teste-1`.
   Troque a senha logo no primeiro acesso, em **Senha** na barra de cima.
4. Deixe a janela preta aberta enquanto testa. Para fechar, aperte **Ctrl+C** nela; não feche no X, para o banco gravar direito.

Se o Windows perguntar sobre o firewall, permita só em **redes privadas**.

## 3. Teste sem mexer no Active Net

1. **Usuários:** crie um ou dois operadores.
2. **Clientes:** cadastre um cliente com uma conta de verdade, os contatos e o link de uma câmera.
3. **Configurações → Testar o sistema:** escolha a conta e gere um disparo, um pânico, uma falha de energia e uma "central sem
   comunicação". Os eventos entram na fila marcados "(teste)".
4. **Fila:** clique em **Ficar disponível**, depois em **Ciente** no pop-up (a câmera abre numa janela separada), use os
   registros rápidos e conclua com um motivo.
5. Teste também **Trocar de turno** e o **Histórico**.

## 4. Teste com o feed real do Active Net

O Active Net manda os eventos pela porta COM2, que hoje é do Moni. Durante este teste o Moni fica fechado e quem recebe e
responde é o sistema novo. Por isso, escolha um horário calmo e deixe alguém olhando a tela do sistema novo.

1. Com o sistema aberto (passo 2), **feche o Moni**.
2. Dê dois cliques em `windows\2-iniciar-ponte.cmd`. Se a porta não for a COM2, abra esse arquivo no Bloco de Notas e troque.
3. A janela da ponte mostra "Conectado ao sistema" e cada linha que chega do Active Net. Em **Configurações** aparece
   "Internet da base: ● Conectada".
4. Arme e desarme uma central e veja os eventos chegarem na Fila.
5. **Falta de internet da base:** feche a janela da ponte. Em até 2 minutos abre o alarme "Base sem sinal", com sirene.
   Abra a ponte de novo e o sistema anota "Sinal da base voltou".
6. Ao terminar, feche a ponte e **abra o Moni de novo**.
7. Me mande o arquivo `windows\ponte.log`. Ele traz as linhas reais do Active Net, para eu conferir o arme e o desarme e os
   códigos da JFL de bateria, tampa do sensor, programação e falta de comunicação.

### Se quiser rodar junto com o Moni

O VSPE tem um dispositivo **Splitter**, que divide uma porta para dois programas. Com ele, a ponte roda só escutando
(acrescente `-SoEscutar` no fim da linha do `2-iniciar-ponte.cmd`) e o Moni continua respondendo ao Active Net.
Ainda não testei essa montagem do VSPE aí; se quiser, fazemos juntos.

## Problemas comuns

- **"O Node.js não está instalado":** instale (passo 1) e abra o arquivo de novo.
- **A ponte diz "não consegui abrir a COM2":** o Moni ainda está aberto, ou a porta é outra.
- **A ponte diz "Sem conexão com o sistema":** a janela do sistema (passo 2) não está aberta.
- **Começar do zero:** feche o sistema e apague a pasta `dados`.
