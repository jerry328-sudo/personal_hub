const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const files = new Map([
  ['/', ['index.html','text/html; charset=utf-8']],
  ['/index.html', ['index.html','text/html; charset=utf-8']],
  ['/style.css', ['style.css','text/css; charset=utf-8']],
  ['/data.js', ['data.js','text/javascript; charset=utf-8']],
  ['/app.js', ['app.js','text/javascript; charset=utf-8']]
]);
http.createServer((req,res) => {
  const url = new URL(req.url,'http://127.0.0.1');
  if(url.pathname === '/favicon.ico'){res.writeHead(204);res.end();return;}
  const file = files.get(url.pathname);
  if(!file){res.writeHead(404);res.end('Not found');return;}
  res.writeHead(200,{'Content-Type':file[1],'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  fs.createReadStream(path.join(__dirname,file[0])).pipe(res);
}).listen(4174,'127.0.0.1',() => console.log('Personal Hub panel preview: http://127.0.0.1:4174'));
