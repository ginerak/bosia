import { render } from "svelte/server";

import { findMatch } from "./matcher.ts";
import { serverRoutes, errorPage } from "bosia:routes";
import type { RouteMatch } from "./types.ts";
import { makeSetHeaders } from "./hooks.ts";
import type { Cookies, LoaderDeps } from "./hooks.ts";
import { CSP_ENABLED } from "./csp.ts";
import {
	CACHE_ENABLED,
	CACHE_MAX_BODY_BYTES,
	buildCompressedVariants,
	cacheGet,
	cacheSet,
	coalesceMiss,
	collectTags,
	computeCacheKey,
	deferCacheWrite,
	serveCached,
} from "./cache.ts";
import type { CookieJar } from "./cookies.ts";
import { LoaderCookies } from "./loaderCookies.ts";
import { HttpError, Redirect, isHttpError, isRedirect } from "./errors.ts";
import { pickErrorPage, type ErrorOrigin } from "./errorMatch.ts";
import App from "./client/App.svelte";
import { router } from "./client/router.svelte.ts";
import { withBase } from "./basePath.ts";
import { currentBase } from "./appBase.ts";
import {
	buildHtml,
	buildHtmlShellOpen,
	buildMetadataChunk,
	buildHtmlTail,
	compress,
	compressBytes,
	encodeForRequest,
	isDev,
	type Encoded,
} from "./html.ts";
import type { Metadata } from "./hooks.ts";
import { loadPlugins } from "./config.ts";
import { getPlatform, warmingUp } from "./platform.ts";
import { reportDevErrorFromCatch } from "./devErrorReport.ts";
import { dev500Response } from "./dev-500.ts";
import type { BosiaPlugin, RenderContext } from "./types/plugin.ts";
import { getAppHtmlSegments } from "./appHtml.ts";
import type { AppHtmlSegments } from "./appHtml.ts";

// Shared, stateless — one instance instead of a fresh allocation per stream.
const enc = new TextEncoder();

// ─── Per-request seed for `page` ──────────────────────────
// `page` (bosia/client) is imported directly by user components, so per-request
// values cannot reach it as props the way pageData/layoutData do — see the rule
// stated in App.svelte and appState.svelte.ts. The singletons it reads from are
// therefore seeded per request, which is a deliberate exception to that rule.
//
// This is safe only because bosia consumes render() synchronously: every call
// site destructures `{ body, head }` straight off the return value. That is
// bosia's own commitment, not svelte's guarantee — the declared type is
// `SyncRenderOutput & PromiseLike<SyncRenderOutput>` and svelte's server
// renderer has an await path. If async SSR is ever enabled, the existing
// destructuring and this seeding break together, and must be fixed together.
// Seeding lives in this wrapper so that stays true by construction: nothing can
// assign here and then await before rendering, which would make two concurrent
// requests render each other's URLs — a bug that reads as a flaky cache.
//
// `url` is app-space (server.ts strips BASE_PATH exactly once, at the top of
// handleRequest), but every value the client half writes to these fields is
// browser-space: hydrate.ts assigns raw window.location.pathname, and
// clientRoutes are generated with the prefix already in them. So the base goes
// back on before seeding, or a mounted app server-renders `/admin/audit` and
// hydration flips it to `/sso/admin/audit`.
//
// Assigning unconditionally is the point. Seeding only the success paths would
// let an error render inherit the previous request's URL — real cross-request
// leakage, strictly worse than a wrong-but-deterministic default.
//
// Two limits worth knowing before leaning on this:
//
// 1. The seed lands here, at render time — after every `load()` and
//    `metadata()` has already run. `page` still holds the previous request's
//    values throughout those, and the only reason that is not a live bug is
//    that they live in `+page.server.ts` / `+layout.server.ts`, where
//    `bosia/client` is not importable (see the header of lib/client.ts). Server
//    loaders get the real URL as the `url` argument; they must never read
//    `page`.
// 2. `url.origin` is the public origin only when TRUST_PROXY=true —
//    server.ts rebuilds host/proto from X-Forwarded-* under that flag alone,
//    because the headers are client-spoofable otherwise. Behind an untrusted
//    proxy the seeded origin is the inner hop (http://localhost:PORT) while the
//    browser hydrates with the public https:// origin, so `page.url.origin`
//    disagrees across the boundary. `page.url.pathname` is unaffected.
//
// `render`'s own signature is conditional on the component's prop type, so it
// collapses to `never` behind a generic wrapper — hence `any` on both, matching
// how the call sites already type `pageMod.default` / `layoutMods`.
function renderWithPageContext(component: any, options: { props?: Record<string, any> }, url: URL) {
	router.origin = url.origin;
	router.currentRoute = withBase(currentBase(), url.pathname) + url.search + url.hash;
	return render(component, options as any);
}

// Plugins are loaded once per process at module init via top-level await elsewhere
// (server.ts), but renderer is also reachable from build/prerender contexts where
// loadPlugins() may not have been called yet. The function is cached, so awaiting
// per request is cheap (Map hit on second call).
async function pluginRenderFragments(
	hook: "head" | "bodyEnd",
	ctx: RenderContext,
): Promise<string[]> {
	const plugins = await loadPlugins();
	const out: string[] = [];
	for (const p of plugins as BosiaPlugin[]) {
		const fn = p.render?.[hook];
		if (!fn) continue;
		try {
			const fragment = await fn(ctx);
			if (fragment) out.push(fragment);
		} catch (err) {
			if (isDev) console.error(`Plugin "${p.name}" render.${hook} failed:`, err);
			else console.error(`Plugin "${p.name}" render.${hook} failed:`, (err as Error).message);
			if (isDev) reportDevErrorFromCatch(err);
		}
	}
	return out;
}

// ─── Timeout Helpers ─────────────────────────────────────

class LoadTimeoutError extends Error {
	constructor(label: string, ms: number) {
		super(`${label} timed out after ${ms}ms`);
		this.name = "LoadTimeoutError";
	}
}

