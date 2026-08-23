FROM node:22-alpine

WORKDIR /app
RUN apk add --no-cache su-exec \
    && mkdir -p /data
COPY server.js ./server.js
COPY dashboard.html ./dashboard.html
COPY --chmod=755 entrypoint.sh ./entrypoint.sh

EXPOSE 18765
ENTRYPOINT ["/app/entrypoint.sh"]
