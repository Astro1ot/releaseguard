export type State = 'operational' | 'degraded' | 'unknown';
export interface Incident { component: string; openedAt: string; resolvedAt?: string; message: string }
export class StatusTracker {
  private components = new Map<string, { state: State; failures: number; successes: number; checkedAt: string }>();
  private incidents: Incident[] = [];
  constructor(private threshold = 3, private staleAfterMs = 20000) {}
  record(name: string, up: boolean, now = new Date().toISOString()) {
    const component = this.components.get(name) ?? { state: 'unknown' as State, failures: 0, successes: 0, checkedAt: now };
    if (Date.parse(now) - Date.parse(component.checkedAt) > this.staleAfterMs) {
      component.state = 'unknown'; component.failures = 0; component.successes = 0;
    }
    component.checkedAt = now;
    component.failures = up ? 0 : component.failures + 1;
    component.successes = up ? component.successes + 1 : 0;
    if (!up && component.failures >= this.threshold && component.state !== 'degraded') {
      component.state = 'degraded';
      if (!this.incidents.some(i => i.component === name && !i.resolvedAt)) this.incidents.unshift({ component: name, openedAt: now, message: `${name} failed ${this.threshold} consecutive checks` });
      this.incidents = this.incidents.slice(0, 100);
    }
    if (up && component.successes >= this.threshold && component.state !== 'operational') {
      component.state = 'operational';
      const incident = this.incidents.find(i => i.component === name && !i.resolvedAt);
      if (incident) incident.resolvedAt = now;
    }
    this.components.set(name, component);
  }
  snapshot(now = Date.now()) {
    const components = [...this.components].map(([name, c]) => {
      const stale = now - Date.parse(c.checkedAt) > this.staleAfterMs;
      return { name, state: stale ? 'unknown' as State : c.state, checkedAt: c.checkedAt, stale };
    });
    return { state: components.some(c => c.state === 'degraded') ? 'degraded' : components.length && components.every(c => c.state === 'operational') ? 'operational' : 'unknown', components, incidents: this.incidents };
  }
}