function parseTimeout(raw: string | undefined, fallback: number): number {
	if (!raw || raw === "Infinity") return 0;
	const n = parseInt(raw, 10);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

const LOAD_TIMEOUT = parseTimeout(process.env.LOAD_TIMEOUT, 5000);
const METADATA_TIMEOUT = parseTimeout(process.env.METADATA_TIMEOUT, 3000);

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
	if (ms <= 0) return promise;
	let timer: Timer;
	return Promise.race([
		promise.finally(() => clearTimeout(timer)),
		new Promise<never>(
			(_, reject) => (timer = setTimeout(() => reject(new LoadTimeoutError(label, ms)), ms)),
		),
	]);
}

type MaybePromise<T> = T | Promise<T>;

/**
 * `withTimeout` for a loader whose `parent()` may wait on other loaders. The
 * clock stops while `gate` holds a parent() wait, so a slow layout above does
 * not spend the budget of the loaders below it — each still gets `ms` of its
 * own work, as when they ran one after another.
 */
function runLoader<T>(
	ms: number,
	label: string,
	fn: (gate: <P>(p: Promise<P>) => Promise<P>) => T | Promise<T>,
): Promise<T> {
	if (ms <= 0) return Promise.resolve().then(() => fn((p) => p));
	return new Promise<T>((resolve, reject) => {
		let remaining = ms;
		let startedAt = 0;
		let timer: Timer | undefined;
		let waits = 0;
		let settled = false;
		const arm = () => {
			startedAt = performance.now();
			timer = setTimeout(() => {
				settled = true;
				reject(new LoadTimeoutError(label, ms));
			}, remaining);
		};
		const gate = async <P>(p: Promise<P>): Promise<P> => {
			if (waits++ === 0) {
				clearTimeout(timer);
				remaining -= performance.now() - startedAt;
			}
			try {
				return await p;
			} finally {
				if (--waits === 0 && !settled) arm();
			}
		};
		const finish = () => {
			settled = true;
			clearTimeout(timer);
		};
		arm();
		// A load() may be sync: return a plain object, or throw.
		let out: T | Promise<T>;
		try {
			out = fn(gate);
		} catch (e) {
			finish();
			reject(e);
			return;
		}
		Promise.resolve(out).then(
			(v) => {
				finish();
				resolve(v);
			},
			(e) => {
				finish();
				reject(e);
			},
		);
	});
}

// ─── Internal-Host Allowlist ─────────────────────────────
// Origins that share the user's session cookie. Cookie is auto-forwarded
// to same-origin requests AND to any origin in this set. Anything else
// (third-party APIs) gets no Cookie header by default.

const INTERNAL_HOSTS: Set<string> = (() => {
	const raw =
		process.env.INTERNAL_HOSTS?.split(",")
			.map((s) => s.trim())
			.filter(Boolean) ?? [];
	const valid = new Set<string>();
	for (const entry of raw) {
		try {
			valid.add(new URL(entry).origin);
		} catch {
			console.warn(`⚠️  INTERNAL_HOSTS: ignoring invalid origin "${entry}"`);
		}
	}
	return valid;
})();

if (INTERNAL_HOSTS.size > 0) {
	console.log(`🍪 Internal hosts (cookies forwarded): ${[...INTERNAL_HOSTS].join(", ")}`);
}

// ─── App HTML Template ───────────────────────────────────
// Required; loaded once per process; cached singleton with invalidation for HMR

const appHtmlSegments: AppHtmlSegments = getAppHtmlSegments();

// ─── Session-Aware Fetch ─────────────────────────────────
// Passed to load() functions so they can call internal APIs with the
// current user's cookies automatically forwarded. Cookie is attached
// only on same-origin requests or to origins in INTERNAL_HOSTS — never
// to arbitrary third-party hosts (which would leak the session token).

function makeFetch(req: Request, url: URL) {
	const cookie = req.headers.get("cookie") ?? "";
	const sameOrigin = url.origin;

	return (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		let targetOrigin: string | null = null;
		let resolved: RequestInfo | URL = input;

		try {
			if (typeof input === "string") {
				const parsed = new URL(input, sameOrigin);
				targetOrigin = parsed.origin;
				resolved = parsed.href;
			} else if (input instanceof URL) {
				targetOrigin = input.origin;
			} else {
				targetOrigin = new URL(input.url).origin;
			}
		} catch {
			targetOrigin = null;
		}

		const headers = new Headers(init?.headers);
		const trusted =
			targetOrigin !== null && (targetOrigin === sameOrigin || INTERNAL_HOSTS.has(targetOrigin));
		if (cookie && trusted && !headers.has("cookie")) headers.set("cookie", cookie);

		return globalThis.fetch(resolved, { ...init, headers });
	};
}

// ─── Error Context Stamping ──────────────────────────────
// Annotate an HttpError with the layout depth and origin where it was
// thrown, plus the partial layoutData accumulated so far. The data
// endpoint forwards this to the client; the SSR catch sites use it to
// render the right nested boundary inside the right layout chain.

function stampErrorContext(
	err: HttpError,
	depth: number,
	origin: ErrorOrigin,
	partialLayoutData: Record<string, any>[],
): void {
	const e = err as HttpError & {
		errorDepth?: number;
		errorOrigin?: ErrorOrigin;
		partialLayoutData?: Record<string, any>[];
	};
	e.errorDepth ??= depth;
	e.errorOrigin ??= origin;
	e.partialLayoutData ??= [...partialLayoutData];
}

// ─── Per-Loader Dependency Tracking ──────────────────────
// Wraps `params`, `url`, `cookies`, and `fetch` with proxies/closures
// that record every key read during a single loader run. The client
// cache uses these records to skip re-runs on subsequent navigations
// when none of the tracked inputs changed.

function emptyDeps(): LoaderDeps {
	return {
		keys: [],
		urls: [],
		params: [],
		searchParams: [],
		cookies: [],
		uses_url: false,
	};
}

