const Redis = require('ioredis');
const redis = new Redis({
  host: 'redis',
  port: 6379,
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
});

redis.on('error', err => {
  console.error('Redis Client Error:', err);
});

module.exports = redis;
