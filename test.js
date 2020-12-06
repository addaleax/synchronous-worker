const SynchronousWorker = require('./');

const w = new SynchronousWorker();
const req = w.createRequire(__filename);
req('http').createServer((req, res) => {
  console.log(req.url);
  if (req.url === '/stop') {
    w.stop();
  }
  res.writeHead(200);
  res.end('Ok\n');
}).listen(5000);