function trackedParams(params: Record<string, string>, deps: LoaderDeps): Record<string, string> {
	return new Proxy(params, {
		get(target, prop) {
			if (typeof prop === "string") {
				if (!deps.params.includes(prop)) deps.params.push(prop);
			}
			return Reflect.get(target, prop);
		},
	});
}

const URL_TRACKED_PROPS = new Set(["pathname", "origin", "hash", "href", "host", "hostname"]);

function trackedUrl(url: URL, deps: LoaderDeps): URL {
	const trackedSearch = new Proxy(url.searchParams, {
		get(target, prop) {
			if (prop === "get" || prop === "has" || prop === "getAll") {
				return (key: string) => {
					if (typeof key === "string" && !deps.searchParams.includes(key)) {
						deps.searchParams.push(key);
					}
					return (target as any)[prop](key);
				};
			}
			const value = Reflect.get(target, prop);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	return new Proxy(url, {
		get(target, prop) {
			if (prop === "searchParams") return trackedSearch;
			if (prop === "search") {
				// Whole search string read → treat as broad searchParams dep
				deps.uses_url = true;
				return target.search;
			}
			if (typeof prop === "string" && URL_TRACKED_PROPS.has(prop)) {
				deps.uses_url = true;
			}
			const value = Reflect.get(target, prop);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

function trackedCookies(cookies: Cookies, deps: LoaderDeps): Cookies {
	return {
		get(name: string) {
			if (!deps.cookies.includes(name)) deps.cookies.push(name);
			return cookies.get(name);
		},
		getAll() {
			// Broad read — treat as wildcard; record empty marker so any cookie
			// invalidation triggers re-run. Use a sentinel "*" to mean "all".
			if (!deps.cookies.includes("*")) deps.cookies.push("*");
			return cookies.getAll();
		},
		set(name, value, options) {
			cookies.set(name, value, options);
		},
		delete(name, options) {
			cookies.delete(name, options);
		},
	};
}

function trackedFetch(
	fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
	origin: string,
	deps: LoaderDeps,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
	return (input, init) => {
		let href: string | null = null;
		try {
			if (typeof input === "string") href = new URL(input, origin).href;
			else if (input instanceof URL) href = input.href;
			else href = new URL(input.url, origin).href;
		} catch {
			href = null;
		}
		if (href && !deps.urls.includes(href)) deps.urls.push(href);
		return fetch(input, init);
	};
}

function makeDepends(deps: LoaderDeps): (...keys: string[]) => void {
	return (...keys: string[]) => {
		for (const k of keys) {
			if (typeof k === "string" && !deps.keys.includes(k)) deps.keys.push(k);
		}
	};
}

// ─── Route Data Loader ───────────────────────────────────
// Runs layout + page server loaders for a given URL.
// Used by both SSR and the /__bosia/data JSON endpoint.
//
// `mask` controls selective re-runs from the client data endpoint:
//   - undefined → run everything (SSR, first nav)
//   - layouts[i] === true → run that layout; false → skip, emit null
//   - page === true → run page; false → skip, emit null
// When skipped, the parent() chain still receives the *combined parent
// data* contributed by previously-cached layers. The client already holds
// each skipped layer's data in its loader cache and forwards it as
// `parentSnapshots` (depth → data) in the request body, so downstream
// loaders that DO re-run see real parent() data, not `{}`. The response
// slot stays `null` (client renders that layer from its cache).
//
// Trust boundary: parentSnapshots are a client-supplied perf hint, never
// authoritative. Anything authz-related must read `event.locals` (populated
// in hooks.server.ts), never `parent()`.

export type LoaderMask = {
	page: boolean;
	layouts: boolean[];
};

export async function loadRouteData(
	url: URL,
	locals: Record<string, any>,
	req: Request,
	cookies: Cookies,
	metadataData: MaybePromise<Record<string, any> | null> = null,
	match?: RouteMatch<(typeof serverRoutes)[number]> | null,
	mask?: LoaderMask,
	parentSnapshots?: Record<number, Record<string, any>>,
	// Passed by a caller that runs metadata() alongside: it commits or discards
	// once it knows the metadata outcome. Otherwise committed here.
	callerCookies?: LoaderCookies,
) {
	match ??= findMatch(serverRoutes, url.pathname);
	if (!match) return null;
	const ownsCookies = !callerCookies;
	const loaderCookies = callerCookies ?? new LoaderCookies(cookies);

	const { route, params } = match;
	const fetch = makeFetch(req, url);
	const origin = url.origin;
	const layoutData: (Record<string, any> | null)[] = [];
	const layoutDeps: (LoaderDeps | null)[] = [];
	// Shared across layout + page loaders so cross-loader duplicate
	// setHeaders() calls throw. Keys stored lowercased.
	const loaderHeaders: Record<string, string> = {};
	const setHeaders = makeSetHeaders(loaderHeaders);

	// Every loader starts at once; parent() is what orders them. A layer that
	// never calls parent() no longer waits for the layers above it to finish.
	// `contrib` is what a layer adds to the parent() chain below it. Tasks never
	// reject — a failure resolves to `{ err }` — so a deeper failure that is
	// never awaited (a shallower one is reported first) is not an unhandled
	// rejection, without a `.catch()` per task.
	type Layer = { data: Record<string, any> | null; deps: LoaderDeps | null; contrib: object };
	const layers: Promise<Layer | Failed>[] = [];
	const parentCache = new Map<number, Promise<Record<string, any>>>();
	// Merged data of layers [0, n). One object per n, so a loader cannot mutate
	// what another sees; rejects with the first failing layer's error.
	const parentOf = (n: number): Promise<Record<string, any>> => {
		let p = parentCache.get(n);
		if (!p) {
			p = (async () => {
				let acc: Record<string, any> = {};
				for (let j = 0; j < n; j++) {
					const layer = await layers[j]!;
					if (layer instanceof Failed) throw layer.err;
					acc = { ...acc, ...layer.contrib };
				}
				return acc;
			})();
			p.catch(noop);
			parentCache.set(n, p);
		}
		return p;
	};

	route.layoutServers.forEach((ls, i) => {
		layers.push(
			(async (): Promise<Layer | Failed> => {
				try {
					if (mask && mask.layouts[ls.depth] === false) {
						// Skipped layers contribute their client-cached data (forwarded as
						// parentSnapshots) to the parent chain, so downstream loaders that DO
						// re-run see real parent() data. Falls back to {} when no snapshot was
						// sent. Perf hint only — never authoritative for authz (use locals).
						return { data: null, deps: null, contrib: parentSnapshots?.[ls.depth] ?? {} };
					}
					const mod = await ls.loader();
					if (typeof mod.load !== "function" || warmingUp) {
						return { data: {}, deps: emptyDeps(), contrib: {} };
					}
					const deps = emptyDeps();
					const result =
						(await runLoader(
							LOAD_TIMEOUT,
							`layout load (depth=${ls.depth}, ${url.pathname})`,
							(gate) =>
								mod.load({
									params: trackedParams(params, deps),
									url: trackedUrl(url, deps),
									locals,
									cookies: trackedCookies(loaderCookies.writer(i), deps),
									parent: () => handled(gate(parentOf(i))),
									fetch: trackedFetch(fetch, origin, deps),
									metadata: null,
									depends: makeDepends(deps),
									platform: getPlatform(),
									setHeaders,
								}),
						)) ?? {};
					return { data: result, deps, contrib: result };
				} catch (err) {
					return new Failed(err);
				}
			})(),
		);
	});

	let csr = true;
	let ssr = true;
	const skipPage = mask && mask.page === false;
	type Page = { data: Record<string, any> | null; deps: LoaderDeps | null };
	const pageServer = route.pageServer;
	// No +page.server.ts: nothing to run, so no task either.
	const pageTask: Page | Promise<Page | Failed> = !pageServer
		? { data: {}, deps: emptyDeps() }
		: (async (): Promise<Page | Failed> => {
				try {
					const mod = await pageServer();
					if (mod.csr === false) csr = false;
					if (mod.ssr === false) ssr = false;
					if (skipPage) return { data: null, deps: null };
					if (typeof mod.load !== "function" || warmingUp) {
						return { data: {}, deps: emptyDeps() };
					}
					// metadata() runs alongside the layouts; only the page load consumes it.
					const metadata = metadataData instanceof Promise ? await metadataData : metadataData;
					const deps = emptyDeps();
					const data =
						(await runLoader(LOAD_TIMEOUT, `page load (${url.pathname})`, (gate) =>
							mod.load({
								params: trackedParams(params, deps),
								url: trackedUrl(url, deps),
								locals,
								cookies: trackedCookies(loaderCookies.writer(layers.length), deps),
								parent: () => handled(gate(parentOf(layers.length))),
								fetch: trackedFetch(fetch, origin, deps),
								metadata,
								depends: makeDepends(deps),
								platform: getPlatform(),
								setHeaders,
							}),
						)) ?? {};
					return { data, deps };
				} catch (err) {
					return new Failed(err);
				}
			})();

	// Collect root → leaf, so the shallowest failure wins — the one a serial run
	// would have hit first.
	for (let i = 0; i < layers.length; i++) {
		const depth = route.layoutServers[i]!.depth;
		const layer = await layers[i]!;
		if (layer instanceof Failed) {
			// Deeper loaders kept running, but serially they never would have:
			// their cookies must not ride on this layer's redirect or error page.
			loaderCookies.keepOnlyBelow(i + 1);
			if (ownsCookies) loaderCookies.commit();
			throw loaderFailure(layer.err, depth, "layout", layoutData);
		}
		layoutData[depth] = layer.data;
		layoutDeps[depth] = layer.deps;
	}

	const page = pageTask instanceof Promise ? await pageTask : pageTask;
	if (ownsCookies) loaderCookies.commit();
	if (page instanceof Failed) {
		throw loaderFailure(page.err, route.layoutModules.length, "page", layoutData);
	}
	const { data: pageData, deps: pageDeps } = page;

	// `params` are always attached to pageData for client-side router consumption.
	// When pageData is skipped, the client merges its cached pageData with current
	// route params separately, so we keep the `null` sentinel here.
	const pageOut = pageData === null ? null : { ...pageData, params };
	return { pageData: pageOut, layoutData, csr, ssr, pageDeps, layoutDeps, loaderHeaders };
}

function noop() {}

/**
 * What the page load sees in place of `metadata.data` when metadata() threw a
 * Redirect/HttpError. Not the error itself: the page task would otherwise stamp
 * a page boundary onto the very object the caller is about to report, in the
 * background, and the error page chosen would depend on timing. The caller
 * always handles the metadata outcome first, so this never reaches a response.
 */
const METADATA_DECIDED = Symbol("bosia.metadataDecided");

/**
 * parent() can reject (an ancestor failed, timed out or redirected). A loader
 * that starts it and never awaits it — it failed first — must not leave an
 * unhandled rejection: in production that exits the process. The caller still
 * gets the same promise and sees the rejection when it awaits.
 */
function handled<T>(p: Promise<T>): Promise<T> {
	p.catch(noop);
	return p;
}

/** A loader task's failure, resolved rather than rejected. */
class Failed {
	constructor(readonly err: unknown) {}
}

/** The error a failed loader at `depth` throws: redirects pass through,
 *  HttpErrors get their boundary stamped, anything else becomes a stamped 500. */
function loaderFailure(
	err: unknown,
	depth: number,
	origin: ErrorOrigin,
	layoutData: (Record<string, any> | null)[],
): unknown {
	if (isRedirect(err) || err === METADATA_DECIDED) return err;
	const partial = layoutData.map((d) => d ?? {});
	if (isHttpError(err)) {
		stampErrorContext(err, depth, origin, partial);
		return err;
	}
	const kind = origin === "layout" ? "Layout" : "Page";
	if (isDev) console.error(`${kind} server load error:`, err);
	else console.error(`${kind} server load error:`, (err as Error).message ?? err);
	if (isDev) reportDevErrorFromCatch(err);
	const wrapped = new HttpError(500, "Internal Server Error");
	stampErrorContext(wrapped, depth, origin, partial);
	return wrapped;
}

// ─── Metadata Loader ─────────────────────────────────────

export async function loadMetadata(
	route: any,
	params: Record<string, string>,
	url: URL,
	locals: Record<string, any>,
	cookies: Cookies,
	req: Request,
): Promise<Metadata | null> {
	if (!route.pageServer) return null;
	try {
		const mod = await route.pageServer();
		if (typeof mod.metadata === "function" && !warmingUp) {
			const fetch = makeFetch(req, url);
			return (
				(await withTimeout(
					mod.metadata({ params, url, locals, cookies, fetch, platform: getPlatform() }),
					METADATA_TIMEOUT,
					`metadata (${url.pathname})`,
				)) ?? null
			);
		}
	} catch (err) {
		// Control flow thrown from metadata() is intent, not failure — swallowing it
		// here made every caller's Redirect/HttpError branch dead code.
		if (isRedirect(err) || isHttpError(err)) throw err;
		if (isDev) console.error("Metadata load error:", err);
		else console.error("Metadata load error:", (err as Error).message ?? err);
		if (isDev) reportDevErrorFromCatch(err);
	}
	return null;
}

type MetadataOutcome = { meta: Metadata | null } | { err: unknown };

/**
 * Start `metadata()` without waiting for it. `outcome` never rejects — the
 * caller decides what a failure means. `data` is what the page load receives
 * as `metadata`: it rejects on a Redirect/HttpError, so the page load does not
 * run for a response that metadata() already decided, and is null on any other
 * failure (the page renders without metadata, as before).
 */
export function startMetadata(
	route: any,
	params: Record<string, string>,
	url: URL,
	locals: Record<string, any>,
	cookies: Cookies,
	req: Request,
): { outcome: Promise<MetadataOutcome>; data: Promise<Record<string, any> | null> } {
	const outcome = loadMetadata(route, params, url, locals, cookies, req).then(
		(meta): MetadataOutcome => ({ meta }),
		(err): MetadataOutcome => ({ err }),
	);
	const data = outcome.then((o) => {
		if ("meta" in o) return o.meta?.data ?? null;
		if (isRedirect(o.err) || isHttpError(o.err)) throw METADATA_DECIDED;
		return null;
	});
	data.catch(noop);
	return { outcome, data };
}

// ─── Streaming SSR Renderer ──────────────────────────────

export async function renderSSRStream(
	url: URL,
	locals: Record<string, any>,
	req: Request,
	cookies: Cookies,
	match?: RouteMatch<(typeof serverRoutes)[number]> | null,
): Promise<Response | null> {
	match ??= findMatch(serverRoutes, url.pathname);
	if (!match) return null;

	const { route, params } = match;
	const nonce = CSP_ENABLED && typeof locals.nonce === "string" ? locals.nonce : undefined;

	// ── Response cache: short-circuit on hit ──
	// Look up cached HTML before doing anything expensive (metadata, load,
	// render, compress). Key includes URL + identity hash (cookies/headers
	// from CACHE_KEYS), so per-user pages stay isolated. Routes opt out via
	// `export const cache = false`. See cache.ts and docs/guides/response-cache.md.
	const cacheBypass = url.searchParams.has("_invalidated");
	// `route.cache` is the build-time static read of `export const cache` in
	// +page.svelte, letting a cache hit skip the page-module import entirely:
	//   true  → cacheable, false → opted out, null → import to read the real value.
	let pageMod: any = null;
	const staticCache = (route as any).cache as boolean | null | undefined;
	let routeCacheable: boolean;
	if (staticCache === true || staticCache === false) {
		routeCacheable = staticCache;
	} else {
		pageMod = await route.pageModule();
		routeCacheable = pageMod.cache !== false;
	}
	// CSP is incompatible with response cache — the per-request nonce is baked
	// into the cached HTML but the CSP header is re-derived each request, so a
	// cached page would ship with a dead nonce and the browser would block its
	// inline scripts. Operators who turn on CSP_DIRECTIVES forfeit the cache.
	const cacheable =
		CACHE_ENABLED && !CSP_ENABLED && !warmingUp && routeCacheable && req.method === "GET";
	let cacheKey: string | null = null;
	let releaseMiss: (() => void) | null = null;
	if (cacheable) {
		cacheKey = computeCacheKey(url, req, cookies as CookieJar);
		if (!cacheBypass) {
			const hit = cacheGet(cacheKey);
			if (hit) return serveCached(hit, req);
			// Miss coalescing: the first miss leads the build; concurrent misses
			// wait, then re-check the cache. A waiter that still misses (leader
			// skipped the write) builds independently — no re-leadering.
			const gate = coalesceMiss(cacheKey);
			if (gate.wait) {
				await gate.wait;
				const rehit = cacheGet(cacheKey);
				if (rehit) return serveCached(rehit, req);
			} else {
				releaseMiss = gate.release;
			}
		}
	}

	// INVARIANT: releaseMiss must fire exactly once — a missed release() hangs
	// coalesced waiters for the process lifetime. Every early return and throw
	// below must stay inside this try; the cache-write path hands the release
	// off to its deferred cacheSet by nulling releaseMiss first.
	try {
		// ── Pre-stream phase: metadata() + load() + module imports, all at once ──
		// Nothing is committed until every one has settled, so a Redirect or
		// HttpError from any of them still gets a proper response.
		const meta = startMetadata(route, params, url, locals, cookies, req);
		const loaderCookies = new LoaderCookies(cookies);
		// pageMod is already loaded when the cache flag was unknown; otherwise
		// fold its import into this parallel block instead of a serial await.
		const routeData = loadRouteData(
			url,
			locals,
			req,
			cookies,
			meta.data,
			match,
			undefined,
			undefined,
			loaderCookies,
		);
		const loading = Promise.all([
			routeData,
			Promise.all(route.layoutModules.map((l: () => Promise<any>) => l())),
			pageMod ?? route.pageModule(),
		]);
		// Awaited only after the metadata outcome, which may return first.
		loading.catch(noop);

		// metadata() outcome first: it decided the response before the loaders
		// ran, and still does — their cookie writes are withdrawn with it.
		let metadata: Metadata | null = null;
		const metaOutcome = await meta.outcome;
		if ("meta" in metaOutcome) metadata = metaOutcome.meta;
		else {
			loaderCookies.discard();
			const err = metaOutcome.err;
			if (isRedirect(err)) {
				// Not Response.redirect(): it rejects relative URLs on Workers.
				return new Response(null, { status: err.status, headers: { Location: err.location } });
			}
			if (isHttpError(err)) {
				return renderErrorPage(
					err.status,
					err.message,
					url,
					req,
					route,
					undefined,
					undefined,
					undefined,
					nonce,
				);
			}
			if (isDev) console.error("Metadata load error:", err);
			else console.error("Metadata load error:", (err as Error).message ?? err);
			if (isDev) reportDevErrorFromCatch(err);
			// Continue with null metadata — don't break the page for a metadata failure
		}

		let data: Awaited<ReturnType<typeof loadRouteData>>;
		let layoutMods: any[];

		try {
			let pm: any;
			[data, layoutMods, pm] = await loading;
			pageMod = pm;
			loaderCookies.commit();
		} catch (err) {
			// A module import can fail first, while loaders still run: commit only
			// once loadRouteData has decided which loaders' writes stand.
			await routeData.catch(noop);
			loaderCookies.commit();
			if (isRedirect(err))
				return new Response(null, { status: err.status, headers: { Location: err.location } });
			if (isHttpError(err)) {
				const e = err as HttpError & {
					errorDepth?: number;
					errorOrigin?: ErrorOrigin;
					partialLayoutData?: Record<string, any>[];
				};
				return renderErrorPage(
					err.status,
					err.message,
					url,
					req,
					route,
					e.errorDepth,
					e.errorOrigin,
					e.partialLayoutData,
					nonce,
				);
			}
			if (isDev) console.error("SSR load error:", err);
			else console.error("SSR load error:", (err as Error).message ?? err);
			if (isDev) reportDevErrorFromCatch(err);
			return renderErrorPage(
				500,
				"Internal Server Error",
				url,
				req,
				route,
				undefined,
				undefined,
				undefined,
				nonce,
			);
		}

		if (!data)
			return renderErrorPage(
				404,
				"Not Found",
				url,
				req,
				undefined,
				undefined,
				undefined,
				undefined,
				nonce,
			);

		const renderCtx: RenderContext = {
			request: req,
			url,
			route: { pattern: route.pattern },
			metadata,
		};
		const [headExtras, bodyEndExtras] = await Promise.all([
			pluginRenderFragments("head", renderCtx),
			pluginRenderFragments("bodyEnd", renderCtx),
		]);

		// SSR always runs every loader, so coerce types from the optional sparse shape.
		const layoutDataFull = (data.layoutData as Record<string, any>[]).map((d) => d ?? {});
		const pageDataFull = data.pageData ?? {};

		// ssr=false → no render() needed; ship shell + hydration as a single response.
		// ssr=false && csr=false is meaningless (nothing renders) — force csr=true.
		if (!data.ssr) {
			if (!data.csr && isDev) {
				console.warn(
					`⚠️  ${url.pathname}: ssr=false && csr=false renders nothing — forcing csr=true`,
				);
			}
			const html =
				buildHtmlShellOpen(metadata?.lang, nonce, appHtmlSegments, route.pattern) +
				buildMetadataChunk(metadata, headExtras, appHtmlSegments) +
				buildHtmlTail(
					"",
					"",
					pageDataFull,
					layoutDataFull,
					true,
					null,
					false,
					bodyEndExtras,
					nonce,
					data.pageDeps,
					data.layoutDeps,
					appHtmlSegments,
				);
			return compress(html, "text/html; charset=utf-8", req, 200, data.loaderHeaders);
		}

		// Render-first: run render() before committing to a 200. Failure → proper error page
		// with correct status code, instead of a bare <p> mixed into an already-flushed shell.
		let body: string, head: string;
		try {
			({ body, head } = renderWithPageContext(
				App,
				{
					props: {
						ssrMode: true,
						ssrPageComponent: pageMod.default,
						ssrLayoutComponents: layoutMods.map((m: any) => m.default),
						ssrPageData: pageDataFull,
						ssrLayoutData: layoutDataFull,
					},
				},
				url,
			));
		} catch (err) {
			if (isDev) console.error("SSR render error:", err);
			else console.error("SSR render error:", (err as Error).message ?? err);
			if (isDev) reportDevErrorFromCatch(err);
			// Render-phase errors fall through to deepest boundary like a page error.
			return renderErrorPage(
				500,
				"Internal Server Error",
				url,
				req,
				route,
				route.layoutModules.length,
				"page",
				layoutDataFull,
				nonce,
			);
		}

		// Every chunk is built before the first byte, so the body goes out whole and
		// compressed — a stream here never streamed, it only skipped compression.
		// Truly progressive SSR (ROADMAP) would pipe a stream through
		// CompressionStream instead.
		const fullBody = enc.encode(
			buildHtmlShellOpen(
				metadata?.lang,
				nonce,
				appHtmlSegments,
				data.csr ? route.pattern : undefined,
			) +
				buildMetadataChunk(metadata, headExtras, appHtmlSegments) +
				buildHtmlTail(
					body,
					head,
					pageDataFull,
					layoutDataFull,
					data.csr,
					null,
					true,
					bodyEndExtras,
					nonce,
					data.pageDeps,
					data.layoutDeps,
					appHtmlSegments,
				),
		) as Uint8Array<ArrayBuffer>;
		// Set only on a cache write: the client's variant, encoded once at cache
		// quality and shared by the response and the cache entry.
		let sent: Encoded | null | undefined;

		// ── Response cache: write after the response has gone out ──
		// Skip if the handler set cookies — cached response can't reproduce
		// per-request Set-Cookie headers. deferCacheWrite runs the variant
		// compression after this response is flushed, not ahead of it.
		if (cacheable && cacheKey && (cookies as any).outgoing?.length === 0) {
			// Oversized bodies skip early so they never pay compression; cacheSet
			// re-checks as the authoritative guard.
			if (CACHE_MAX_BODY_BYTES === 0 || fullBody.length <= CACHE_MAX_BODY_BYTES) {
				const tags = collectTags(data.layoutDeps ?? null, data.pageDeps ?? null);
				const keyForWrite = cacheKey;
				// Hand the gate release to the deferred write: waiters resume only
				// after cacheSet ran, so their re-check hits.
				const rel = releaseMiss;
				releaseMiss = null;
				const encoded = encodeForRequest(fullBody, req, "cache");
				sent = encoded;
				deferCacheWrite(() => {
					try {
						const { gzip, brotli } = buildCompressedVariants(
							fullBody,
							encoded?.enc === "br"
								? { brotli: encoded.encoded }
								: encoded
									? { gzip: encoded.encoded }
									: {},
						);
						cacheSet(
							keyForWrite,
							{
								raw: fullBody,
								gzip,
								brotli,
								contentType: "text/html; charset=utf-8",
								status: 200,
								extraHeaders: data.loaderHeaders,
								tags,
							},
							cookies,
						);
					} finally {
						rel?.();
					}
				});
			}
		}

		return compressBytes(fullBody, "text/html; charset=utf-8", req, 200, data.loaderHeaders, sent);
	} finally {
		releaseMiss?.();
	}
}

// ─── Form Action Page Renderer ───────────────────────────
// Re-runs load functions after a form action, renders with form data.
// Uses non-streaming buildHtml so we can control the status code. Resolves
// metadata() here too — the GET path's title, meta/link tags, lang and
// metadata.data must survive a submit, or the page changes under the user.

export async function renderPageWithFormData(
	url: URL,
	locals: Record<string, any>,
	req: Request,
	cookies: Cookies,
	formData: any,
	status: number,
	match?: RouteMatch<(typeof serverRoutes)[number]> | null,
): Promise<Response> {
	const nonce = CSP_ENABLED && typeof locals.nonce === "string" ? locals.nonce : undefined;
	match ??= findMatch(serverRoutes, url.pathname);
	if (!match)
		return renderErrorPage(
			404,
			"Not Found",
			url,
			req,
			undefined,
			undefined,
			undefined,
			undefined,
			nonce,
		);

	const { route, params } = match;

	// metadata(), loaders and module imports all start now; only the page load
	// waits for metadata.data. The metadata outcome is still handled first.
	const meta = startMetadata(route, params, url, locals, cookies, req);
	const loaderCookies = new LoaderCookies(cookies);
	const routeData = loadRouteData(
		url,
		locals,
		req,
		cookies,
		meta.data,
		match,
		undefined,
		undefined,
		loaderCookies,
	);
	const loading = Promise.all([
		routeData,
		route.pageModule(),
		Promise.all(route.layoutModules.map((l: () => Promise<any>) => l())),
	]);
	loading.catch(noop);

	let metadata: Metadata | null = null;
	const metaOutcome = await meta.outcome;
	if ("meta" in metaOutcome) metadata = metaOutcome.meta;
	else {
		loaderCookies.discard();
		const err = metaOutcome.err;
		if (isRedirect(err))
			return new Response(null, { status: err.status, headers: { Location: err.location } });
		if (isHttpError(err)) {
			return renderErrorPage(
				err.status,
				err.message,
				url,
				req,
				route,
				undefined,
				undefined,
				undefined,
				nonce,
			);
		}
		if (isDev) console.error("Metadata load error:", err);
		else console.error("Metadata load error:", (err as Error).message ?? err);
		if (isDev) reportDevErrorFromCatch(err);
		// Continue with null metadata — don't break the page for a metadata failure
	}

	let loaded: Awaited<typeof loading>;
	try {
		loaded = await loading;
	} finally {
		// See renderSSRStream: a failed import must not commit ahead of the loaders.
		await routeData.catch(noop);
		loaderCookies.commit();
	}
	const [data, pageMod, layoutMods] = loaded;

	if (!data)
		return renderErrorPage(
			404,
			"Not Found",
			url,
			req,
			undefined,
			undefined,
			undefined,
			undefined,
			nonce,
		);

	const renderCtx: RenderContext = {
		request: req,
		url,
		route: { pattern: route.pattern },
		metadata,
	};
	const [headExtras, bodyEndExtras] = await Promise.all([
		pluginRenderFragments("head", renderCtx),
		pluginRenderFragments("bodyEnd", renderCtx),
	]);
	// buildHtml has no headExtras slot; fold them in ahead of the SSR head, which
	// is where buildMetadataChunk puts them on the streaming path.
	const headWithExtras = (ssrHead: string) => {
		const extras = headExtras.filter(Boolean);
		return extras.length ? `${extras.join("\n  ")}\n  ${ssrHead}` : ssrHead;
	};

	// Form-action re-render always runs every loader (no client mask).
	const layoutDataFull = (data.layoutData as Record<string, any>[]).map((d) => d ?? {});
	const pageDataFull = data.pageData ?? {};

	if (!data.ssr) {
		if (!data.csr && isDev) {
			console.warn(
				`⚠️  ${url.pathname}: ssr=false && csr=false renders nothing — forcing csr=true`,
			);
		}
		const html = buildHtml(
			"",
			headWithExtras(""),
			pageDataFull,
			layoutDataFull,
			true,
			formData,
			metadata?.lang,
			false,
			nonce,
			data.pageDeps,
			data.layoutDeps,
			bodyEndExtras,
			appHtmlSegments,
			metadata,
			route.pattern,
		);
		return compress(html, "text/html; charset=utf-8", req, status, data.loaderHeaders);
	}

	const { body, head } = renderWithPageContext(
		App,
		{
			props: {
				ssrMode: true,
				ssrPageComponent: pageMod.default,
				ssrLayoutComponents: layoutMods.map((m: any) => m.default),
				ssrPageData: pageDataFull,
				ssrLayoutData: layoutDataFull,
				ssrFormData: formData,
			},
		},
		url,
	);

	const html = buildHtml(
		body,
		headWithExtras(head),
		pageDataFull,
		layoutDataFull,
		data.csr,
		formData,
		metadata?.lang,
		true,
		nonce,
		data.pageDeps,
		data.layoutDeps,
		bodyEndExtras,
		appHtmlSegments,
		metadata,
		route.pattern,
	);
	return compress(html, "text/html; charset=utf-8", req, status, data.loaderHeaders);
}

// ─── Error Page Renderer ──────────────────────────────────
// 1. If a route is known, try the nearest nested +error.svelte and render
//    it inside the matching prefix of the layout chain.
// 2. Otherwise fall back to the global root +error.svelte.
// 3. Otherwise return a plain-text response.

export async function renderErrorPage(
	status: number,
	message: string,
	url: URL,
	req: Request,
	route?: any,
	errorDepth?: number,
	errorOrigin?: ErrorOrigin,
	partialLayoutData?: (Record<string, any> | null)[],
	nonce?: string,
): Promise<Response> {
	// Strip the nonce from emitted scripts when CSP is off — the attribute
	// is dead bytes without a matching policy header.
	if (!CSP_ENABLED) nonce = undefined;

	// The route's own metadata() is deliberately NOT run here — the route may be
	// what failed, and a 404 has no route at all. Synthesize a status title only
	// when the error component didn't set one, so <svelte:head><title> in a custom
	// +error.svelte still wins.
	const errMeta = (head: string): Metadata | null =>
		head.includes("<title>") ? null : { title: `${status} — ${message}` };

	// Inspector overlay and other plugin bodyEnd fragments must be injected
	// on error pages too — otherwise SSE never connects and runtime errors
	// from the failing render are invisible in the UI.
	const renderCtx: RenderContext = {
		request: req,
		url,
		route: route ? { pattern: route.pattern } : { pattern: "" },
		metadata: errMeta(""),
	};
	const bodyEndExtras = await pluginRenderFragments("bodyEnd", renderCtx);

	// The failing route's own params, so +error.svelte (and the layouts wrapping
	// a nested one) under /blog/[slug] get `params.slug`. A 404 matches nothing
	// and yields {}.
	const errorParams = findMatch(serverRoutes, url.pathname)?.params ?? {};

	// 1. Nested boundary
	if (route && errorDepth !== undefined && route.errorPages?.length) {
		const origin = errorOrigin ?? "page";
		const picked = pickErrorPage<() => Promise<any>>(
			route.errorPages as { loader: () => Promise<any>; depth: number }[],
			errorDepth,
			origin,
		);
		if (picked) {
			try {
				const K = picked.depth;
				const [errorMod, layoutMods] = await Promise.all([
					picked.loader(),
					Promise.all(route.layoutModules.slice(0, K).map((l: () => Promise<any>) => l())),
				]);
				const layoutData: Record<string, any>[] = [];
				for (let i = 0; i < K; i++) layoutData.push(partialLayoutData?.[i] ?? {});
				const { body, head } = renderWithPageContext(
					App,
					{
						props: {
							ssrMode: true,
							ssrLayoutComponents: layoutMods.map((m: any) => m.default),
							ssrLayoutData: layoutData,
							ssrErrorComponent: errorMod.default,
							ssrErrorProps: { error: { status, message } },
							ssrErrorDepth: K,
							ssrPageData: { params: errorParams },
						},
					},
					url,
				);
				// csr=false: no client hydration on the error page itself.
				const html = buildHtml(
					body,
					head,
					{ status, message },
					layoutData,
					false,
					null,
					undefined,
					true,
					nonce,
					null,
					null,
					bodyEndExtras,
					appHtmlSegments,
					errMeta(head),
				);
				return compress(html, "text/html; charset=utf-8", req, status);
			} catch (err) {
				if (isDev) console.error("Nested error page render failed:", err);
				else console.error("Nested error page render failed:", (err as Error).message ?? err);
				if (isDev) reportDevErrorFromCatch(err);
				// fall through to global / text fallback
			}
		}
	}

	// 2. Global root error page
	if (errorPage) {
		try {
			const mod = await errorPage();
			// Render the error component directly — NOT through App.svelte.
			// App.svelte remaps ssrPageData to a `data` prop, but +error.svelte
			// expects `error` as a direct prop: `let { error } = $props()`.
			const { body, head } = renderWithPageContext(
				mod.default,
				{ props: { error: { status, message }, params: errorParams } },
				url,
			);
			const html = buildHtml(
				body,
				head,
				{ status, message },
				[],
				false,
				null,
				undefined,
				true,
				nonce,
				null,
				null,
				bodyEndExtras,
				appHtmlSegments,
				errMeta(head),
			);
			return compress(html, "text/html; charset=utf-8", req, status);
		} catch (err) {
			if (isDev) console.error("Error page render failed:", err);
			else console.error("Error page render failed:", (err as Error).message ?? err);
			if (isDev) reportDevErrorFromCatch(err);
		}
	}
	// Dev: render an HTML 500 page that subscribes to /__bosia/sse so the browser
	// auto-reloads the moment the next build succeeds. Without this the user stares
	// at "Internal Server Error" forever even after fixing the source. Pass the
	// already-computed bodyEndExtras so the inspector overlay (red error badge,
	// pre-seeded buffered errors) stays attached even on this bare-fallback path.
	if (isDev) {
		return dev500Response({ request: req, status, message, bodyEndExtras });
	}
	return new Response(message, {
		status,
		headers: { "Content-Type": "text/plain; charset=utf-8" },
	});
}
