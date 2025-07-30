const { readQueryParams, sendResponse, HttpStatus, centsToFloat } = require('../shared');

function paymentsSummaryController(state) {
  return async (req, res) => {
    try {
      const { from = null, to = null } = readQueryParams(req);
      
      const result = await paymentSummaryService(state, from, to);
      
      sendResponse(res, HttpStatus.OK, result);
    } catch (error) {
      sendResponse(res, HttpStatus.INTERNAL_SERVER_ERROR);
    }
  };
}

async function paymentSummaryService(state, from, to) {
  const fromTimestamp = convertToTimeStamp(from);
  const toTimestamp = convertToTimeStamp(to);
  
  const defaultSummary = await state.default.getSummary(fromTimestamp, toTimestamp);
  const fallbackSummary = await state.fallback.getSummary(fromTimestamp, toTimestamp);
  
  return {
    default: defaultSummary,
    fallback: fallbackSummary
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