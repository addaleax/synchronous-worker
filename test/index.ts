import assert from 'assert';
import SynchronousWorker from '../';

describe('SynchronousWorker allows running Node.js code', () => {
  it('inside its own event loop', () => {
    const w = new SynchronousWorker({ ownEventLoop: true, ownMicrotaskQueue: true });
    w.runInCallbackScope(() => {
      const req = w.createRequire(__filename);
      const fetch = req('node-fetch');
      const httpServer = req('http').createServer((req, res) => {
        if (req.url === '/stop') {
          w.stop();
        }
        res.writeHead(200);
        res.end('Ok\n');
      });
      httpServer.listen(0, req('vm').runInThisContext(`({fetch, httpServer }) => (async () => {
        const res = await fetch('http://localhost:' + httpServer.address().port + '/');
        globalThis.responseText = await res.text();
        await fetch('http://localhost:' + httpServer.address().port + '/stop');
      })`)({ fetch, httpServer }));
    });

    assert.strictEqual(w.loopAlive, true);
    w.runLoop('default');
    assert.strictEqual(w.loopAlive, false);

    assert.strictEqual(w.globalThis.responseText, 'Ok\n');
  });

  it('with its own µtask queue', () => {
    const w = new SynchronousWorker({ ownMicrotaskQueue: true });
    let ran = false;
    w.runInCallbackScope(() => {
      w.globalThis.queueMicrotask(() => ran = true);
    });
    assert.strictEqual(ran, true);
  });

  it('with its own µtask queue but shared event loop', (done) => {
    const w = new SynchronousWorker({ ownMicrotaskQueue: true });
    let ran = false;
    w.runInCallbackScope(() => {
      w.globalThis.setImmediate(() => {
        w.globalThis.queueMicrotask(() => ran = true);
      });
    });
    assert.strictEqual(ran, false);
    setImmediate(() => {
      assert.strictEqual(ran, true);
      done();
    });
  });

  it('with its own loop but shared µtask queue', () => {
    const w = new SynchronousWorker({ ownEventLoop: true });
    let ran = false;
    w.runInCallbackScope(() => {
      w.globalThis.setImmediate(() => {
        w.globalThis.queueMicrotask(() => ran = true);
      });
    });

    assert.strictEqual(ran, false);
    w.runLoop('default');
    assert.strictEqual(ran, true);
  });

  it('with its own loop but shared µtask queue (no callback scope)', (done) => {
    const w = new SynchronousWorker({ ownEventLoop: true });
    let ran = false;
    w.globalThis.queueMicrotask(() => ran = true);
    assert.strictEqual(ran, false);
    queueMicrotask(() => {
      assert.strictEqual(ran, true);
      done();
    });
  });

  it('allows waiting for a specific promise to be resolved', () => {
    const w = new SynchronousWorker({ ownEventLoop: true, ownMicrotaskQueue: true });
    const req = w.createRequire(__filename);
    let srv;
    let serverUpPromise;
    let fetchPromise;
    w.runInCallbackScope(() => {
      srv = req('http').createServer((req, res) => res.end('contents')).listen(0);
      serverUpPromise = req('events').once(srv, 'listening');
    });
    w.runLoopUntilPromiseResolved(serverUpPromise);
    w.runInCallbackScope(() => {
      fetchPromise = req('node-fetch')('http://localhost:' + srv.address().port);
    });
    const fetched = w.runLoopUntilPromiseResolved(fetchPromise) as any;
    assert.strictEqual(fetched.ok, true);
    assert.strictEqual(fetched.status, 200);
  });

  context('process.exit', () => {
    it('interrupts runInCallbackScope', () => {
      const w = new SynchronousWorker({ ownEventLoop: true, ownMicrotaskQueue: true });
      let ranBefore = false;
      let ranAfter = false;
      let observedCode = -1;
      w.on('exit', (code) => observedCode = code);
      w.runInCallbackScope(() => {
        ranBefore = true;
        w.process.exit(1);
        ranAfter = true;
      });
      assert.strictEqual(ranBefore, true);
      assert.strictEqual(ranAfter, false);
      assert.strictEqual(observedCode, 1);
    });

    it('interrupts runLoop', () => {
      const w = new SynchronousWorker({ ownEventLoop: true, ownMicrotaskQueue: true });
      let ranBefore = false;
      let ranAfter = false;
      let observedCode = -1;
      w.on('exit', (code) => observedCode = code);
      w.runInCallbackScope(() => {
        w.globalThis.setImmediate(() => {
          ranBefore = true;
          w.process.exit(1);
          ranAfter = true;
        });
      });
      w.runLoop('default');
      assert.strictEqual(ranBefore, true);
      assert.strictEqual(ranAfter, false);
      assert.strictEqual(observedCode, 1);
    });

    it('does not kill the process outside of any scopes', () => {
      const w = new SynchronousWorker({ ownEventLoop: true, ownMicrotaskQueue: true });
      let observedCode = -1;

      w.on('exit', (code) => observedCode = code);
      w.process.exit(1);

      assert.strictEqual(observedCode, 1);

      assert.throws(() => {
        w.runLoop('default');
      }, /Worker has been stopped/);
    });
  });
});
