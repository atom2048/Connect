import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { InitialLoadProgress, type InitialLoadTaskDefinition } from '../src/initialLoadProgress';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

const plan: InitialLoadTaskDefinition[] = [
  { id: 'auth', task: '認証状態確定', weight: 20 },
  { id: 'feed', task: '初期フィード', weight: 80 },
];

describe('initial load progress', () => {
  it('starts at 0, uses completed weight, and holds the final visible value at 99%', () => {
    const progress = new InitialLoadProgress(plan);
    expect(progress.getSnapshot()).toMatchObject({
      completedUnits: 0,
      totalUnits: 2,
      completedWeight: 0,
      totalWeight: 100,
      rawProgress: 0,
      displayProgress: 0,
      status: 'loading',
    });

    progress.startTask('auth');
    progress.completeTask('auth');
    expect(progress.getSnapshot()).toMatchObject({ rawProgress: 0.2, displayProgress: 20 });

    progress.updateTaskFraction('feed', 0.25);
    expect(progress.getSnapshot()).toMatchObject({ rawProgress: 0.4, displayProgress: 40 });
    progress.updateTaskFraction('feed', 0.5);
    expect(progress.getSnapshot()).toMatchObject({ rawProgress: 0.6, displayProgress: 60 });
    progress.completeTask('feed');
    expect(progress.getSnapshot()).toMatchObject({ rawProgress: 1, displayProgress: 99, status: 'loading' });

    expect(progress.complete()).toBe(true);
    expect(progress.getSnapshot()).toMatchObject({ rawProgress: 1, displayProgress: 99, status: 'complete', phase: 'complete' });
  });

  it('reports real item work without changing the fixed weighted denominator', () => {
    const itemPlan: InitialLoadTaskDefinition[] = [{ id: 'normalize', task: '投稿データ正規化', weight: 100 }];
    const progress = new InitialLoadProgress(itemPlan);

    progress.updateTaskProgress('normalize', 2, 20);
    expect(progress.getSnapshot()).toMatchObject({
      completedUnits: 2,
      totalUnits: 20,
      processedItems: 2,
      totalItems: 20,
      rawProgress: 0.1,
      displayProgress: 10,
    });

    progress.updateTaskProgress('normalize', 1, 20);
    expect(progress.getSnapshot()).toMatchObject({ completedUnits: 2, rawProgress: 0.1, displayProgress: 10 });
    progress.updateTaskProgress('normalize', 20, 20);
    expect(progress.getSnapshot()).toMatchObject({ completedUnits: 20, rawProgress: 1, displayProgress: 99 });
  });

  it('keeps displayed progress monotonic if a late task is registered', () => {
    const progress = new InitialLoadProgress([
      { id: 'first', task: '先行処理', weight: 50 },
      { id: 'planned', task: '事前登録済み処理', weight: 50 },
    ]);
    progress.completeTask('first');
    expect(progress.getSnapshot().displayProgress).toBe(50);

    progress.register({ id: 'late', task: '追加で判明した処理', weight: 50 });
    expect(progress.getSnapshot().displayProgress).toBe(50);
    progress.completeTask('planned');
    progress.completeTask('late');
    expect(progress.getSnapshot().displayProgress).toBe(99);
  });

  it('separates loading and error states, and retry resets every progress field', async () => {
    const progress = new InitialLoadProgress(plan);
    await expect(progress.runTask('auth', async () => { throw new Error('offline'); })).rejects.toThrow('offline');
    expect(progress.getSnapshot()).toMatchObject({ status: 'loading', displayProgress: 20 });

    progress.fail('NETWORK_ERROR');
    expect(progress.getSnapshot()).toMatchObject({ status: 'error', errorCode: 'NETWORK_ERROR' });
    const previousSession = progress.getSessionId();
    const newSession = progress.restart();
    expect(newSession).toBe(previousSession + 1);
    expect(progress.getSnapshot()).toMatchObject({ status: 'loading', completedUnits: 0, totalUnits: 2, rawProgress: 0, displayProgress: 0 });
  });

  it('ignores completion from a cancelled or replaced session', async () => {
    const progress = new InitialLoadProgress(plan);
    const stale = deferred<void>();
    const staleTask = progress.runTask('auth', () => stale.promise);
    progress.cancel();
    progress.restart();
    const current = deferred<void>();
    const currentTask = progress.runTask('auth', () => current.promise);

    stale.resolve();
    await staleTask;
    expect(progress.getSnapshot()).toMatchObject({ completedUnits: 0, rawProgress: 0, displayProgress: 0, status: 'loading' });

    current.resolve();
    await currentTask;
    expect(progress.getSnapshot()).toMatchObject({ completedUnits: 1, rawProgress: 0.2, displayProgress: 20, status: 'loading' });
  });

  it('does not double-count duplicate completion events', () => {
    const progress = new InitialLoadProgress(plan);
    progress.completeTask('auth');
    progress.completeTask('auth');
    progress.updateTaskFraction('auth', 0.2);
    expect(progress.getSnapshot()).toMatchObject({ completedUnits: 1, completedWeight: 20, rawProgress: 0.2, displayProgress: 20 });
  });

  it('does not let deferred work hold the startup gate or change its denominator', () => {
    const progress = new InitialLoadProgress([
      { id: 'critical', task: '画面データ', weight: 80 },
      { id: 'deferred', task: '補助データ', weight: 20, blocking: false },
    ]);

    progress.completeTask('deferred');
    expect(progress.getSnapshot()).toMatchObject({ totalWeight: 80, completedWeight: 0, displayProgress: 0 });
    progress.completeTask('critical');
    expect(progress.complete()).toBe(true);
  });

  it('contains no timer-based fake progress mechanism', async () => {
    const source = await readFile(new URL('../src/initialLoadProgress.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/setInterval|setTimeout|requestAnimationFrame|Math\.random/);
  });

  it('uses one integer value for the DOM label, ARIA value, and bar width', async () => {
    const [main, style] = await Promise.all([
      readFile(new URL('../src/main.ts', import.meta.url), 'utf8').then(source => source.replace(/\r\n/g, '\n')),
      readFile(new URL('../src/style.css', import.meta.url), 'utf8'),
    ]);

    expect(main).toContain('const value = snapshot.displayProgress');
    expect(main).toContain('bar.style.width = `${value}%`');
    expect(main).toContain('track?.setAttribute(\'aria-valuenow\', String(value))');
    expect(main).toContain('await nextPaint();\n  await nextPaint();\n  unmount();');
    expect(main).toContain("retry.hidden = snapshot.status !== 'error'");
    expect(style).toContain('.initial-load-bar');
    expect(style).not.toMatch(/\.loading-screen|\.loading-spinner|\.spinner\s*\{|@keyframes spin/);
    expect(main).toContain('class="initial-load-value">0%');
  });
});
