# ---- dipendenze ----
FROM node:22-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production

# ---- runtime ----
FROM node:22-alpine
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3001

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# node:alpine already ships the unprivileged `node` user: this does not run as root.
USER node

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
	CMD wget --spider -q "http://127.0.0.1:${PORT}/health" || exit 1

CMD ["node", "index.js"]
