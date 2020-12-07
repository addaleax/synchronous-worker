#include "node.h"
#include "uv.h"

using namespace node;
using namespace v8;

namespace synchronous_worker {

template <typename T> inline void USE(T&&) {}

class Worker {
 public:
  Worker(Isolate* isolate, Local<Object> wrap);
  ~Worker();

  static void New(const FunctionCallbackInfo<Value>& args);
  static void Start(const FunctionCallbackInfo<Value>& args);
  static void Load(const FunctionCallbackInfo<Value>& args);
  static void RunLoop(const FunctionCallbackInfo<Value>& args);
  static void IsLoopAlive(const FunctionCallbackInfo<Value>& args);
  static void SignalStop(const FunctionCallbackInfo<Value>& args);
  static void Stop(const FunctionCallbackInfo<Value>& args);

 private:
  static Worker* Unwrap(const FunctionCallbackInfo<Value>& arg);
  static void CleanupHook(void* arg);
  void OnExit(int code);

  void Start(bool own_loop, bool own_microtaskqueue);
  MaybeLocal<Value> Load(Local<Function> callback);
  void RunLoop(uv_run_mode mode);
  bool IsLoopAlive();
  void SignalStop();
  void Stop(bool may_throw);

  Isolate* isolate_;
  Global<Object> wrap_;

