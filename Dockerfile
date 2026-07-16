# ── Build stage: install everything + build the web bundle ──
FROM node:24-slim AS build
WORKDIR /app
# Toolchain for compiling better-sqlite3's native addon.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:web

# ── Runtime stage: prod deps only + the built app ──
FROM node:24-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server ./server
COPY engine ./engine
COPY --from=build /app/web/dist ./web/dist
# Reachable from outside the container; DB on the mounted volume.
ENV HOST=0.0.0.0
ENV PORT=8787
ENV DATA_DIR=/data
EXPOSE 8787
CMD ["node", "server/index.ts"]
