# Baalda server — production image.
#
# Build context MUST be the repo root (this Dockerfile reaches into app/ as a
# whole because the server is one workspace of an npm-workspaces monorepo and
# needs the root package.json + lockfile to resolve its deps):
#
#   docker build -f app/apps/server/Dockerfile -t baalda-server .
#
# Run (see docs/DEPLOY.md for the full env var reference):
#
#   docker run -p 3010:3010 \
#     -e DATABASE_URL=postgres://... \
#     -e JWT_SECRET=... \
#     -e BETTER_AUTH_URL=https://your-host \
#     baalda-server

# ---- deps: install full (dev+prod) workspace deps needed to compile -------
FROM node:22-alpine AS deps
WORKDIR /repo
COPY app/package.json app/package-lock.json ./app/
COPY app/apps/server/package.json ./app/apps/server/package.json
COPY app/apps/desktop/package.json ./app/apps/desktop/package.json
RUN cd app && npm ci --workspace=server

# ---- build: compile TypeScript -> dist/ -----------------------------------
FROM deps AS build
WORKDIR /repo
COPY app/apps/server ./app/apps/server
RUN cd app && npm run build --workspace=server

# ---- runtime: production deps only + compiled output ---------------------
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY app/package.json app/package-lock.json ./
COPY app/apps/server/package.json ./apps/server/package.json
COPY app/apps/desktop/package.json ./apps/desktop/package.json
RUN npm ci --workspace=server --omit=dev && npm cache clean --force
COPY --from=build /repo/app/apps/server/dist ./apps/server/dist
COPY app/apps/server/migrations ./apps/server/migrations

WORKDIR /app/apps/server
ENV PORT=3010
EXPOSE 3010

CMD ["node", "dist/index.js"]
