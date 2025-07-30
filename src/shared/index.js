const { parse } = require('url');

const HttpStatus = {
  OK: 200,
  CREATED: 201,
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  INTERNAL_SERVER_ERROR: 500
};

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve(null);
      }
    });
  });
}

function sendResponse(res, statusCode, data = null) {
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  
  if (data) {
    res.end(JSON.stringify(data));
  } else if (statusCode === HttpStatus.OK || statusCode === HttpStatus.CREATED) {
    res.end('{"message":"Success"}');
  } else {
    res.end('{"error":"Error"}');
  }
}

function readQueryParams(req) {
  if (!req.url) return {};
  const { query } = parse(req.url, true);
  return query;
}

function floatToCents(value) {
  return Math.round(value * 100);
}

function centsToFloat(value) {
  return Math.round(value / 100 * 100) / 100;
}

module.exports = {
  HttpStatus,
  readBody,
  sendResponse,
  readQueryParams,
  floatToCents,
  centsToFloat
};