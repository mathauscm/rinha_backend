const Redis = require('ioredis');

// Configuração ultra-otimizada para performance máxima
const redis = new Redis({
  host: 'redis',
  port: 6379,
  
  // Connection pooling
  family: 4,
  keepAlive: true,
  
  // Performance otimizations
  lazyConnect: true,
  maxRetriesPerRequest: 2,
  retryDelayOnFailover: 50,
  enableReadyCheck: false,
  maxLoadingTimeout: 1000,
  
  // Network otimizations
  connectTimeout: 1000,
  commandTimeout: 500,
  
  // Disable unnecessary features for speed
  enableOfflineQueue: false,
  enableAutoPipelining: true,
  
  // Connection pool settings
  connectionName: `node-${process.pid}`,
  
  // Faster serialization
  keyPrefix: '',
  
  // Cluster/failover disabled for single Redis
  enableReadyCheck: false,
  maxRetriesPerRequest: 2,
});

// Minimal error handling para não impactar performance
redis.on('error', err => {
  console.error('Redis Error:', err.message);
});

redis.on('connect', () => {
  console.log('Redis connected');
});

// Pre-warm connection na startup
redis.ping().catch(() => {});

module.exports = redis;
