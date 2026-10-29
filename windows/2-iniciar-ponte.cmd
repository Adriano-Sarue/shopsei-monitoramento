@echo off
chcp 65001 >nul
rem Ponte do Active Net: leva o feed da porta COM ate o sistema.
rem Troque COM2 pela porta certa. Sem "-SoEscutar", o sistema responde ao Active Net (feche o Moni antes).
rem Com "-SoEscutar", o Moni continua respondendo (precisa do divisor de porta do VSPE).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0ponte-active-net.ps1" -Porta COM2 -Servidor 127.0.0.1 -PortaServidor 9200
pause
