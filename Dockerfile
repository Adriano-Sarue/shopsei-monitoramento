FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci && npm cache clean --force
COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY db ./db
RUN mkdir -p /app/data /app/config && chown -R node:node /app/data /app/config
USER node
ENV NODE_ENV=production RECEPTORA_TCP_PORTA=9000 RECEPTORA_UDP_PORTA=9000 CONSOLE_PORTA=8090 DADOS_DIR=/app/data CONTAS_ARQUIVO=/app/config/accounts.json
EXPOSE 9000/tcp 9000/udp 8090/tcp
VOLUME ["/app/data", "/app/config"]
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8090/healthz >/dev/null || exit 1
CMD ["npx", "tsx", "src/index.ts"]
