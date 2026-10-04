export type InitialLoadStatus = 'loading' | 'error' | 'complete' | 'cancelled';

// Kept as an alias for callers that used the first version of the tracker.
export type InitialLoadPhase = InitialLoadStatus;

export type InitialLoadTaskDefinition = {
  id: string;
  task: string;
  weight: number;
  totalUnits?: number;
  /** Non-blocking work is observed when useful, but never holds the startup gate. */
  blocking?: boolean;
};

export type InitialLoadSnapshot = {
  task: string;
  completedUnits: number;
  totalUnits: number;
  completedWeight: number;
  totalWeight: number;
  /** The weighted completion ratio calculated from real task work. */
  rawProgress: number;
  /** Integer 0..99 while the gate is visible. It never reaches 100. */
  displayProgress: number;
  status: InitialLoadStatus;
  /** Compatibility field for older consumers; status is the canonical field. */
  phase: InitialLoadPhase;
  /** Duration of the last event's task, in milliseconds. */
  duration: number | null;
  processedItems?: number;
  totalItems?: number;
  errorCode?: string;
};

type Listener = (snapshot: InitialLoadSnapshot) => void;

type TaskState = InitialLoadTaskDefinition & {
  totalUnits: number;
  completedUnits: number;
  fraction: number;
  startedAt: number | null;
  duration: number | null;
  unitsObserved: boolean;
};

type TrackerOptions = {
  now?: () => number;
  debug?: boolean;
};

