# ---- build stage ------
# Static files, the same for every architecture: built on the machine's own
# platform, so a multi-arch release does not emulate the whole Vite build.
FROM --platform=$BUILDPLATFORM node:22-alpine AS builder

WORKDIR /app

ENV NODE_OPTIONS=--dns-result-order=ipv4first

RUN corepack enable
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY . .

# No configuration ARG/ENV: URLs and credentials never enter the bundle, they
# arrive at runtime from /config.json (see nginx/40-bussola-config.sh).
RUN yarn build

# The sha256 of index.html's inline script, for the Content-Security-Policy.
# Computed here, from the file this image will serve, so that editing the
# script cannot leave the policy allowing the old one (nginx/18-bussola-csp.envsh).
RUN node scripts/csp-hashes.mjs dist/index.html > /app/csp-script-hashes

# ---- Production stage ----
FROM nginx:alpine

# Valori di default: sovrascrivibili dal docker-compose o da `docker run -e`.
ENV BUSSOLA_API_URL=/api \
	BUSSOLA_API_UPSTREAM=http://api:3001 \
	BUSSOLA_DNS_RESOLVER=127.0.0.11

RUN rm /etc/nginx/conf.d/default.conf
COPY nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY nginx/bussola-security-headers.inc.template /etc/nginx/templates/bussola-security-headers.inc.template
COPY nginx/config.json.template /etc/bussola/config.json.template
COPY nginx/40-bussola-config.sh /docker-entrypoint.d/40-bussola-config.sh
# Sourced (not run) by the entrypoint, before the templates are rendered; it
# has to be executable to be picked up at all.
COPY nginx/18-bussola-csp.envsh /docker-entrypoint.d/18-bussola-csp.envsh
COPY --from=builder /app/csp-script-hashes /etc/bussola/csp-script-hashes
RUN chmod +x /docker-entrypoint.d/40-bussola-config.sh /docker-entrypoint.d/18-bussola-csp.envsh

COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
	CMD wget --spider -q http://127.0.0.1/config.json || exit 1

CMD ["nginx", "-g", "daemon off;"]
