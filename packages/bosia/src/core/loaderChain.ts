// ─── Loader Chain ────────────────────────────────────────
// Runs a route's layout loaders and its page loader concurrently. A loader
// only waits on its ancestors when it calls `parent()`, so loaders that don't
// need parent data overlap their I/O instead of queueing behind each other —
// three layouts and a page that each wait 20ms on a database finish in ~20ms,
// not ~80ms.
//
// Kept free of route/runtime imports so the ordering rules can be tested
// directly; renderer.ts wires real loaders into it.

export type ParentData = Record<string, any>;
export type Parent = () => Promise<ParentData>;

/** One layer of the chain, root → leaf; the page is the last layer. */
export type LoaderLayer = (parent: Parent) => Promise<ParentData>;

/**
 * Start every layer at once. Layer i's `parent()` resolves to the merged
 * contributions of layers 0..i-1 (later layers win on key collisions), or
 * rejects with the first ancestor failure. Resolves once every layer settled,
 * in layer order, so the caller can report the failure nearest the root.
 */
export function runLoaderChain(layers: LoaderLayer[]): Promise<PromiseSettledResult<ParentData>[]> {
	const results: Promise<ParentData>[] = [];
	for (const layer of layers) {
		const upstream = results.slice();
		let merged: Promise<ParentData> | undefined;
		const parent: Parent = () => {
			if (!merged) {
				merged = Promise.all(upstream).then((parts) => Object.assign({}, ...parts));
				// A loader that calls parent() without awaiting it must not turn an
				// ancestor's failure into an unhandled rejection — the ancestor's
				// own result already reports it.
				merged.catch(() => {});
			}
			return merged;
		};
		// Promise.resolve().then: a loader that throws synchronously still lands
		// in its own slot instead of escaping the loop.
		results.push(Promise.resolve().then(() => layer(parent)));
	}
	return Promise.allSettled(results);
}

export class LoadTimeoutError extends Error {
	constructor(label: string, ms: number) {
		super(`${label} timed out after ${ms}ms`);
		this.name = "LoadTimeoutError";
	}
}

/**
 * Time-limit one loader call. Waiting for `parent()` is not the loader's own
 * time: the clock restarts when the parent data arrives, so a loader keeps the
 * same budget it had when layers ran one after another. `ms <= 0` disables it.
 */
export function timedLoad<T>(
	parent: Parent,
	ms: number,
	label: string,
	call: (parent: Parent) => Promise<T>,
): Promise<T> {
	if (ms <= 0) return call(parent);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let done = false;
	let fail!: (err: unknown) => void;
	const timeout = new Promise<never>((_, reject) => (fail = reject));
	const arm = () => {
		if (done) return;
		clearTimeout(timer);
		timer = setTimeout(() => fail(new LoadTimeoutError(label, ms)), ms);
	};
	const tracked: Parent = () => {
		const p = parent();
		p.then(arm, arm);
		return p;
	};
	arm();
	const run = Promise.resolve()
		.then(() => call(tracked))
		.finally(() => {
			done = true;
			clearTimeout(timer);
		});
	return Promise.race([run, timeout]);
}
