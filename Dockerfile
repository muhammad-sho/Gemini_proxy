# ---- Build stage: compile server + dashboard ----
FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
# Lockfile is generated with --legacy-peer-deps (peer ranges of newer Vite/React
# tooling overlap); npm must use the same mode or ci() rejects the tree.
RUN npm ci --legacy-peer-deps --no-audit --no-fund

COPY tsconfig.json eslint.config.mjs ./
COPY src ./src
COPY web ./web

RUN npm run build && npm run web:build

# Prune to production dependencies only (dist/ and dist-web/ are static outputs)
RUN npm prune --omit=dev --legacy-peer-deps

# ---- Runtime stage: non-root, minimal ----
FROM node:22-alpine AS runtime
WORKDIR /app
RUN addgroup -S app && adduser -S app -G app \
    && mkdir -p /data && chown app:app /data

ENV NODE_ENV=production \
    DB_PATH=/data/gemini-proxy.db \
    PORT=18765

COPY --from=build --chown=app:app /app/node_modules ./node_modules
COPY --from=build --chown=app:app /app/dist ./dist
COPY --from=build --chown=app:app /app/dist-web ./dist-web
COPY --from=build --chown=app:app /app/package.json ./package.json

USER app
EXPOSE 18765

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health/live" >/dev/null 2>&1 || exit 1

CMD ["node", "dist/main.js"]
