# bussola-quotes: Node and the source, no dependencies.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

WORKDIR /app
COPY package.json server.js ./
COPY src ./src
COPY providers ./providers

# node:alpine already ships the unprivileged `node` user: this does not run as root.
USER node

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "server.js"]
