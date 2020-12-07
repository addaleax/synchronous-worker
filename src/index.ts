import bindings from 'bindings';
import { EventEmitter } from 'events';
import type Module from 'module';
const {
  SynchronousWorkerImpl,
  UV_RUN_DEFAULT,
  UV_RUN_ONCE,
  UV_RUN_NOWAIT
} = bindings('synchronous_worker.node');
const kHandle = Symbol('kHandle');
const kProcess = Symbol('kProcess');
const kModule = Symbol('kModule');
const kGlobalThis = Symbol('kGlobalThis');
const kHasOwnEventLoop = Symbol('kHasOwnEventLoop');
const kHasOwnMicrotaskQueue = Symbol('kHasOwnMicrotaskQueue');
const kStopped = Symbol('kStopped');

interface Options {
  ownEventLoop: boolean;
  ownMicrotaskQueue: boolean;
}

class SynchronousWorker extends EventEmitter {
  [kHandle]: any;
  [kProcess]: NodeJS.Process;
  [kGlobalThis]: any;
  [kModule]: typeof Module;
  [kHasOwnEventLoop]: boolean;
  [kHasOwnMicrotaskQueue]: boolean;
  [kStopped]: boolean;

  constructor(options?: Partial<Options>) {
    super();
    this[kHasOwnEventLoop] = !!(options?.ownEventLoop);
    this[kHasOwnMicrotaskQueue] = !!(options?.ownMicrotaskQueue);

    this[kHandle] = new SynchronousWorkerImpl();
    this[kHandle].onexit = (code) => this.emit('exit', code);
    this[kStopped] = false;
    try {
      this[kHandle].start(this[kHasOwnEventLoop], this[kHasOwnMicrotaskQueue]);
      this[kHandle].load((process, nativeRequire, globalThis) => {
        this[kProcess] = process;
        this[kModule] = nativeRequire('module');
        this[kGlobalThis] = globalThis;
      });
    } catch (err) {
      this[kStopped] = true;
      this[kHandle].stop();
      throw err;
    }
  }

  runLoop(mode: 'default' | 'once' | 'nowait'): void {
    if (!this[kHasOwnEventLoop]) {
      throw new Error('Can only use .runLoop() when using a separate event loop');
    }
    if (this[kStopped]) {
      throw new Error('Cannot use .runLoop() on a stopped Worker');
    }
    let uvMode = UV_RUN_DEFAULT;
    if (mode === 'once') uvMode = UV_RUN_ONCE;
    if (mode === 'nowait') uvMode = UV_RUN_NOWAIT;
    this[kHandle].runLoop(uvMode);
  }

  get loopAlive(): boolean {
    if (!this[kHasOwnEventLoop]) {
      throw new Error('Can only use .loopAlive when using a separate event loop');
    }
    if (this[kStopped]) {
      return false;
    }
    return this[kHandle].isLoopAlive();
  }

  async stop(): Promise<void> {
    this[kStopped] = true;
    this[kHandle].signalStop();
    return new Promise(resolve => {
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
}

export = SynchronousWorker;
