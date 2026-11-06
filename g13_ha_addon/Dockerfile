FROM node:20-alpine

WORKDIR /app

# package-lock.json jest teraz w repo — bez niego `npm install` rozwiązywał
# zależności na nowo przy każdej budowie, więc dwie budowy z tego samego
# commita mogły dać różne wersje tranzytywne.
COPY app/package.json app/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY app/ .

ENV NODE_ENV=production

EXPOSE 8099

# Healthcheck korzysta z /api/health, który raportuje też degradację KV.
HEALTHCHECK --interval=60s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8099/api/health >/dev/null 2>&1 || exit 1

# init:false w config.yaml → Node jest PID 1 i sam obsługuje SIGTERM
# (patrz graceful shutdown w server.js).
CMD ["node", "server.js"]
