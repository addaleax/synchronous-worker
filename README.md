# synchronous-worker – Run Node.js APIs synchronously

## Usage Example

```js
const w = new SynchronousWorker();
const fetch = w.createRequire(__filename)('node-fetch');
const response = w.runLoopUntilPromiseResolved(fetch('http://example.org'));
const text = w.runLoopUntilPromiseResolved(response.text());
console.log(text);
```

## API

### `new SynchronousWorker([options])`

Create a new Node.js instance on the same thread. Valid options are:

- `sharedEventLoop`: Use the same event loop as the outer Node.js instance.
  If this is passed, the `.runLoop()` and `.runLoopUntilPromiseResolved()`
  methods become unavailable. Defaults to `false`.
- `sharedMicrotaskQueue`: Use the same microtask queue as the outer Node.js
  instance. This is used for resolving promises created in the inner context,
  including those implicitly generated by `async/await`. If this is passed,
  the `.runLoopUntilPromiseResolved()` method becomes unavailable.
  Defaults to `false`.

While this package will accept
`{ sharedEventLoop: false, sharedMicrotaskQueue: true }` as options, passing
them does not typically make sense.

### `synchronousWorker.runLoop([mode])`

Spin the event loop of the inner Node.js instance. `mode` can be either
`default`, `once` or `nowait`. See the [libuv documentation for `uv_run()`]
for details on these modes.

### `synchronousWorker.runLoopUntilPromiseResolved(promise)`

Spin the event loop of the innsert Node.js instance until a specific `Promise`
is resolved.

### `synchronousWorker.runInWorkerScope(fn)`

Wrap `fn` and run it as if it were run on the event loop of the inner Node.js
instance. In particular, this ensures that Promises created by the function
itself are resolved correctly. You should generally use this to run any code
inside the innert Node.js instance that performs asynchronous activity and that
is not already running in an asynchronous context (you can compare this to
the code that runs synchronously from the main file of a Node.js application).

### `synchronousWorker.loopAlive`

This is a read-only boolean property indicating whether there are currently any
items on the event loop of the inner Node.js instance.

### `synchronousWorker.stop()`

Interrupt any execution of code inside the inner Node.js instance, i.e.
return directly from a `.runLoop()`, `.runLoopUntilPromiseResolved()` or
`.runInWorkerScope()` call. This will render the Node.js instance unusable
and is generally comparable to running `process.exit()`.

This method returns a `Promise` that will be resolved when all resources
associated with this Node.js instance are released. This `Promise` resolves on
the event loop of the *outer* Node.js instance.

### `synchronousWorker.createRequire(filename)`

Create a `require()` function that can be used for loading code inside the
inner Node.js instance. See [`module.createRequire()`][] for details.

### `synchronousWorker.globalThis`

Returns a reference to the global object of the inner Node.js instance.

### `synchronousWorker.process`

Returns a reference to the `process` object of the inner Node.js instance.

# FAQ

## What does this module do?

Create a new Node.js instance, using the same thread and the same JS heap.
You can create Node.js API objects, like network sockets, inside the new
Node.js instance, and spin the underlying event loop manually.

## Why would I use this package?

The most common use case is probably running asynchronous code synchronously,
in situations where doing so cannot be avoided (even though one should try
really hard to avoid it). Another popular npm package that does this is
[`deasync`][], but `deasync`

- solves this problem by starting the event loop while it is already running
  (which is explicitly *not* supported by libuv and may lead to crashes)
- doesn’t allow specifying *which* resources or callbacks should be waited for,
  and instead allows everything inside the current thread to progress.

## How can I avoid using this package?

If you do not need to directly interact with the objects inside the inner
Node.js instance, a lot of the time [`Worker threads`][] together with
[`Atomics.wait()`][] will give you what you need. For example, the
`node-fetch` snippet from above could also be written as:

```js
const {
  Worker, MessageChannel, receiveMessageOnPort
} = require('worker_threads');

const { port1, port2 } = new MessageChannel();
const notifyHandle = new Int32Array(new SharedArrayBuffer(4));

const w = new Worker(`
const {
  parentPort, workerData: { notifyHandle, port2 }
} = require('worker_threads');

(async () => {
  const fetch = require('node-fetch');
  const response = await fetch('http://example.org');
  const text = await response.text();
  port2.postMessage({ text });
  Atomics.store(notifyHandle, 0, 1);
  Atomics.notify(notifyHandle, 0);
})();`, {
  eval: true, workerData: { notifyHandle, port2 }, transferList: [ port2 ]
});

Atomics.wait(notifyHandle, 0, 0);
const { text } = receiveMessageOnPort(port1).message;
console.log(text);
```

That’s arguably a bit more complicated, but doesn’t require any native code
and only uses APIs that are also available on lower Node.js versions.

## Which Node.js versions are supported?

In order to work, synchronous-worker needs a recent Node.js version, because
older versions are missing a few bugfixes or features. The following PRs are
relevant for this (all of them are included in Node.js 15.5.0):

- [#36581](https://github.com/nodejs/node/pull/36581)
- [#36482](https://github.com/nodejs/node/pull/36482)
- [#36441](https://github.com/nodejs/node/pull/36441)
- [#36414](https://github.com/nodejs/node/pull/36414)
- [#36413](https://github.com/nodejs/node/pull/36413)

## My async functions/Promises/… don’t work

If you run a `SynchronousWorker` with its own microtask queue (i.e. in default
mode), code like this will not work as expected:

```js
const w = new SynchronousWorker();
let promise;
w.runInWorkerScope(() => {
  promise = (async() => {
    return await w.createRequire(__filename)('node-fetch')(...);
  })();
});
w.runLoopUntilPromiseResolved(promise);
```

The reason for this is that `async` functions (and Promise `.then()` handlers)
add their microtasks to the microtask queue for the Context in which the
async function (or `.then()` callback) was defined, and not the Context in which
the original `Promise` was created. Put in other words, it is possible for a
`Promise` chain to be run on different microtask queues.

While I find this behavior counterintuitive, it is what the V8 engine does,
and is not under the control of Node.js or this package.

What this means is that you will need to make sure that the functions are
compiled in the Context in which they are supposed to be run; the two main
ways to achieve that are to:

- Put them in a separate file that is loaded through `w.createRequire()`
- Use `w.createRequire(__filename)('vm').runInThisContext()` to manually compile
  the code for the function in the Context of the target Node.js instance.

For example:

```js
const w = new SynchronousWorker();
const req = w.createRequire(__filename);
let promise;
w.runInWorkerScope(() => {
  promise = req('vm').runInThisContext(`(async(req) => {
    return await req('node-fetch')(...);
  })`)(req));
});
w.runLoopUntilPromiseResolved(promise);
```

## I found a bug/crash while using this package. What do I do now?

You can [file a bug report][] on Github. Please include a reproduction, the
version of this package that you’re using, and the Node.js version that you’re
using, and ideally also make sure that it’s a first-time report.

[`deasync`]: https://www.npmjs.com/package/deasync
[`Worker threads`]: https://nodejs.org/api/worker_threads.html
[`Atomics.wait()`]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Atomics/wait
[libuv documentation for `uv_run()`]: http://docs.libuv.org/en/v1.x/loop.html#c.uv_run
[`module.createRequire()`]: https://nodejs.org/api/module.html#module_module_createrequire_filename
[file a bug report]: https://github.com/addaleax/synchronous-worker/issues
