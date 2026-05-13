// Serverless proxy — runs on Netlify's servers, no CORS issues
const JSONBIN = 'https://api.jsonbin.io/v3/b';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }

  try {
    const { action, id, data } = JSON.parse(event.body || '{}');

    if (action === 'create') {
      const res = await fetch(JSONBIN, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Bin-Name': 'BizMastermind' },
        body: JSON.stringify(data)
      });
      if (!res.ok) throw new Error('upstream ' + res.status);
      const j = await res.json();
      return { statusCode: 200, headers: cors, body: JSON.stringify({ id: j.metadata.id }) };
    }

    if (action === 'push') {
      const res = await fetch(`${JSONBIN}/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (!res.ok) throw new Error('upstream ' + res.status);
      return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
    }

    if (action === 'pull') {
      const res = await fetch(`${JSONBIN}/${id}/latest`);
      if (!res.ok) throw new Error('upstream ' + res.status);
      const j = await res.json();
      return { statusCode: 200, headers: cors, body: JSON.stringify(j.record) };
    }

    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'unknown action' }) };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};
