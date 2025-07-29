# Multi-stage build para otimização máxima
FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production --no-audit --no-fund

# Production stage ultra-lean
FROM node:20-alpine

# Otimizações do sistema
RUN apk add --no-cache tini && \
    addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

WORKDIR /app

# Copy apenas o necessário
COPY --from=builder /app/node_modules ./node_modules
COPY package*.json ./
COPY src/ ./src/

# Otimizações Node.js em runtime
ENV NODE_ENV=production
ENV NODE_OPTIONS="--max-old-space-size=100 --gc-interval=100 --optimize-for-size"
ENV UV_THREADPOOL_SIZE=32

USER nodejs

# Use tini para signal handling
ENTRYPOINT ["tini", "--"]
CMD ["npm", "start"]