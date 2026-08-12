import type { Route } from "./types";

/** Immutable-at-runtime route registry; adapters can be added without changing the core. */
export class RouteRegistry {
  private readonly entries: Map<string, Route>;
  constructor(routes: Iterable<Route> = []) {
    this.entries = new Map([...routes].map(route => [route.destination, route]));
  }
  get(destination: string): Route | undefined { return this.entries.get(destination); }
  has(destination: string): boolean { return this.entries.has(destination); }
  names(): string[] { return [...this.entries.keys()].sort(); }
}
