# Colocar no ar

Sobe o sistema completo num servidor Linux: aplicação, PostgreSQL, HTTPS automático (Caddy + Let's Encrypt)
e backup diário do banco. Testado com Docker 29 e Docker Compose 5.

## 1. Servidor

- VPS no Brasil com IP fixo (2 vCPU, 4 GB de RAM, 80 GB de disco bastam para começar), Ubuntu 24.04.
- Instale o Docker: `curl -fsSL https://get.docker.com | sh`.
- Firewall (exemplo com ufw):

```bash
ufw allow 22/tcp            # SSH
ufw allow 80/tcp            # emissão do certificado HTTPS
ufw allow 443/tcp           # console
ufw allow 9000              # centrais (SIA DC-09, TCP e UDP)
ufw allow from IP_DA_EMPRESA to any port 9200 proto tcp   # feed Sur-Gard, só da empresa
ufw enable
```

O Docker publica portas por fora do ufw; se quiser que o ufw mande nas portas do Docker, use também
o firewall do provedor da VPS (recomendado).

## 2. Domínio

Crie um registro DNS do tipo A, por exemplo `monitoramento.shopsei.com.br`, apontando para o IP do servidor.
O certificado HTTPS é emitido sozinho na primeira subida, e só funciona depois que o DNS apontar.

## 3. Configuração

```bash
git clone https://github.com/Adriano-Sarue/shopsei-monitoramento.git
cd shopsei-monitoramento/deploy
cp .env.example .env
nano .env          # domínio e senhas
```

Se alguma central usar criptografia AES no DC-09, coloque as chaves em `deploy/config/accounts.json`
(formato em `config/accounts.example.json` na raiz). Esse arquivo não vai para o Git.

## 4. Subir

```bash
docker compose up -d --build
docker compose ps          # app deve ficar "healthy"
docker compose logs -f app
```

Abra `https://SEU_DOMINIO`, entre com `ADMIN_LOGIN` e `ADMIN_SENHA` e troque a senha em *Senha*.
Depois crie os operadores em *Usuários*.

Para vender o uso a outras empresas, defina `PLATAFORMA_SENHA` no `.env` antes da primeira subida e entre com
`PLATAFORMA_LOGIN`. Em *Empresas* você cria cada empresa compradora com o primeiro administrador e as rotas
(receptora e linha que as centrais dela usam). Ao criar a primeira empresa compradora, troque a rota `*` da sua
empresa pelas suas receptoras/linhas, senão os eventos novos dela continuam caindo na sua fila quando não houver
rota mais específica.

Para a portaria remota (abrir portão e receber chamadas dos leitores Hikvision), siga
[PORTARIA-VPN.md](PORTARIA-VPN.md).

## 5. Atualizar

```bash
cd shopsei-monitoramento && git pull && cd deploy && docker compose up -d --build
```

A fila em aberto sobrevive à atualização. As sessões caem: os operadores entram de novo e clicam em
*Ficar disponível*.

## 6. Backup e restauração

Uma cópia por dia fica em `deploy/backups/` (a primeira 2 minutos depois de subir), guardadas por
`BACKUP_DIAS` dias. **Copie essa pasta para fora do servidor** (outro provedor, Google Drive, S3):
backup no mesmo disco não salva de perder o servidor.

Restaurar uma cópia (apaga o banco atual):

```bash
docker compose stop app
docker compose exec -T db dropdb -U shopsei shopsei
docker compose exec -T db createdb -U shopsei shopsei
gunzip -c backups/shopsei-AAAA-MM-DD-HHMM.sql.gz | docker compose exec -T db psql -q -U shopsei shopsei
docker compose start app
```

Teste a restauração uma vez por mês num banco separado (`createdb -U shopsei teste` e restaure nele).

## 7. Vigilância

`https://SEU_DOMINIO/healthz` responde `{"ok":true}` sem login. Cadastre esse endereço num serviço de
monitoramento externo (UptimeRobot, Better Stack ou similar) com aviso por WhatsApp ou e-mail: um sistema
de alarme não pode cair em silêncio.
