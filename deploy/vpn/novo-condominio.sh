#!/usr/bin/env bash
# Gera a VPN (WireGuard) de um condomínio da portaria remota.
#
#   sudo ./novo-condominio.sh <número 1-250> <rede local do condomínio> [nome]
#   ex.: sudo ./novo-condominio.sh 1 192.168.1.0/24 "Cond. Zé Moreira"
#
# Cada condomínio ganha a faixa 10.8.<número>.0/24: o equipamento 192.168.1.50 do condomínio 1 passa a ser
# 10.8.1.50 para o sistema. Isso evita conflito entre condomínios que usam a mesma rede (quase todos usam
# 192.168.0.x ou 192.168.1.x). Cria condominios/<número>/ com:
#   condominio.conf  configuração do aparelho no condomínio (roteador com WireGuard, Raspberry Pi, GL.iNet)
#   servidor.conf    bloco que entra no /etc/wireguard/wg0.conf do servidor (use --aplicar para colocar já)
set -euo pipefail

aplicar=0
if [[ "${1:-}" == "--aplicar" ]]; then aplicar=1; shift; fi
numero="${1:-}"; rede="${2:-}"; nome="${3:-condominio $numero}"
WG_DIR="${WG_DIR:-/etc/wireguard}"
SERVIDOR="${SERVIDOR:-}"
PORTA="${PORTA_WG:-51820}"

erro() { echo "Erro: $*" >&2; exit 1; }
[[ "$numero" =~ ^[0-9]+$ ]] && (( numero >= 1 && numero <= 250 )) || erro "número do condomínio deve ser de 1 a 250"
[[ "$rede" =~ ^([0-9]{1,3}\.){3}0/24$ ]] || erro "rede local deve ser uma /24 terminada em .0, ex.: 192.168.1.0/24"
[[ -n "$SERVIDOR" ]] || erro "defina SERVIDOR=endereço público do servidor (ex.: SERVIDOR=monitoramento.shopsei.com.br)"
command -v wg >/dev/null || erro "instale o WireGuard: apt install wireguard-tools"
[[ -r "$WG_DIR/servidor.pub" ]] || erro "chave do servidor não encontrada em $WG_DIR/servidor.pub (veja deploy/PORTARIA-VPN.md, passo 1)"

destino="condominios/$numero"
[[ -e "$destino" ]] && erro "$destino já existe: o número $numero já foi usado"
mkdir -p "$destino"
umask 077
privada=$(wg genkey)
publica=$(printf '%s' "$privada" | wg pubkey)
pub_servidor=$(cat "$WG_DIR/servidor.pub")

cat > "$destino/condominio.conf" <<CONF
# $nome: aparelho WireGuard dentro da rede do condomínio ($rede).
# Linux / Raspberry Pi / OpenWrt com wg-quick: salve como /etc/wireguard/shopsei.conf e rode
#   systemctl enable --now wg-quick@shopsei
# Troque eth0 pela interface de rede local do aparelho.
[Interface]
PrivateKey = $privada
Address = 10.8.$numero.254/32
PostUp = sysctl -w net.ipv4.ip_forward=1; iptables -t nat -A PREROUTING -i %i -d 10.8.$numero.0/24 -j NETMAP --to $rede; iptables -t nat -A POSTROUTING -s 10.8.0.0/24 -o eth0 -j MASQUERADE
PostDown = iptables -t nat -D PREROUTING -i %i -d 10.8.$numero.0/24 -j NETMAP --to $rede; iptables -t nat -D POSTROUTING -s 10.8.0.0/24 -o eth0 -j MASQUERADE

[Peer]
PublicKey = $pub_servidor
Endpoint = $SERVIDOR:$PORTA
AllowedIPs = 10.8.0.0/24
PersistentKeepalive = 25
CONF

cat > "$destino/servidor.conf" <<CONF

# $nome ($rede vira 10.8.$numero.0/24)
[Peer]
PublicKey = $publica
AllowedIPs = 10.8.$numero.0/24
CONF

echo "Condomínio $numero ($nome) criado em $destino/"
echo "  No sistema, o equipamento 192.168.x.Y do condomínio fica em http://10.8.$numero.Y"
if (( aplicar )); then
  cat "$destino/servidor.conf" >> "$WG_DIR/wg0.conf"
  wg set wg0 peer "$publica" allowed-ips "10.8.$numero.0/24"
  ip route replace "10.8.$numero.0/24" dev wg0
  echo "  Já ativo no servidor (wg0)."
else
  echo "  Falta ativar no servidor: rode de novo com --aplicar, ou cole $destino/servidor.conf no $WG_DIR/wg0.conf"
fi
