/**
 * 兼容 pi-agent-core 的 AssistantMessageEventStream。
 * 不依赖 @earendil-works/pi-ai：bot 只做 Gateway 的薄客户端。
 */
export class EventStream<T, R = T> implements AsyncIterable<T> {
  private queue: T[] = []
  private waiting: ((v: IteratorResult<T>) => void)[] = []
  private done = false
  private resolveFinalResult!: (r: R) => void
  private finalResultPromise: Promise<R>
  constructor(
    private isComplete: (event: T) => boolean,
    private extractResult: (event: T) => R,
  ) {
    this.finalResultPromise = new Promise((resolve) => {
      this.resolveFinalResult = resolve
    })
  }
  push(event: T) {
    if (this.done) return
    if (this.isComplete(event)) {
      this.done = true
      this.resolveFinalResult(this.extractResult(event))
    }
    const waiter = this.waiting.shift()
    if (waiter) waiter({ value: event, done: false })
    else this.queue.push(event)
  }
  end(result?: R) {
    this.done = true
    if (result !== undefined) this.resolveFinalResult(result)
    while (this.waiting.length) {
      this.waiting.shift()!({ value: undefined as T, done: true })
    }
  }
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.queue.length) yield this.queue.shift()!
      else if (this.done) return
      else {
        const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve))
        if (result.done) return
        yield result.value
      }
    }
  }
  result() {
    return this.finalResultPromise
  }
}

export class AssistantMessageEventStream extends EventStream<any, any> {
  constructor() {
    super(
      (event) => event.type === 'done' || event.type === 'error',
      (event) => (event.type === 'done' ? event.message : event.error),
    )
  }
}

export const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

export function stubModel(provider: string, id: string) {
  const api =
    provider === 'anthropic' ? 'anthropic-messages' : provider === 'openai' ? 'openai-completions' : 'openai-completions'
  return {
    id,
    name: id,
    provider,
    api,
    baseUrl: '',
    reasoning: false,
    input: ['text'],
    contextWindow: 128000,
    maxTokens: 8192,
    cost: { input: 0, output: 0 },
  }
}

export function emptyAssistant(model: { id: string; provider: string; api?: string }, errorMessage?: string) {
  return {
    role: 'assistant' as const,
    content: [] as any[],
    api: model.api ?? 'openai-completions',
    provider: model.provider,
    model: model.id,
    usage: { ...EMPTY_USAGE, cost: { ...EMPTY_USAGE.cost } },
    stopReason: errorMessage ? ('error' as const) : ('stop' as const),
    errorMessage,
    timestamp: Date.now(),
  }
}
