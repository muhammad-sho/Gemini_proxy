FROM node:22-alpine

WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY server.js ./server.js
COPY dashboard.html ./dashboard.html

USER node
EXPOSE 18765
CMD ["node", "server.js"]
