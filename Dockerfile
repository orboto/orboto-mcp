# syntax=docker/dockerfile:1.7
# BuildKit cache-mount support — Coolify exports DOCKER_BUILDKIT=1.

# ── builder ─────────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

# Install pnpm from GitHub (avoids registry.npmjs.org flakiness — same
# rationale as apps/api/Dockerfile). Pin version in lockstep with the
# root package.json `packageManager` field.
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) PNPM_ARCH=x64 ;; \
      arm64) PNPM_ARCH=arm64 ;; \
      *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && wget -qO /usr/local/bin/pnpm "https://github.com/pnpm/pnpm/releases/download/v10.33.0/pnpm-linuxstatic-${PNPM_ARCH}" \
 && chmod +x /usr/local/bin/pnpm \
 && pnpm --version
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY apps/mcp/package.json ./apps/mcp/
COPY packages/shared-schema/package.json ./packages/shared-schema/

# pnpm content-addressable store cache — same pattern as the API image.
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store,sharing=locked \
    pnpm install --frozen-lockfile --prefer-offline

COPY packages ./packages
COPY apps/mcp/src ./apps/mcp/src
COPY apps/mcp/tsconfig.json ./apps/mcp/tsconfig.json

# Build shared-schema first (workspace dep), then rewrite its package.json
# so prod node resolves dist/* — identical hack to the API Dockerfile.
RUN pnpm --filter @orboto/shared-schema build
RUN node -e "const p=require('./packages/shared-schema/package.json'); p.main='./dist/index.js'; p.types='./dist/index.d.ts'; p.files=['dist']; require('fs').writeFileSync('./packages/shared-schema/package.json', JSON.stringify(p, null, 2));"

RUN pnpm --filter @orboto/mcp build

# pnpm deploy — copies the package + workspace deps as concrete modules
# under /deploy/mcp. --legacy preserves pre-pnpm-v10 behaviour (no
# inject-workspace-packages requirement) since shared-schema has already
# been rewired to its dist output above.
RUN pnpm --filter @orboto/mcp deploy --legacy --prod /deploy/mcp

# ── runner ──────────────────────────────────────────────────────────────────
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Default to the HTTP transport — that's the container's reason to exist.
# Operators running stdio mode locally don't go through this image at all
# (they `node apps/mcp/dist/index.js` directly).
ENV ORBIT_MCP_TRANSPORT=http \
    ORBIT_MCP_PORT=3100

COPY --from=builder /deploy/mcp/node_modules ./node_modules
COPY --from=builder /deploy/mcp/dist ./dist

# wget already ships in the busybox base — used by the compose
# healthcheck against /health. No extra apk install needed.

EXPOSE 3100
CMD ["node", "dist/index.js"]
