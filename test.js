const SynchronousWorker = require('./');
const tick = require('util').promisify(setImmediate);

const w = new SynchronousWorker({ ownEventLoop: true, ownMicrotaskQueue: true });
const req = w.createRequire(__filename);
req('http').createServer((req, res) => {
  console.log(req.url);
  if (req.url === '/stop') {
    w.stop();
  }
  res.writeHead(200);
  res.end('Ok\n');
}).listen(5000);

while (w.loopAlive) {
  w.runLoop('default');
}

console.log('done!');
