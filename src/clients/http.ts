import { ServiceError } from '../errors';

export type Fetcher = typeof fetch;

/** One invocation must fit the Workers free-plan subrequest budget and lease. */
export class RequestBudget {
  private used = 0;
  private readonly deadline: number;
  constructor(private readonly limit = 40, durationMs = 45_000) {
    this.deadline = Date.now() + durationMs;
  }
  get available(): number { return Date.now() < this.deadline ? this.limit - this.used : 0; }
  take(): void {
    if (this.available <= 0) throw new ServiceError('budget_exhausted');
    this.used++;
  }
}

export function boundedFetch(budget: RequestBudget, upstream: Fetcher = fetch): Fetcher {
  return async (input, init) => {
    budget.take();
    const signal = init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(5000)])
      : AbortSignal.timeout(5000);
    // Never forward auth headers to a redirect destination.
    return upstream(input, { ...init, signal, redirect: 'error' });
  };
}
