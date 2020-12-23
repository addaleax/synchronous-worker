import bindings from 'bindings';
import { EventEmitter } from 'events';
import type Module from 'module';
const {
  SynchronousWorkerImpl,
  UV_RUN_DEFAULT,
  UV_RUN_ONCE,
  UV_RUN_NOWAIT
} = bindings('synchronous_worker');
const kHandle = Symbol('kHandle');
const kProcess = Symbol('kProcess');
const kModule = Symbol('kModule');
const kGlobalThis = Symbol('kGlobalThis');
const kHasOwnEventLoop = Symbol('kHasOwnEventLoop');
const kHasOwnMicrotaskQueue = Symbol('kHasOwnMicrotaskQueue');
const kPromiseInspector = Symbol('kPromiseInspector');
const kStoppedPromise = Symbol('kStoppedPromise');

interface Options {
  sharedEventLoop: boolean;
  sharedMicrotaskQueue: boolean;
}

type InspectedPromise<T> = {
  state: 'pending';
  value: null;
} | {
  state: 'fulfilled';
  value: T;
} | {
  state: 'rejected';
  value: Error;
};

class SynchronousWorker extends EventEmitter {
  [kHandle]: any;
  [kProcess]: NodeJS.Process;
  [kGlobalThis]: any;
  [kModule]: typeof Module;
  [kHasOwnEventLoop]: boolean;
  [kHasOwnMicrotaskQueue]: boolean;
  [kPromiseInspector]: <T>(promise: Promise<T>) => InspectedPromise<T>;
  [kStoppedPromise]: Promise<void>;

  constructor(options?: Partial<Options>) {
    super();
    this[kHasOwnEventLoop] = !(options?.sharedEventLoop);
    this[kHasOwnMicrotaskQueue] = !(options?.sharedMicrotaskQueue);

    this[kHandle] = new SynchronousWorkerImpl();
    this[kHandle].onexit = (code) => {
      this.stop();
      this.emit('exit', code);
    };
    try {
      this[kHandle].start(this[kHasOwnEventLoop], this[kHasOwnMicrotaskQueue]);
      this[kHandle].load((process, nativeRequire, globalThis) => {
        const origExit = process.reallyExit;
        process.reallyExit = (...args) => {
          const ret = origExit.call(process, ...args);
          // Make a dummy call to make sure the termination exception is
          // propagated. For some reason, this isn't necessarily the case
          // otherwise.
          process.memoryUsage();
          return ret;
        };
        this[kProcess] = process;
        this[kModule] = nativeRequire('module');
        this[kGlobalThis] = globalThis;
        process.on('uncaughtException', (err) => {
          if (process.listenerCount('uncaughtException') === 1) {
            this.emit('error', err);
            process.exit(1);
          }
        });
      });
    } catch (err) {
      this[kHandle].stop();
      throw err;
    }
  }

  runLoop(mode: 'default' | 'once' | 'nowait'): void {
    if (!this[kHasOwnEventLoop]) {
      throw new Error('Can only use .runLoop() when using a separate event loop');
    }
    let uvMode = UV_RUN_DEFAULT;
    if (mode === 'once') uvMode = UV_RUN_ONCE;
    if (mode === 'nowait') uvMode = UV_RUN_NOWAIT;
    this[kHandle].runLoop(uvMode);
  }

  runLoopUntilPromiseResolved<T>(promise: Promise<T>): T {
    if (!this[kHasOwnEventLoop] || !this[kHasOwnMicrotaskQueue]) {
      throw new Error(
        'Can only use .runLoopUntilPromiseResolved() when using a separate event loop and microtask queue');
    }
    this[kPromiseInspector] ??= this.createRequire(__filename)('vm').runInThisContext(
    `(promise => {
      const obj = { state: 'pending', value: null };
      promise.then((v) => { obj.state = 'fulfilled'; obj.value = v; },
                   (v) => { obj.state = 'rejected';  obj.value = v; });
      return obj;
    })`);
    const inspected = this[kPromiseInspector](promise);
    this[kHandle].runInCallbackScope(() => {}); // Flush the µtask queue
    while (inspected.state === 'pending') {
      this.runLoop('once');
    }
    if (inspected.state === 'rejected') {
      throw inspected.value;
    }
    return inspected.value;
  }

  get loopAlive(): boolean {
    if (!this[kHasOwnEventLoop]) {
      throw new Error('Can only use .loopAlive when using a separate event loop');
    }
    return this[kHandle].isLoopAlive();
  }

  async stop(): Promise<void> {
    return this[kStoppedPromise] ??= new Promise(resolve => {
      this[kHandle].signalStop();
      setImmediate(() => {
        this[kHandle].stop();
        resolve();
      });
    });
  }

  get process(): NodeJS.Process {
    return this[kProcess];
  }

  get globalThis(): any {
    return this[kGlobalThis];
  }

  createRequire(...args: Parameters<typeof Module.createRequire>): NodeJS.Require {
    return this[kModule].createRequire(...args);
  }

  runInCallbackScope(method: () => any): any {
    return this[kHandle].runInCallbackScope(method);
  }
}

export = SynchronousWorker;
