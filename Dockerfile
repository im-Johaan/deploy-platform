# syntax=docker/dockerfile:1
#
# One file, three targets. All three services share @adp/core and the root
# lockfile, so the dependency layer is installed once and reused; only the
# per-service extras differ.
#
#   docker build --target upload .
#   docker build --target worker .
#   docker build --target proxy  .

# ---------------------------------------------------------------- dependencies
FROM node:22-bookworm-slim AS deps
WORKDIR /app

# Manifests only, so this layer is cached until a dependency actually changes.
COPY package.json package-lock.json ./
COPY packages/core/package.json ./packages/core/
COPY apps/upload/package.json ./apps/upload/
COPY apps/worker/package.json ./apps/worker/
COPY apps/proxy/package.json ./apps/proxy/

RUN npm ci --omit=dev --no-audit --no-fund

# ------------------------------------------------------------------- runtime
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# npm links workspace packages as relative symlinks, which COPY preserves,
# so node_modules/@adp/core resolves to /app/packages/core.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY packages ./packages

# --------------------------------------------------------------------- upload
FROM runtime AS upload
# git is NOT in the slim image, and the upload service clones repositories.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY apps/upload ./apps/upload
EXPOSE 3002
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.UPLOAD_PORT||3002)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "apps/upload/src/index.ts"]

# --------------------------------------------------------------------- worker
FROM runtime AS worker
# The worker drives the host daemon over the mounted socket. Only the client
# binary is needed — no daemon, no git (it reads source tarballs from storage).
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
COPY apps/worker ./apps/worker
CMD ["node", "--import", "tsx", "apps/worker/src/index.ts"]

# ---------------------------------------------------------------------- proxy
FROM runtime AS proxy
COPY apps/proxy ./apps/proxy
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PROXY_PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "apps/proxy/src/index.ts"]
