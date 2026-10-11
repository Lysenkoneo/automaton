/** Bounded runtime for safe local tests; no timers, wakeups or retry loop. */
export function safeTestCycleLimit(value = process.env.AUTOMATON_SAFE_LOCAL_TEST_MAX_CYCLES): number {
  if (value === undefined) return 1;
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error("AUTOMATON_SAFE_LOCAL_TEST_MAX_CYCLES must be a positive safe integer");
  }
  return Number(value);
}

export async function runSafeTestCycles(options: {
  maxCycles: number;
  runCycle: () => Promise<void>;
  close: () => void;
  signal?: AbortSignal;
}): Promise<void> {
  await withSafeTestResources(async () => {
    safeTestCycleLimit(String(options.maxCycles));
    for (let cycle = 0; cycle < options.maxCycles && !options.signal?.aborted; cycle++) {
      await options.runCycle();
    }
  }, options.close);
}

export async function withSafeTestResources(operation: () => Promise<void>, close: () => void): Promise<void> {
  const errors: unknown[] = [];
  try {
    await operation();
  } catch (error) {
    errors.push(error);
  }
  try { close(); } catch (error) { errors.push(error); }
  throwCollectedErrors(errors);
}

/** Only wrap inference, never a task that may continue accessing SQLite. */
export async function waitForSafeInference<T>(request: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return request();
  signal.throwIfAborted();
  let abort!: () => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  try { return await Promise.race([request(), stopped]); }
  finally { signal.removeEventListener("abort", abort); }
}

function throwCollectedErrors(errors: unknown[]): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.message : String(error)).join("; "));
}

/** Attempt every cleanup step, retaining both runtime and cleanup errors. */
export function closeSafeTestResources(steps: Array<() => void>): void {
  const errors: unknown[] = [];
  for (const step of steps) {
    try { step(); } catch (error) { errors.push(error); }
  }
  throwCollectedErrors(errors);
}

export function flushSafeTestOutput(streams = [process.stdout, process.stderr]): Promise<void> {
  // Write callbacks run after all preceding writes on each stream, even for pipes.
  return Promise.all(streams.map(stream => new Promise<void>((resolve, reject) => {
    stream.write("", error => error ? reject(error) : resolve());
  }))).then(() => undefined);
}

export async function exitSafeTestProcess(code: number, flush = flushSafeTestOutput, exit: (code: number) => void = process.exit): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([flush(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Safe test output flush timed out")), 5_000);
    })]);
  } catch { code = 1; }
  finally { if (timer) clearTimeout(timer); }
  exit(code);
}
