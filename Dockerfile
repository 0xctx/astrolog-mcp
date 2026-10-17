# Three stages. The image holds no astrolog binary or ephemeris file from the host or the repo: the
# astrolog stage fetches and checks them with the project's own installer (scripts/install-astrolog.mjs).

# Build the TypeScript server into dist/. Dev dependencies stay in this stage.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Install Astrolog headless, the full Swiss core ephemeris set and the GeoNames tables. The installer
# verifies every download, and its smoke chart runs before this stage ends.
FROM node:22-slim AS astrolog
RUN apt-get update \
 && apt-get install -y --no-install-recommends make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY scripts ./scripts
RUN npm run install:astrolog -- --prefix /opt/astrolog

# The runtime: Node 22 slim, production dependencies only, a non-root user.
FROM node:22-slim AS runtime
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY --from=astrolog /opt/astrolog /opt/astrolog
COPY --from=astrolog --chown=node:node /app/data/geonames ./data/geonames

ENV ASTROLOG_BIN=/opt/astrolog/astrolog \
    ASTROLOG_MCP_DATA=/app/data/geonames \
    PORT=3000
# The image serves real numbers: the server starts astrolog from ASTROLOG_BIN, runs its smoke chart,
# and exits 1 with the reason on stderr when that fails.
ENV ENGINE=astrolog

EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "dist/index.js"]
