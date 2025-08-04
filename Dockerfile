# Multi-stage build para otimização máxima
FROM node:20-slim AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production --no-audit --no-fund

# Production stage ultra-lean
FROM node:20-slim

# Otimizações do sistema
RUN apt-get update && apt-get install -y --no-install-recommends tini && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd -g 1001 nodejs && \
    useradd -r -u 1001 -g nodejs nodejs

WORKDIR /app

# Copy apenas o necessário
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY src/ ./src/

# Otimizações Node.js em runtime
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=100 --max-semi-space-size=1"
ENV UV_THREADPOOL_SIZE=32

USER nodejs

# Use tini para signal handling
ENTRYPOINT ["tini", "--"]
CMD ["node", "src/main.js"]