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
const kHasOwnEventLoop = Symbol('kHasOwnEventLoop');

interface Options {
  newEventLoop: boolean;
}

class SynchronousWorker extends EventEmitter {
  [kHandle]: any;
  [kProcess]: NodeJS.Process;
  [kModule]: typeof Module;
  [kHasOwnEventLoop]: boolean;

  constructor(options?: Partial<Options>) {
    super();
    this[kHasOwnEventLoop] = !!(options?.newEventLoop);

    this[kHandle] = new SynchronousWorkerImpl();
    this[kHandle].onexit = (code) => this.emit('exit', code);
    try {
      this[kHandle].start(this[kHasOwnEventLoop]);
      this[kHandle].load((process, nativeRequire) => {
        this[kProcess] = process;
        this[kModule] = nativeRequire('module');
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

  get loopAlive(): boolean {
    if (!this[kHasOwnEventLoop]) {
      throw new Error('Can only use .loopAlive when using a separate event loop');
    }
    return this[kHandle].isLoopAlive();
  }

  async stop(): Promise<void> {
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

  createRequire(...args: Parameters<typeof Module.createRequire>): NodeJS.Require {
    return this[kModule].createRequire(...args);
  }
}

export = SynchronousWorker;
