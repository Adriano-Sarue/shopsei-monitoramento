@echo off
chcp 65001 >nul
title Shop Sei Monitoramento - sistema
cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  O Node.js nao esta instalado.
  echo  Baixe a versao LTS em https://nodejs.org e instale com as opcoes padrao.
  echo  Depois abra este arquivo de novo.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Instalando os componentes do sistema pela primeira vez. Leva alguns minutos...
  call npm ci --no-audit --no-fund
  if errorlevel 1 ( echo Falhou a instalacao. Confira a internet e tente de novo. & pause & exit /b 1 )
)

if not exist dados mkdir dados
set BANCO_LOCAL=%cd%\dados\banco
set DADOS_DIR=%cd%\dados
set CONTAS_ARQUIVO=%cd%\config\accounts.json
set CONSOLE_PORTA=8090
set SURGARD_TCP_PORTA=9200
set RECEPTORA_TCP_PORTA=9000
set RECEPTORA_UDP_PORTA=9000
set EMPRESA_NOME=Shop Sei
set ADMIN_LOGIN=admin
set ADMIN_SENHA=shopsei-teste-1

echo.
echo  Sistema subindo. Deixe esta janela aberta enquanto testa.
echo  Abra no navegador: http://localhost:8090
echo  Primeiro acesso: usuario admin, senha shopsei-teste-1 (troque depois em Senha)
echo  Os dados ficam na pasta "dados". Para fechar, aperte Ctrl+C nesta janela.
echo.
start "" http://localhost:8090
call npx tsx src/index.ts
pause
