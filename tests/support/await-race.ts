/**
 * Create fresh state in scenario(race), returning that state and the writer's `done` promise.
 * Wrap async ports with race.port("name", (...args) => port(...args)).
 * A baseline counts calls; each replay disturbs its state while one wrapped promise is pending.
 * Assert that replay's state contains no writes made stale by the disturbance.
 */
export interface AwaitRace {
  port<Args extends unknown[], Value>(name: string, work: (...args: Args) => Promise<Value>): (...args: Args) => Promise<Value>;
}

export async function forEachAwait<Run extends { done: Promise<unknown> }>(
  scenario: (race: AwaitRace) => Run,
  disturb: (run: Run) => void | Promise<void>,
  assertNoStaleWrite: (run: Run) => void | Promise<void>,
): Promise<number> {
  const baseline: string[] = [];
  async function replay(target: number) {
    let count = 0, name = baseline[target - 1], disturbance: Promise<void> | undefined;
    let run: Run;
    const race: AwaitRace = {
      port: (portName, work) => async (...args) => {
        const index = ++count;
        if (!target) baseline.push(portName);
        const pending = Promise.resolve().then(() => work(...args));
        if (index !== target) return pending;
        name = portName;
        const outcome = pending.then(
          value => ({ ok: true as const, value }),
          error => ({ ok: false as const, error }),
        );
        // Defer until scenario has returned and the writer is suspended on this wrapper.
        disturbance = Promise.resolve().then(() => disturb(run));
        const [settled] = await Promise.all([outcome, disturbance]);
        if (!settled.ok) throw settled.error;
        return settled.value;
      },
    };
    try {
      run = scenario(race);
      await run.done;
      await disturbance;
      if (target) {
        if (!disturbance) throw new Error("The scenario did not reach this await point.");
        await assertNoStaleWrite(run);
      }
    } catch (cause) {
      const where = target ? `await point ${target} (port ${name})` : "await-race baseline";
      throw new Error(`${where}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    }
  }
  await replay(0);
  if (!baseline.length) throw new Error("await-race baseline has zero wrapped awaits; wrap the writer's async ports.");
  for (let point = 1; point <= baseline.length; point++) await replay(point);
  return baseline.length;
}
