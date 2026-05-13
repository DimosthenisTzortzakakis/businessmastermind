const https = require('https');

const JSONBIN_HOST = 'api.jsonbin.io';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

function httpRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: JSONBIN_HOST,
      port: 443,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Bin-Name': 'BizMastermind',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error('upstream ' + res.statusCode + ': ' + data));
        } else {
          try { resolve(JSON.parse(data)); }
          catch { resolve(data); }
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }

  try {
    const { action, id, data } = JSON.parse(event.body || '{}');

    if (action === 'create') {
      const j = await httpRequest('POST', '/v3/b', data);
      const binId = j.metadata && j.metadata.id;
      if (!binId) throw new Error('No ID in response: ' + JSON.stringify(j));
      return { statusCode: 200, headers: cors, body: JSON.stringify({ id: binId }) };
    }

    if (action === 'push') {
      await httpRequest('PUT', `/v3/b/${id}`, data);
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
    }

    if (action === 'pull') {
      const j = await httpRequest('GET', `/v3/b/${id}/latest`);
      return { statusCode: 200, headers: cors, body: JSON.stringify(j.record || j) };
    }

    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'unknown action' }) };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};
