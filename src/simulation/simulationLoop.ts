/**
 * Fixed-timestep simulation scheduler with orbital time acceleration (1x to 1000x).
 *
 * Uses fixed 1/60 s steps at low/moderate warp, and switches cleanly to bounded RK4
 * macro-steps (<= 0.5 s) during high-speed unpowered orbital coasting (50x..1000x) so
 * long-duration orbits remain rock-solid without missing atmosphere/surface crossings.
 */
export const TIME_WARP_LEVELS = [1, 2, 5, 10, 50, 100, 500, 1000] as const;

export class SimulationClock {
  public readonly fixedDt = 1 / 60;
  public paused = false;
  public requestedTimeScale = 1;
  public effectiveTimeScale = 1;
  public warpCapReason: string | null = null;

  private accumulator = 0;
  private maxStepsPerFrame = 48;

  public setTimeScale(scale: number): void {
    this.requestedTimeScale = scale;
  }

  public togglePause(): boolean {
    this.paused = !this.paused;
    return this.paused;
  }

  public reset(): void {
    this.accumulator = 0;
    this.requestedTimeScale = 1;
    this.effectiveTimeScale = 1;
    this.warpCapReason = null;
    this.paused = false;
  }

  /**
   * Advance the simulation by real frame delta time.
   * Accepts either a boolean (`isUnstableForHighWarp`) for compatibility or an explicit
   * numeric `maxAllowedWarp` cap computed across all spacecraft.
   */
  public advance(
    realFrameDt: number,
    maxAllowedOrUnstable: boolean | number,
    onFixedStep: (dt: number) => void,
    capReason: string | null = null
  ): number {
    if (this.paused) {
      this.effectiveTimeScale = 0;
      this.warpCapReason = null;
      return 0;
    }

    const maxAllowed =
      typeof maxAllowedOrUnstable === 'boolean'
        ? maxAllowedOrUnstable
          ? 2
          : 50
        : maxAllowedOrUnstable;

    this.effectiveTimeScale = Math.min(this.requestedTimeScale, maxAllowed);
    this.warpCapReason = this.effectiveTimeScale < this.requestedTimeScale ? capReason : null;

    const clampedRealDt = Math.min(realFrameDt, 0.1);
    this.accumulator += clampedRealDt * this.effectiveTimeScale;

    // Choose safe physics step size: 1/60s for normal flight, bounded RK4 macro-step for deep-space orbital warp
    const stepDt =
      this.effectiveTimeScale <= 10
        ? this.fixedDt
        : Math.min(0.5, Math.max(this.fixedDt, this.effectiveTimeScale / 2400));

    let steps = 0;
    while (this.accumulator >= stepDt && steps < this.maxStepsPerFrame) {
      onFixedStep(stepDt);
      this.accumulator -= stepDt;
      steps++;
    }

    if (steps >= this.maxStepsPerFrame) {
      this.accumulator = 0;
    }

    return steps;
  }
}