  uv_loop_t loop_;
  std::unique_ptr<v8::MicrotaskQueue> microtask_queue_;
  Global<Context> outer_context_;
  Global<Context> context_;
  IsolateData* isolate_data_ = nullptr;
  Environment* env_ = nullptr;
};

Worker::Worker(Isolate* isolate, Local<Object> wrap)
  : isolate_(isolate), wrap_(isolate, wrap) {
  AddEnvironmentCleanupHook(isolate, CleanupHook, this);
  loop_.data = nullptr;
  wrap->SetAlignedPointerInInternalField(0, this);

  Local<Context> outer_context = isolate_->GetCurrentContext();
  outer_context_.Reset(isolate_, outer_context);
}

Worker* Worker::Unwrap(const FunctionCallbackInfo<Value>& args) {
  Local<Value> value = args.This();
  if (!value->IsObject() || value.As<Object>()->InternalFieldCount() < 1) {
    Isolate* isolate = args.GetIsolate();
    isolate->ThrowException(
        Exception::Error(
            String::NewFromUtf8Literal(isolate, "Invalid this value")));
    return nullptr;
  }
  return static_cast<Worker*>(
      value.As<Object>()->GetAlignedPointerFromInternalField(0));
}

void Worker::New(const FunctionCallbackInfo<Value>& args) {
  new Worker(args.GetIsolate(), args.This());
}

void Worker::Start(const FunctionCallbackInfo<Value>& args) {
  Worker* self = Unwrap(args);
  if (self == nullptr) return;
  self->Start(
      args[0]->BooleanValue(args.GetIsolate()),
      args[1]->BooleanValue(args.GetIsolate()));
}

void Worker::Stop(const FunctionCallbackInfo<Value>& args) {
  Worker* self = Unwrap(args);
  if (self == nullptr) return;
  self->Stop(true);
}

void Worker::SignalStop(const FunctionCallbackInfo<Value>& args) {
  Worker* self = Unwrap(args);
  if (self == nullptr) return;
  self->SignalStop();
}

void Worker::Load(const FunctionCallbackInfo<Value>& args) {
  Worker* self = Unwrap(args);
  if (self == nullptr) return;
  if (!args[0]->IsFunction()) {
    self->isolate_->ThrowException(
        Exception::TypeError(
            String::NewFromUtf8Literal(self->isolate_,
                "The load() argument must be a function")));
    return;
  }
  Local<Value> result;
  if (self->Load(args[0].As<Function>()).ToLocal(&result)) {
    args.GetReturnValue().Set(result);
  }
}

void Worker::RunLoop(const FunctionCallbackInfo<Value>& args) {
  Worker* self = Unwrap(args);
  if (self == nullptr) return;
  int64_t mode;
  if (!args[0]->IntegerValue(args.GetIsolate()->GetCurrentContext()).To(&mode))
    return;
  self->RunLoop(static_cast<uv_run_mode>(mode));
}

void Worker::IsLoopAlive(const FunctionCallbackInfo<Value>& args) {
  Worker* self = Unwrap(args);
  if (self == nullptr) return;
  args.GetReturnValue().Set(self->IsLoopAlive());
}

void Worker::Start(bool own_loop, bool own_microtaskqueue) {
  Environment* outer_env = GetCurrentEnvironment(outer_context_.Get(isolate_));
  assert(outer_env != nullptr);
  uv_loop_t* outer_loop = GetCurrentEventLoop(isolate_);
  assert(outer_loop != nullptr);

  if (own_loop) {
    int ret = uv_loop_init(&loop_);
    if (ret != 0) {
      isolate_->ThrowException(UVException(isolate_, ret, "uv_loop_init"));
      return;
    }
    loop_.data = this;
  }

  MicrotaskQueue* microtask_queue =
      own_microtaskqueue ?
      (microtask_queue_ = v8::MicrotaskQueue::New(
          isolate_, v8::MicrotasksPolicy::kExplicit)).get() :
      outer_context_.Get(isolate_)->GetMicrotaskQueue();

  Local<Context> context = Context::New(
      isolate_,
      nullptr /* extensions */,
      MaybeLocal<ObjectTemplate>() /* global_template */,
      MaybeLocal<Value>() /* global_value */,
      DeserializeInternalFieldsCallback() /* internal_fields_deserializer */,
      microtask_queue);
  if (context.IsEmpty() || !InitializeContext(context)) {
    return;
  }

  context_.Reset(isolate_, context);
  Context::Scope context_scope(context);
  assert(isolate_data_ != nullptr);
  ThreadId thread_id = AllocateEnvironmentThreadId();
  auto inspector_parent_handle = GetInspectorParentHandle(
      outer_env, thread_id, "file:///synchronous-worker.js");
  env_ = CreateEnvironment(
      GetEnvironmentIsolateData(outer_env),
      context,
      {},
      {},
      static_cast<EnvironmentFlags::Flags>(
          EnvironmentFlags::kTrackUnmanagedFds |
          EnvironmentFlags::kNoRegisterESMLoader),
      thread_id,
      std::move(inspector_parent_handle));
  assert(env_ != nullptr);
  SetProcessExitHandler(env_, [this](Environment* env, int code) {
    OnExit(code);
  });
}

void Worker::OnExit(int code) {
  HandleScope handle_scope(isolate_);
  Local<Context> outer_context = outer_context_.Get(isolate_);
  Context::Scope context_scope(outer_context);
  Local<Object> self = wrap_.Get(isolate_);
  Local<Value> onexit_v;
  if (!self->Get(outer_context, String::NewFromUtf8Literal(isolate_, "onexit"))
          .ToLocal(&onexit_v) || !onexit_v->IsFunction()) {
    return;
  }
  Local<Value> args[] = { Integer::New(isolate_, code) };
  USE(onexit_v.As<Function>()->Call(outer_context, self, 1, args));
}

void Worker::SignalStop() {
  if (env_ != nullptr) {
    node::Stop(env_);
    isolate_->CancelTerminateExecution();
  }
}

void Worker::Stop(bool may_throw) {
  if (env_ != nullptr) {
    SignalStop();
    FreeEnvironment(env_);
    env_ = nullptr;
  }
  if (isolate_data_ != nullptr) {
    FreeIsolateData(isolate_data_);
    isolate_data_ = nullptr;
  }
  context_.Reset();
  outer_context_.Reset();
  if (loop_.data != nullptr) {
    loop_.data = nullptr;
    int ret = uv_loop_close(&loop_);
    if (ret != 0 && may_throw) {
      isolate_->ThrowException(UVException(isolate_, ret, "uv_loop_close"));
    }
  }
  microtask_queue_.reset();
}

MaybeLocal<Value> Worker::Load(Local<Function> callback) {
  if (env_ == nullptr) {
    isolate_->ThrowException(
        Exception::Error(
            String::NewFromUtf8Literal(isolate_, "Worker not initialized")));
    return MaybeLocal<Value>();
  }

  Local<Context> context = context_.Get(isolate_);
  Context::Scope context_scope(context);
  return LoadEnvironment(env_, [&](const StartExecutionCallbackInfo& info) {
    Local<Value> argv[] = {
      info.process_object,
      info.native_require,
      context->Global()
    };
    return callback->Call(context, Null(isolate_), 3, argv);
  });
};

Worker::~Worker() {
  Stop(false);

  RemoveEnvironmentCleanupHook(isolate_, CleanupHook, this);
  if (!wrap_.IsEmpty()) {
    HandleScope handle_scope(isolate_);
    wrap_.Get(isolate_)->SetAlignedPointerInInternalField(0, nullptr);
  }
  wrap_.Reset();
}

void Worker::CleanupHook(void* arg) {
  delete static_cast<Worker*>(arg);
}

void Worker::RunLoop(uv_run_mode mode) {
  if (loop_.data == nullptr) return;
  HandleScope handle_scope(isolate_);
  Context::Scope context_scope(context_.Get(isolate_));
  SealHandleScope seal_handle_scope(isolate_);
  uv_run(&loop_, mode);
}

bool Worker::IsLoopAlive() {
  if (loop_.data == nullptr) return false;
  return uv_loop_alive(&loop_);
}

NODE_MODULE_INIT() {
  Isolate* isolate = context->GetIsolate();
  Local<FunctionTemplate> templ = FunctionTemplate::New(isolate, Worker::New);
  templ->SetClassName(String::NewFromUtf8Literal(isolate, "SynchronousWorker"));
  templ->InstanceTemplate()->SetInternalFieldCount(1);
  Local<ObjectTemplate> proto = templ->PrototypeTemplate();

  Local<Signature> s = Signature::New(isolate, templ);
  proto->Set(String::NewFromUtf8Literal(isolate, "start"),
             FunctionTemplate::New(isolate, Worker::Start, {}, s));
  proto->Set(String::NewFromUtf8Literal(isolate, "load"),
             FunctionTemplate::New(isolate, Worker::Load, {}, s));
  proto->Set(String::NewFromUtf8Literal(isolate, "stop"),
             FunctionTemplate::New(isolate, Worker::Stop, {}, s));
  proto->Set(String::NewFromUtf8Literal(isolate, "signalStop"),
             FunctionTemplate::New(isolate, Worker::SignalStop, {}, s));
  proto->Set(String::NewFromUtf8Literal(isolate, "runLoop"),
             FunctionTemplate::New(isolate, Worker::RunLoop, {}, s));
  proto->Set(String::NewFromUtf8Literal(isolate, "isLoopAlive"),
             FunctionTemplate::New(isolate, Worker::IsLoopAlive, {}, s));

  Local<Function> worker_fn;
  if (!templ->GetFunction(context).ToLocal(&worker_fn))
    return;
  USE(exports->Set(context,
                   String::NewFromUtf8Literal(isolate, "SynchronousWorkerImpl"),
                   worker_fn));

  NODE_DEFINE_CONSTANT(exports, UV_RUN_DEFAULT);
  NODE_DEFINE_CONSTANT(exports, UV_RUN_ONCE);
  NODE_DEFINE_CONSTANT(exports, UV_RUN_NOWAIT);
}

}