function safeWeight(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function safeUnits(value: number | undefined): number {
  return Number.isFinite(value) && (value || 0) > 0 ? Math.floor(value as number) : 1;
}

function abortError(): Error {
  const error = new Error('Initial loading session is no longer active');
  error.name = 'AbortError';
  return error;
}

/**
 * Weighted, session-scoped progress for the legacy startup flow.
 *
 * Every task is registered before the session starts. A task can report a
 * real item fraction (for example, 4 of 10 posts normalized), but the task's
 * weight is fixed for the session. This keeps the user-facing denominator
 * stable while still exposing item-level work in progress events.
 */
export class InitialLoadProgress {
  private readonly listeners = new Set<Listener>();
  private readonly now: () => number;
  private readonly debug: boolean;
  private plan: InitialLoadTaskDefinition[];
  private tasks = new Map<string, TaskState>();
  private status: InitialLoadStatus = 'loading';
  private errorCode: string | undefined;
  private sessionId = 0;
  private lastDisplayProgress = 0;
  private lastTask = '';
  private lastDuration: number | null = null;
  private lastProcessedItems: number | undefined;
  private lastTotalItems: number | undefined;

  constructor(plan: readonly InitialLoadTaskDefinition[] = [], options: TrackerOptions = {}) {
    this.now = options.now || (() => typeof performance !== 'undefined' ? performance.now() : Date.now());
    this.debug = options.debug === true;
    this.plan = [];
    this.replacePlan(plan);
  }

  getSessionId(): number {
    return this.sessionId;
  }

  getSnapshot(): InitialLoadSnapshot {
    const blockingTasks = [...this.tasks.values()].filter(task => task.blocking !== false);
    const totalWeight = blockingTasks.reduce((sum, task) => sum + task.weight, 0);
    const completedWeight = blockingTasks.reduce((sum, task) => sum + task.weight * task.fraction, 0);
    const rawProgress = totalWeight === 0 ? 0 : Math.min(1, completedWeight / totalWeight);
    const calculatedDisplay = Math.min(99, Math.floor(rawProgress * 100));
    const displayProgress = Math.max(this.lastDisplayProgress, calculatedDisplay);

    return {
      task: this.lastTask,
      completedUnits: blockingTasks.reduce((sum, task) => sum + task.completedUnits, 0),
      totalUnits: blockingTasks.reduce((sum, task) => sum + task.totalUnits, 0),
      completedWeight,
      totalWeight,
      rawProgress,
      displayProgress,
      status: this.status,
      phase: this.status,
      duration: this.lastDuration,
      ...(this.lastProcessedItems === undefined ? {} : {
        processedItems: this.lastProcessedItems,
        totalItems: this.lastTotalItems,
      }),
      ...(this.errorCode ? { errorCode: this.errorCode } : {}),
    };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  /** Registers a plan before work begins. Production startup uses replacePlan once. */
  register(definition: InitialLoadTaskDefinition): void {
    if (this.status !== 'loading' || this.tasks.has(definition.id)) return;
    const normalizedDefinition = {
      ...definition,
      weight: safeWeight(definition.weight),
    };
    this.plan.push({ ...normalizedDefinition });
    this.tasks.set(definition.id, {
      ...normalizedDefinition,
      totalUnits: safeUnits(definition.totalUnits),
      completedUnits: 0,
      fraction: 0,
      startedAt: null,
      duration: null,
      unitsObserved: definition.totalUnits !== undefined,
    });
    this.notify(definition.task);
  }

  /** Starts a task without changing the denominator. */
  startTask(id: string, run = this.sessionId): void {
    const task = this.currentTask(id, run);
    if (!task || task.startedAt !== null) return;
    task.startedAt = this.now();
    this.lastDuration = null;
    this.notify(task.task);
  }

  /**
   * Reports actual item work. The denominator is set before the first item is
   * counted and the task weight itself never changes.
   */
  updateTaskProgress(id: string, processedItems: number, totalItems: number, run = this.sessionId): void {
    const task = this.currentTask(id, run);
    if (!task) return;
    this.ensureStarted(task);
    const safeTotal = Math.max(1, Math.floor(Number(totalItems) || 1));
    if (!task.unitsObserved) {
      task.totalUnits = safeTotal;
      task.unitsObserved = true;
    }
    const processed = Math.min(task.totalUnits, Math.max(0, Math.floor(Number(processedItems) || 0)));
    task.completedUnits = Math.max(task.completedUnits, processed);
    task.fraction = Math.max(task.fraction, task.completedUnits / task.totalUnits);
    this.finishIfComplete(task);
    this.notify(task.task, { processedItems, totalItems });
  }

  /** Reports a real fractional sub-stage when a task has multiple operations. */
  updateTaskFraction(id: string, fraction: number, run = this.sessionId, itemProgress?: { processedItems: number; totalItems: number }): void {
    const task = this.currentTask(id, run);
    if (!task) return;
    this.ensureStarted(task);
    task.fraction = Math.max(task.fraction, Math.min(1, Math.max(0, fraction)));
    task.completedUnits = Math.max(task.completedUnits, Math.floor(task.totalUnits * task.fraction));
    this.finishIfComplete(task);
    this.notify(task.task, itemProgress);
  }

  completeTask(id: string, run = this.sessionId): void {
    const task = this.currentTask(id, run);
    if (!task) return;
    this.ensureStarted(task);
    task.completedUnits = task.totalUnits;
    task.fraction = 1;
    this.finishIfComplete(task);
    this.notify(task.task);
  }

  /** Marks a branch as not applicable after the real branch decision. */
  skipTask(id: string, run = this.sessionId): void {
    this.completeTask(id, run);
  }

  /** Runs one registered task and ignores completion from an old session. */
  runTask<T>(id: string, operation: () => Promise<T>, run = this.sessionId): Promise<T> {
    if (!this.isCurrent(run) || !this.tasks.has(id)) return Promise.reject(abortError());
    this.startTask(id, run);
    return Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          this.completeTask(id, run);
          return value;
        },
        (error: unknown) => {
          this.completeTask(id, run);
          throw error;
        },
      );
  }

  /** Moves the gate to complete only when every planned task has settled. */
  complete(): boolean {
    if (this.status !== 'loading') return false;
    const complete = [...this.tasks.values()]
      .filter(task => task.blocking !== false)
      .every(task => task.fraction >= 1);
    if (!complete) return false;
    this.status = 'complete';
    this.lastDisplayProgress = 99;
    this.notify(this.lastTask || '初期表示');
    return true;
  }

  fail(errorCode = 'UNKNOWN'): void {
    if (this.status !== 'loading') return;
    this.status = 'error';
    this.errorCode = errorCode;
    this.notify(this.lastTask || '初期読み込み');
  }

  cancel(): void {
    if (this.status !== 'loading') return;
    this.status = 'cancelled';
    this.notify(this.lastTask || '初期読み込み');
  }

  /** Starts a fresh session with the exact same predeclared plan. */
  restart(): number {
    this.sessionId += 1;
    this.status = 'loading';
    this.errorCode = undefined;
    this.lastDisplayProgress = 0;
    this.lastTask = '';
    this.lastDuration = null;
    this.lastProcessedItems = undefined;
    this.lastTotalItems = undefined;
    this.replacePlan(this.plan);
    this.notify('初期読み込み');
    return this.sessionId;
  }

  private replacePlan(plan: readonly InitialLoadTaskDefinition[]): void {
    this.plan = plan.map(item => ({ ...item, weight: safeWeight(item.weight) }));
    const taskEntries: Array<[string, TaskState]> = this.plan.map(item => {
      const task: TaskState = {
        ...item,
        totalUnits: safeUnits(item.totalUnits),
        completedUnits: 0,
        fraction: 0,
        startedAt: null,
        duration: null,
        unitsObserved: item.totalUnits !== undefined,
      };
      return [item.id, task];
    });
    this.tasks = new Map(taskEntries);
  }

  private isCurrent(run: number): boolean {
    return run === this.sessionId && this.status === 'loading';
  }

  private currentTask(id: string, run: number): TaskState | null {
    if (!this.isCurrent(run)) return null;
    return this.tasks.get(id) || null;
  }

  private ensureStarted(task: TaskState): void {
    if (task.startedAt === null) {
      task.startedAt = this.now();
      this.lastDuration = null;
    }
  }

  private finishIfComplete(task: TaskState): void {
    if (task.fraction < 1 || task.startedAt === null) return;
    task.duration = Math.max(0, this.now() - task.startedAt);
    this.lastDuration = task.duration;
  }

  private notify(taskName: string, itemProgress?: { processedItems: number; totalItems: number }): void {
    this.lastTask = taskName;
    this.lastProcessedItems = itemProgress?.processedItems;
    this.lastTotalItems = itemProgress?.totalItems;
    const snapshot = this.getSnapshot();
    this.lastDisplayProgress = snapshot.displayProgress;
    this.lastDuration = snapshot.duration;
    if (this.debug) {
      console.debug('[initial-load]', JSON.stringify({
        task: snapshot.task,
        completedUnits: snapshot.completedUnits,
        totalUnits: snapshot.totalUnits,
        rawProgress: snapshot.rawProgress,
        displayProgress: snapshot.displayProgress,
        status: snapshot.status,
        duration: snapshot.duration,
        ...(snapshot.processedItems === undefined ? {} : {
          processedItems: snapshot.processedItems,
          totalItems: snapshot.totalItems,
        }),
      }));
    }
    this.listeners.forEach(listener => listener(snapshot));
  }
}
