# CrownIQ API server. Installs only the server's workspaces (not the mobile app).
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/
COPY packages/engine/package.json packages/engine/
COPY apps/mobile/package.json apps/mobile/
RUN npm ci -w @crowniq/api -w @crowniq/contracts -w @crowniq/engine --include-workspace-root --no-audit --no-fund
COPY packages packages
COPY apps/api apps/api
# Data files live on the host's permanent disk, mounted at /data.
ENV NODE_ENV=production API_HOST=0.0.0.0 CROWNIQ_DATA_DIR=/data
EXPOSE 3000
CMD ["npm", "run", "start", "-w", "@crowniq/api"]
