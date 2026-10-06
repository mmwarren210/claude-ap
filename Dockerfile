# CrownIQ server, which also hosts the web version of the app.

# Stage 1: export the web app (static files). Leave EXPO_PUBLIC_API_URL empty so the web app calls the server it came from.
FROM node:22-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/
COPY packages/engine/package.json packages/engine/
COPY packages/edge/package.json packages/edge/
COPY apps/mobile/package.json apps/mobile/
RUN npm ci --no-audit --no-fund
COPY packages packages
COPY apps/mobile apps/mobile
ARG EXPO_PUBLIC_API_URL=
# The commit Railway builds, so the app can tell when it is an old copy.
ARG RAILWAY_GIT_COMMIT_SHA=
ENV EXPO_PUBLIC_COMMIT=$RAILWAY_GIT_COMMIT_SHA
RUN cd apps/mobile && npx expo export -p web --output-dir dist

# Stage 2: the server. Installs only the server's workspaces.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/
COPY packages/engine/package.json packages/engine/
COPY packages/edge/package.json packages/edge/
COPY apps/mobile/package.json apps/mobile/
RUN npm ci -w @crowniq/api -w @crowniq/contracts -w @crowniq/engine -w @crowniq/edge --include-workspace-root --no-audit --no-fund
COPY packages packages
COPY apps/api apps/api
COPY --from=web /app/apps/mobile/dist apps/mobile/dist
# Data files live on the host's permanent disk, mounted at /data.
ENV NODE_ENV=production API_HOST=0.0.0.0 CROWNIQ_DATA_DIR=/data
# The service has 8 GB; Node's default 2 GB heap was too small once Edge prices five platforms.
ENV NODE_OPTIONS=--max-old-space-size=6144
EXPOSE 3000
CMD ["npm", "run", "start", "-w", "@crowniq/api"]
