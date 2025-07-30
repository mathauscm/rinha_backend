const http = require('http');
const { sendResponse, HttpStatus } = require('../shared');
const { paymentsController } = require('../controllers/payments');
const { paymentsSummaryController } = require('../controllers/paymentsSummary');
const { redis } = require('../state/redisState');

function startServer(port, paymentService, state) {
  const paymentsHandler = paymentsController(paymentService);
  const summaryHandler = paymentsSummaryController(state);
  
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/payments') {
      paymentsHandler(req, res);
    } else if (req.method === 'GET' && req.url?.startsWith('/payments-summary')) {
      summaryHandler(req, res);
    } else if (req.method === 'POST' && req.url === '/purge-payments') {
      // Reset Redis state - usado pelo K6 para limpeza entre testes
      purgeHandler(req, res, state);
    } else {
      sendResponse(res, HttpStatus.NOT_FOUND);
    }
  });
  
  server.listen(port, () => {
    console.log(`Server listening on port ${port}`);
  });
  
  return server;
}

async function purgeHandler(req, res, state) {
  try {
    // Limpar todas as chaves Redis relacionadas ao nosso sistema
    const keys = await redis.keys('*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    
    console.log('Redis purged - all payment data cleared');
    sendResponse(res, HttpStatus.OK, { message: 'Database purged successfully' });
  } catch (error) {
    console.error('Error purging database:', error);
    sendResponse(res, HttpStatus.INTERNAL_SERVER_ERROR);
  }
}

module.exports = { startServer };