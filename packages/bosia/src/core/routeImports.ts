// ─── Memoized Route Imports ───────────────────────────────
// The generated route table holds `() => import("…")` closures. Calling one
// again for an already-loaded module still goes through the module loader,
// and the request path calls several per request (layouts, layout servers,
// page, page server): ~20% of the data endpoint's CPU. Each importer is
// wrapped once at startup so later calls return the settled promise.
//
// Safe for the process lifetime: dev rebuilds and restarts the server on
// every change, so a module never changes under a running server. A rejected
// import is not kept — the next request retries it.

type Importer<T = any> = () => Promise<T>;

const MEMOIZED = Symbol("bosia.memoized");

export function memoizeImport<T>(fn: Importer<T>): Importer<T> {
	if ((fn as any)[MEMOIZED]) return fn;
	let pending: Promise<T> | null = null;
	const memo = () =>
		(pending ??= fn().catch((err) => {
			pending = null;
			throw err;
		}));
	(memo as any)[MEMOIZED] = true;
	return memo;
}

type ServerRouteImports = {
	pageModule: Importer;
	layoutModules: Importer[];
	pageServer: Importer | null;
	layoutServers: { loader: Importer }[];
	// Absent from the ambient `bosia:routes` type; always present at runtime.
	errorPages?: { loader: Importer }[];
};

/** Wrap every importer in the route tables in place. Idempotent. */
export function memoizeRouteImports(
	apiRoutes: { module: Importer }[],
	serverRoutes: ServerRouteImports[],
): void {
	for (const r of apiRoutes) r.module = memoizeImport(r.module);
	for (const r of serverRoutes) {
		r.pageModule = memoizeImport(r.pageModule);
		r.layoutModules = r.layoutModules.map(memoizeImport);
		if (r.pageServer) r.pageServer = memoizeImport(r.pageServer);
		for (const ls of r.layoutServers) ls.loader = memoizeImport(ls.loader);
		for (const ep of r.errorPages ?? []) ep.loader = memoizeImport(ep.loader);
	}
}
