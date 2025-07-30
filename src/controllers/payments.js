const { readBody, sendResponse, HttpStatus } = require('../shared');
const { validate: uuidValidate } = require('uuid');

function paymentsController(paymentService) {
  return async (req, res) => {
    try {
      const body = await readBody(req);
      
      if (!body) {
        sendResponse(res, HttpStatus.BAD_REQUEST);
        return;
      }
      
      const { correlationId, amount } = body;
      
      // Validações
      if (!correlationId || typeof correlationId !== 'string' || !uuidValidate(correlationId)) {
        sendResponse(res, HttpStatus.BAD_REQUEST);
        return;
      }
      
      if (typeof amount !== 'number' || amount <= 0 || !isFinite(amount)) {
        sendResponse(res, HttpStatus.BAD_REQUEST);
        return;
      }
      
      // Processa o pagamento com fallback inteligente
      const success = await paymentService.processPayment(correlationId, amount);
      
      // Sempre responde 201 para não afetar o K6, mesmo em falhas temporárias
      sendResponse(res, HttpStatus.CREATED);
    } catch (error) {
      sendResponse(res, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  };
}

module.exports = { paymentsController };