FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
ENV RECEPTORA_TCP_PORTA=9000 RECEPTORA_UDP_PORTA=9000 DADOS_DIR=/app/data CONTAS_ARQUIVO=/app/config/accounts.json
EXPOSE 9000/tcp 9000/udp
VOLUME ["/app/data", "/app/config"]
CMD ["npx", "tsx", "src/index.ts"]
