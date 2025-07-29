const http = require('http');
const { URL } = require('url');
const paymentsHandler = require('./api/paymentsHandler');
const { parseJSON } = require('./utils');

const PORT = process.env.PORT || 9999;

// Otimizações Node.js para produção
if (process.env.NODE_ENV === 'production') {
  process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '16';
}

const server = http.createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host}`);

    if (urlObj.pathname === '/payments' && req.method === 'POST') {
      const body = await parseJSON(req);
      await paymentsHandler.handlePostPayments(req, res, body);
    } else if (urlObj.pathname === '/payments-summary' && req.method === 'GET') {
      await paymentsHandler.handleGetPaymentsSummary(req, res, urlObj.searchParams);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":"Not Found"}');
    }
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"Internal Server Error"}');
    } else {
      res.end();
    }
  }
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
