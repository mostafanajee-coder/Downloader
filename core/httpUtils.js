'use strict';

const got = require('got');

// Create a custom got instance with tuned agents for performance
const client = got.extend({
  retry: { limit: 0 }, // We handle retries manually in DownloadTask
  timeout: { request: 30000 },
  https: { rejectUnauthorized: false },
});

function request(urlStr, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    try {
      const stream = client.stream(urlStr, { method, headers });
      
      stream.on('response', (response) => {
        // Expose statusCode and headers on the stream object directly to simulate standard 'res'
        stream.statusCode = response.statusCode;
        stream.headers = response.headers;
        resolve({ res: stream, finalUrl: response.requestUrl || urlStr });
      });

      stream.on('error', (err) => {
        reject(err);
      });
    } catch (e) {
      reject(e);
    }
  });
}

module.exports = { request, client };
