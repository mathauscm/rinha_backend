const { readBody, sendResponse, HttpStatus } = require('../shared');

function paymentsController(paymentService) {
  return async (req, res) => {
    try {
      // Lê body rapidamente
      const body = await readBody(req);
      
      if (!body) {
        sendResponse(res, HttpStatus.BAD_REQUEST);
        return;
      }
      
      const { correlationId, amount } = body;
      
      // Validação mínima apenas
      if (!correlationId || typeof correlationId !== 'string' || correlationId.length !== 36) {
        sendResponse(res, HttpStatus.BAD_REQUEST);
        return;
      }
      
      if (typeof amount !== 'number' || amount <= 0 || !isFinite(amount)) {
        sendResponse(res, HttpStatus.BAD_REQUEST);
        return;
      }
      
      // Processa imediatamente e responde
      await paymentService.processPayment(correlationId, amount);
      
      // Sempre responde 201 para maximizar throughput
      sendResponse(res, HttpStatus.CREATED);
    } catch (error) {
      sendResponse(res, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  };
}

module.exports = { paymentsController };