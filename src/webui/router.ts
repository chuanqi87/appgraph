/**
 * A tiny path-param router for the web UI's JSON API. Deliberately not a
 * dependency (express etc.) — the route surface is a dozen GET endpoints,
 * which a ~40-line matcher covers without pulling in a framework.
 */

export interface RouteContext {
  params: Record<string, string>;
  query: URLSearchParams;
}

export interface RouteResult {
  /** HTTP status code. Defaults to 200 — most "nothing to show yet" states
   *  (not indexed, app graph not built) are success-shaped guidance, not
   *  errors, so callers only set this for a genuine 4xx/5xx. */
  status?: number;
  body: unknown;
}

export type RouteHandler = (ctx: RouteContext) => Promise<RouteResult> | RouteResult;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

export class Router {
  private routes: Route[] = [];

  get(path: string, handler: RouteHandler): void {
    this.add('GET', path, handler);
  }

  private add(method: string, path: string, handler: RouteHandler): void {
    const paramNames: string[] = [];
    const patternSource = path
      .split('/')
      .map((segment) => {
        if (segment.startsWith(':')) {
          paramNames.push(segment.slice(1));
          return '([^/]+)';
        }
        return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    this.routes.push({
      method,
      pattern: new RegExp(`^${patternSource}$`),
      paramNames,
      handler,
    });
  }

  async dispatch(method: string, pathname: string, query: URLSearchParams): Promise<RouteResult | null> {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = route.pattern.exec(pathname);
      if (!match) continue;
      const params: Record<string, string> = {};
      route.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1] ?? '');
      });
      return route.handler({ params, query });
    }
    return null;
  }
}
