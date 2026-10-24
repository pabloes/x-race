# Production image for the authoritative physics server.
#
# The build context is the repo root rather than `server/`: the server imports the wire
# protocol, the constants and the track straight out of `shared/`, so both directories have
# to be in the context for the bundle to resolve. `captain-definition` sits next to this
# file for the same reason.
#
# Two stages. The first type-checks and bundles our TypeScript into a single ESM file with
# esbuild; the second installs only the runtime dependencies (`ws` and the Rapier wasm
# package) and copies that file in, so no compiler, no sources and no dev dependencies ever
# reach the running container.

FROM node:20-alpine AS build
WORKDIR /app
# Dependencies first: a code-only change then reuses the cached install layer.
COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci
COPY shared ./shared
COPY server/tsconfig.json ./server/
COPY server/src ./server/src
# decor-check.ts is a dev tool that reads the scene's decoration layout, and the scene is
# not part of this build context, so it would fail the typecheck for nothing it ships.
RUN rm server/src/decor-check.ts && cd server && npm run build

FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/server/dist ./dist

# Where the visitor roll survives a redeploy, when `STATS_FILE` points at it and CapRover
# has a persistent directory mounted here. It is created and handed to `node` at build
# time on purpose: the process drops to that user below, and Docker gives a fresh named
# volume the ownership of the directory it covers — without this the mount arrives owned
# by root, every write is refused, and the only sign is a warning in the log.
RUN mkdir -p /data && chown node:node /data

# CapRover maps the public domain onto this port; set it as the app's Container HTTP Port.
ENV PORT=8787
EXPOSE 8787

# Restart the container if the simulation stops answering. The start period covers the
# Rapier wasm init, which takes a moment on a cold boot.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" > /dev/null || exit 1

USER node
CMD ["node", "dist/server.js"]
