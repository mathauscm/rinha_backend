const http = require('http');
const fs = require('fs');
const { sendResponse, HttpStatus } = require('../shared');
const { paymentsController } = require('../controllers/payments');
const { paymentsSummaryController } = require('../controllers/paymentsSummary');

function startServer(port, paymentService, state) {
  const paymentsHandler = paymentsController(paymentService);
  const summaryHandler = paymentsSummaryController(state);
  
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/payments') {
      paymentsHandler(req, res);
    } else if (req.method === 'GET' && req.url?.startsWith('/payments-summary')) {
      summaryHandler(req, res);
    } else if (req.method === 'GET' && req.url === '/health') {
      healthHandler(req, res, paymentService);
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

function healthHandler(req, res, paymentService) {
  try {
    const health = {
      status: 'healthy',
      queueSize: paymentService.getQueueSize(),
      processedCount: paymentService.getProcessedCount(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString()
    };
    
    sendResponse(res, HttpStatus.OK, health);
  } catch (error) {
    sendResponse(res, HttpStatus.INTERNAL_SERVER_ERROR, { status: 'unhealthy', error: error.message });
  }
}

async function purgeHandler(req, res, state) {
  try {
    state.default.clear();
    state.fallback.clear();
    console.log('In-memory storage purged - all payment data cleared');
    sendResponse(res, HttpStatus.OK, { message: 'Database purged successfully' });
  } catch (error) {
    console.error('Error purging database:', error);
    sendResponse(res, HttpStatus.INTERNAL_SERVER_ERROR);
  }
}

module.exports = { startServer };