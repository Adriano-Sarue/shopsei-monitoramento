# Ponte Shop Sei: leva o feed Sur-Gard do Active Net (porta serial COM) até o sistema de monitoramento (TCP).
# Não precisa instalar nada: usa o PowerShell que já vem no Windows.
#
#   Modo normal (padrão): a ponte devolve ao Active Net o ACK/NAK que o sistema responde. Use quando o sistema
#   ocupa a porta que era do Moni (o Moni fechado).
#   Modo -SoEscutar: a ponte só lê e nunca responde ao Active Net. Use quando o Moni continua respondendo na
#   mesma linha (porta compartilhada pelo divisor do VSPE).
#
# Exemplo: powershell -ExecutionPolicy Bypass -File ponte-active-net.ps1 -Porta COM2 -Servidor 127.0.0.1
param(
  [string]$Porta = 'COM2',
  [int]$Velocidade = 1200,
  [string]$Servidor = '127.0.0.1',
  [int]$PortaServidor = 9200,
  [switch]$SoEscutar
)

$ErrorActionPreference = 'Stop'
$Host.UI.RawUI.WindowTitle = "Ponte Shop Sei - $Porta para ${Servidor}:$PortaServidor"
$pasta = Split-Path -Parent $MyInvocation.MyCommand.Path
$registro = Join-Path $pasta 'ponte.log'

function Registrar([string]$texto) {
  $linha = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $texto
  Write-Host $linha
  Add-Content -Path $registro -Value $linha -Encoding UTF8
}

function Visivel([byte[]]$bytes, [int]$n) {
  $t = ''
  for ($i = 0; $i -lt $n; $i++) {
    $b = $bytes[$i]
    if ($b -eq 0x06) { $t += '<ACK>' } elseif ($b -eq 0x15) { $t += '<NAK>' } elseif ($b -eq 0x14) { $t += '<FIM>' }
    elseif ($b -ge 32 -and $b -lt 127) { $t += [char]$b } else { $t += ('<{0:X2}>' -f $b) }
  }
  return $t
}

# Batimento Sur-Gard a cada 30 s: o sistema avisa "base sem sinal" se ele parar de chegar.
[byte[]]$batimento = [System.Text.Encoding]::ASCII.GetBytes('1011           @    ') + [byte]0x14

$serial = New-Object System.IO.Ports.SerialPort $Porta, $Velocidade, ([System.IO.Ports.Parity]::None), 8, ([System.IO.Ports.StopBits]::One)
$serial.ReadTimeout = 50
try { $serial.Open() } catch {
  Registrar "ERRO: não consegui abrir a $Porta. Ela existe e está livre? (Se o Moni estiver usando, feche o Moni ou use o divisor do VSPE com -SoEscutar.) $($_.Exception.Message)"
  Read-Host 'Aperte Enter para sair'; exit 1
}
Registrar ("Porta $Porta aberta a $Velocidade bps. Modo: " + $(if ($SoEscutar) { 'só escutar (o Moni responde ao Active Net)' } else { 'normal (o sistema responde ao Active Net)' }))

$buf = New-Object byte[] 4096
while ($true) {
  $tcp = $null
  try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $tcp.NoDelay = $true
    $tcp.Connect($Servidor, $PortaServidor)
    $rede = $tcp.GetStream()
    Registrar "Conectado ao sistema em ${Servidor}:$PortaServidor"
    $proximoBatimento = (Get-Date).AddSeconds(1)
    while ($tcp.Connected) {
      $fez = $false
      if ($serial.BytesToRead -gt 0) {
        $n = $serial.Read($buf, 0, [Math]::Min($buf.Length, $serial.BytesToRead))
        if ($n -gt 0) { $rede.Write($buf, 0, $n); Registrar ('Active Net -> sistema: ' + (Visivel $buf $n)); $fez = $true }
      }
      if ($rede.DataAvailable) {
        $n = $rede.Read($buf, 0, $buf.Length)
        if ($n -le 0) { break }
        if (-not $SoEscutar) { $serial.Write($buf, 0, $n) }
        Registrar ('sistema -> Active Net: ' + (Visivel $buf $n) + $(if ($SoEscutar) { ' (não repassado: modo só escutar)' } else { '' }))
        $fez = $true
      }
      if ((Get-Date) -ge $proximoBatimento) {
        $rede.Write($batimento, 0, $batimento.Length)
        $proximoBatimento = (Get-Date).AddSeconds(30)
      }
      # Conexão fechada pelo outro lado: dá para ler, mas não há nada.
      if (-not $fez -and $tcp.Client.Poll(0, [System.Net.Sockets.SelectMode]::SelectRead) -and $tcp.Client.Available -eq 0) { break }
      if (-not $fez) { Start-Sleep -Milliseconds 20 }
    }
    Registrar 'O sistema fechou a conexão'
  } catch {
    Registrar "Sem conexão com o sistema em ${Servidor}:$PortaServidor ($($_.Exception.Message)). Tentando de novo em 5 s"
  } finally {
    if ($tcp) { $tcp.Close() }
  }
  # No modo normal, o que chegou sem conexão é descartado: sem ACK, o Active Net guarda e reenvia o evento.
  if (-not $SoEscutar) { $serial.DiscardInBuffer() }
  Start-Sleep -Seconds 5
}
