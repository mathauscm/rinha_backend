const http = require('http');

const DEFAULT_PROCESSOR = 'payment-processor-default';
const FALLBACK_PROCESSOR = 'payment-processor-fallback';

// Cache do último health check (para respeitar limite de 1 call/5s)
let lastHealthCheck = { default: null, fallback: null };
let lastHealthCheckTime = { default: 0, fallback: 0 };

async function processPayment(correlationId, amount) {
  // Verifica health dos serviços (respeitando rate limit)
  const useDefault = await isServiceHealthy(DEFAULT_PROCESSOR);
  const processor = useDefault ? DEFAULT_PROCESSOR : FALLBACK_PROCESSOR;

  return postPayment(processor, correlationId, amount);
}

async function isServiceHealthy(hostname) {
  const now = Date.now();
  const key = hostname === DEFAULT_PROCESSOR ? 'default' : 'fallback';
  
  // Respeita rate limit de 5 segundos
  if (now - lastHealthCheckTime[key] < 5000) {
    // Usa resultado do cache se disponível, senão assume healthy
    return lastHealthCheck[key] !== null ? !lastHealthCheck[key].failing : true;
  }

  try {
    const result = await httpGet(hostname, 8080, '/payments/service-health');
    lastHealthCheck[key] = result;
    lastHealthCheckTime[key] = now;
    return !result.failing;
  } catch (error) {
    // Em caso de erro no health check, assume unhealthy
    lastHealthCheck[key] = { failing: true };
    lastHealthCheckTime[key] = now;
    return false;
  }
}

async function postPayment(hostname, correlationId, amount) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      correlationId,
      amount,
      requestedAt: new Date().toISOString(),
    });

    const options = {
      hostname,
      port: 8080,
      path: '/payments',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
      timeout: 3000,
    };

    const req = http.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(responseData);
        } else {
          reject(new Error(`Payment failed with status ${res.statusCode}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    
    req.write(data);
    req.end();
  });
}

function httpGet(hostname, port, path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname,
      port,
      path,
      method: 'GET',
      timeout: 2000,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('Invalid JSON response'));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    
    req.end();
  });
}

module.exports = { processPayment };