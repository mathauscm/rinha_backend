const { readQueryParams, sendResponse, HttpStatus, centsToFloat } = require('../shared');

function paymentsSummaryController(state) {
  return async (req, res) => {
    try {
      const { from = null, to = null } = readQueryParams(req);
      
      const result = await paymentSummaryService(state, from, to);
      
      sendResponse(res, HttpStatus.OK, result);
    } catch (error) {
      // Sempre resposta de sucesso com fallback
      sendResponse(res, HttpStatus.OK, {
        default: { totalRequests: 0, totalAmount: 0 },
        fallback: { totalRequests: 0, totalAmount: 0 }
      });
    }
  };
}

async function paymentSummaryService(state, from, to) {
  const fromTimestamp = convertToTimeStamp(from);
  const toTimestamp = convertToTimeStamp(to);
  
  const defaultSummary = await state.default.getSummary(fromTimestamp, toTimestamp);
  const fallbackSummary = await state.fallback.getSummary(fromTimestamp, toTimestamp);
  
  // Add queue monitoring info
  const queueSize = global.paymentService ? global.paymentService.getQueueSize() : 0;
  const isHealthy = global.paymentService ? global.paymentService.isSystemHealthy() : false;
  const processedCount = global.paymentService ? global.paymentService.getProcessedCount() : 0;
  
  return {
    default: defaultSummary,
    fallback: fallbackSummary,
    system: {
      queueSize,
      isHealthy,
      processedCount,
      timestamp: Date.now()
    }
  };
}

function convertToTimeStamp(date) {
  if (!date) return null;
  const timestamp = new Date(date).getTime();
  return isNaN(timestamp) ? null : timestamp;
}

function processState(data, fromTimestamp, toTimestamp) {
  const summary = {
    totalRequests: 0,
    totalAmount: 0
  };
  
  for (const item of data) {
    if (item.timestamp === null) {
      continue;
    }
    
    const isOutOfRange = 
      (fromTimestamp !== null && item.timestamp < fromTimestamp) ||
      (toTimestamp !== null && item.timestamp > toTimestamp);
    
    if (isOutOfRange) {
      continue;
    }
    
    summary.totalRequests += 1;
    summary.totalAmount += item.amount;
  }
  
  return {
    totalRequests: summary.totalRequests,
    totalAmount: centsToFloat(summary.totalAmount)
  };
}

module.exports = { paymentsSummaryController };