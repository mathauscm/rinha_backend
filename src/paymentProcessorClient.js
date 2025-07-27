const http = require('http');

const DEFAULT_PROCESSOR = 'payment-processor-default:8080';
const FALLBACK_PROCESSOR = 'payment-processor-fallback:8080';

async function processPayment(correlationId, amount) {
  // Health check and fallback logic (simplified)

  const useDefault = await isServiceHealthy(DEFAULT_PROCESSOR);
  const processor = useDefault ? DEFAULT_PROCESSOR : FALLBACK_PROCESSOR;

  return postPayment(processor, correlationId, amount);
}

async function isServiceHealthy(host) {
  try {
    const res = await httpGet(`http://${host}/payments/service-health`);
    if (res.failing) return false;
    return true;
  } catch {
    return false;
  }
}

async function postPayment(host, correlationId, amount) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      correlationId,
      amount,
      requestedAt: new Date().toISOString(),
    });

    const options = {
      hostname: host.split(':')[0],
      port: host.split(':')[1],
      path: '/payments',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
      },
    };

    const req = http.request(options, (res) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        resolve();
      } else {
        reject(new Error(`Payment failed with status ${res.statusCode}`));
      }
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          reject(new Error('Invalid JSON response'));
        }
      });
    }).on('error', reject);
  });
}

module.exports = { processPayment };
