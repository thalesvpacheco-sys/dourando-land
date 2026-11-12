# Dourado Land Intelligence: API + portal na mesma imagem (mesma origem).
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends unzip ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY . .
# Variáveis públicas do front entram no build (mapa de satélite etc.)
ARG VITE_MAP_STYLE_URL=
ARG VITE_SATELLITE_TILES=
ARG VITE_SATELLITE_ATTRIBUTION=
ARG VITE_GOOGLE_MAPS_API_KEY=
RUN npm run build -w web
ENV NODE_ENV=production WEB_DIST_DIR=/app/web/dist STORAGE_DIR=/data/storage PORT=4200
# A aplicação roda sem root; o volume de documentos herda o dono na primeira montagem
RUN mkdir -p /data/storage && chown -R node:node /data
USER node
WORKDIR /app/server
EXPOSE 4200
CMD ["npx", "tsx", "src/index.ts"]
