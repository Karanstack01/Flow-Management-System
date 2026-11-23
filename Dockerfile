# syntax=docker/dockerfile:1.7
# One Dockerfile, three runtime targets: api, worker, web.
#   docker build --target api    -t fms-api .
#   docker build --target worker -t fms-worker .
#   docker build --target web    -t fms-web .

FROM node:22-alpine AS deps
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY tools/legacy-import/package.json tools/legacy-import/
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
RUN npm run build:core \
 && npm run generate -w @fms/db \
 && npm run build -w @fms/api -w @fms/worker -w @fms/web

# Production node_modules only (prisma CLI stays: it is a runtime dependency for migrate deploy).
FROM build AS prod-deps
RUN npm prune --omit=dev --no-audit --no-fund

FROM node:22-alpine AS node-runtime
RUN apk add --no-cache openssl tini
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/packages/core/package.json /app/packages/core/
COPY --from=build --chown=node:node /app/packages/core/dist /app/packages/core/dist
COPY --from=build --chown=node:node /app/packages/db/package.json /app/packages/db/
COPY --from=build --chown=node:node /app/packages/db/dist /app/packages/db/dist
COPY --from=build --chown=node:node /app/packages/db/prisma /app/packages/db/prisma
# Regenerate the client in the final image so it never depends on prune internals.
RUN npx prisma generate --schema packages/db/prisma/schema.prisma && chown -R node:node node_modules/.prisma node_modules/@prisma
USER node
ENTRYPOINT ["/sbin/tini", "--"]

FROM node-runtime AS api
COPY --from=build --chown=node:node /app/apps/api/package.json /app/apps/api/
COPY --from=build --chown=node:node /app/apps/api/dist /app/apps/api/dist
RUN mkdir -p /app/uploads
ENV API_PORT=4000 UPLOAD_DIR=/app/uploads
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:4000/healthz || exit 1
CMD ["node", "apps/api/dist/server.js"]

FROM node-runtime AS worker
COPY --from=build --chown=node:node /app/apps/worker/package.json /app/apps/worker/
COPY --from=build --chown=node:node /app/apps/worker/dist /app/apps/worker/dist
CMD ["node", "apps/worker/dist/index.js"]

FROM nginx:1.27-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
