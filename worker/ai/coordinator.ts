import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../types';
import { executeGeneration } from './executor';
import type { GenerationRequest, GenerationResult } from './types';

export class AIRequestCoordinator extends DurableObject<Env> {
  private current?: { promise: Promise<GenerationResult>; controller: AbortController; waiters: Set<string> };

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return new Response('method not allowed', { status: 405 });
    let input: GenerationRequest;
    try {
      input = await request.json<GenerationRequest>();
    } catch (cause) {
      console.error(JSON.stringify({ event: 'ai_coordinator_invalid_request', error: cause instanceof Error ? cause.name : 'unknown' }));
      return Response.json({ error: 'AI_COORDINATOR_INVALID_REQUEST', code: 'AI_COORDINATOR_INVALID_REQUEST' }, { status: 400 });
    }
    const waiterId = crypto.randomUUID();
    if (!this.current) {
      const controller = new AbortController();
      const waiters = new Set([waiterId]);
      const promise = executeGeneration(this.env, input, controller.signal).finally(() => { this.current = undefined; });
      this.current = { promise, controller, waiters };
      this.ctx.waitUntil(promise.then(() => undefined, () => undefined));
    } else {
      this.current.waiters.add(waiterId);
    }
    const active = this.current;
    const unregister = () => {
      active.waiters.delete(waiterId);
      if (!active.waiters.size) active.controller.abort('all_waiters_cancelled');
    };
    request.signal.addEventListener('abort', unregister, { once: true });
    try { return Response.json(await active.promise); }
    catch (cause) {
      const value = cause as { code?: string; status?: number; message?: string; retryAfter?: number };
      const code = value.code || 'AI_PROVIDER_UNAVAILABLE';
      const status = value.status || 503;
      console.error(JSON.stringify({ event: 'ai_coordinator_generation_failed', requestId: input.deliveryRequestId, code, status, retryAfter: value.retryAfter || undefined }));
      return Response.json({ error: code, code, retryAfter: value.retryAfter }, { status });
    } finally {
      request.signal.removeEventListener('abort', unregister);
      unregister();
    }
  }
}
