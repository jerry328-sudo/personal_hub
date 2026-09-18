// Optional preview for the approved standalone prototype. The real app uses `npm run dev`.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
http.createServer((req, res) => {
  const route = req.url.split('?')[0];
  if (route === '/favicon.ico') { res.writeHead(204); return res.end(); }
  if (!['/', '/index.html'].includes(route)) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  fs.createReadStream(path.join(__dirname, 'design', 'prototype.html')).pipe(res);
}).listen(4173, '127.0.0.1', () => console.log('Personal Hub preview: http://127.0.0.1:4173'));
