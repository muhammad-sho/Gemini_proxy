FROM node:22-alpine

WORKDIR /app
RUN apk add --no-cache su-exec \
    && mkdir -p /data
COPY server.js ./server.js
COPY dashboard.html ./dashboard.html
COPY --chmod=755 entrypoint.sh ./entrypoint.sh

EXPOSE 18765
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -qO /dev/null "http://127.0.0.1:${PORT:-18765}/health" || exit 1
ENTRYPOINT ["/app/entrypoint.sh"]
