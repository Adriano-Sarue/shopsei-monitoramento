# Portaria remota: ligar os equipamentos dos condomínios

O sistema conversa direto com o leitor facial ou interfone Hikvision de cada condomínio (API local ISAPI),
sem passar pela nuvem do Hik-Connect. Fica assim:

- **Comandos** (abrir porta, ver se há visitante chamando, foto da câmera): do servidor para o equipamento,
  por uma **VPN WireGuard** até a rede do condomínio.
- **Eventos** (rosto reconhecido, rosto não reconhecido, porta aberta): do equipamento para o servidor,
  por **HTTPS no domínio do console**, com um endereço secreto por equipamento. Não precisa de rota extra.

O Hik-Connect continua funcionando como hoje (inclusive a conversa por voz).

## 1. No servidor (uma vez)

```bash
apt install -y wireguard-tools
cd /etc/wireguard
umask 077
wg genkey | tee servidor.key | wg pubkey > servidor.pub
cat > wg0.conf <<CONF
[Interface]
Address = 10.8.0.1/24
ListenPort = 51820
PrivateKey = $(cat servidor.key)
CONF
systemctl enable --now wg-quick@wg0
ufw allow 51820/udp            # e libere também no firewall do provedor da VPS
```

No `deploy/.env`, defina `CHAVE_EQUIPAMENTOS` (frase longa, guarde junto com o backup: sem ela o sistema
não lê as senhas dos equipamentos já cadastrados) e suba de novo com `docker compose up -d`.

## 2. Para cada condomínio

1. Dê um **número** ao condomínio (1, 2, 3...; anote numa planilha) e descubra a **rede local** dele
   (ex.: `192.168.1.0/24`).
2. No servidor:

   ```bash
   cd /root/shopsei-monitoramento/deploy/vpn
   sudo SERVIDOR=monitoramento.shopsei.com.br ./novo-condominio.sh --aplicar 1 192.168.1.0/24 "Cond. Zé Moreira"
   ```

   O script cria `condominios/1/condominio.conf`. Para o sistema, o equipamento `192.168.1.50` do
   condomínio 1 passa a ser `10.8.1.50`, e condomínios que usam a mesma rede não se misturam.
3. No condomínio, coloque o `condominio.conf` num aparelho com WireGuard ligado na rede local. Pode ser
   um roteador com WireGuard (GL.iNet, OpenWrt) ou um Raspberry Pi. O aparelho não precisa ser o
   roteador principal nem precisa de porta aberta na internet do condomínio: ele mesmo chama o servidor.
   No arquivo, troque `eth0` pelo nome da interface de rede do aparelho.
4. No roteador do condomínio, reserve um **IP fixo** para o leitor (reserva de DHCP).
5. No leitor (pelo navegador, na rede do condomínio), crie um **usuário só para o sistema**, com
   permissão de controle de acesso e de configuração de eventos.
6. Confira do servidor: `ping 10.8.1.50` (troque pelo endereço do leitor).

## 3. No sistema

Em **Condomínios**, abra o condomínio:

1. **+ Equipamento**: nome (ex.: Portão social), endereço `http://10.8.1.50`, usuário e senha criados no
   passo 2.5 e número da porta (1 na maioria dos leitores).
2. **Testar**: deve mostrar o modelo, por exemplo DS-K1T342MWX.
3. **Ligar envio de eventos**: o equipamento passa a mandar os acessos para o sistema.

Na tela **Portaria**, o operador passa a ver:

- o botão **Abrir** de cada equipamento, com confirmação em dois cliques e registro de quem abriu;
- o aviso **Chamando agora** quando o visitante aperta o botão do leitor, com a foto da câmera e os botões
  Atender, Abrir porta e Encerrar chamada;
- os últimos eventos do leitor, com foto.

## Segurança

- A senha do equipamento é guardada cifrada (AES-256-GCM) com a `CHAVE_EQUIPAMENTOS`. Ela nunca aparece
  na tela nem na API.
- O aparelho do condomínio só aceita tráfego vindo do servidor (10.8.0.0/24), e o servidor só alcança a
  faixa daquele condomínio.
- Cada equipamento envia eventos para um endereço próprio e secreto. Se apagar o equipamento no sistema,
  esse endereço para de valer.

## A conferir no primeiro condomínio

- Os textos dos eventos (rosto reconhecido, porta destrancada etc.) seguem a tabela pública da ISAPI.
  Confira com o leitor real; um código desconhecido aparece como "Evento do leitor (código X/Y)".
- O aviso de chamada usa o estado de chamada do leitor (`/ISAPI/VideoIntercom/callStatus`). Se o seu
  firmware não tiver esse recurso, o equipamento aparece como "sem resposta" na tela e a chamada continua
  só no Hik-Connect.
