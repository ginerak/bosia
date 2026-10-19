import type { Cookies } from "./hooks.ts";
import { CookieJar } from "./cookies.ts";

/**
 * The cookie jar as the loaders see it, one writer per loader (layout index,
 * page = layout count). Loaders run concurrently, so writes are buffered and
 * committed in loader order once the outcome is known — the order a serial
 * run produced, so the deeper loader's Set-Cookie still comes last and wins.
 * A loader that was overruled (deeper than a failing layer, or every loader
 * when metadata() decided the response) never commits: serially it never ran.
 * Writes after the commit — a loader still running past its timeout — are
 * dropped.
 *
 * With a CookieJar, headers are built (and validated) at the call, so an
 * invalid cookie still throws inside the loader. Any other Cookies object (a
 * hook may wrap event.cookies) has its calls replayed at commit instead, with
 * a copy of the options as they were at the call; a throw there is logged.
 */
export class LoaderCookies {
	private buffered = new Map<number, Array<string | (() => void)>>();
	private keepBelow = Infinity;
	private done = false;

	constructor(private jar: Cookies) {}

	writer(index: number): Cookies {
		const jar = this.jar;
		// Only a plain CookieJar takes the serialize fast path. A wrapper — a Proxy,
		// a subclass or object overriding set/delete — has its own calls replayed,
		// so its overrides still run.
		const plain =
			jar instanceof CookieJar &&
			jar.set === CookieJar.prototype.set &&
			jar.delete === CookieJar.prototype.delete;
		const serialize = plain ? jar.serialize.bind(jar) : undefined;
		const buffer = (op: string | (() => void)) => {
			if (this.done || index >= this.keepBelow) return;
			let ops = this.buffered.get(index);
			if (!ops) this.buffered.set(index, (ops = []));
			ops.push(op);
		};
		return {
			get: (name) => jar.get(name),
			getAll: () => jar.getAll(),
			set: (name, value, options) => {
				if (serialize) return buffer(serialize(name, value, options));
				// Copied now: the loader may change its options object after the call.
				const opts = options && { ...options };
				buffer(() => jar.set(name, value, opts));
			},
			delete: (name, options) => {
				if (serialize) return buffer(serialize(name, "", { ...options, maxAge: 0 }));
				const opts = options && { ...options };
				buffer(() => jar.delete(name, opts));
			},
		};
	}

	/** Only loaders below `index` will commit (a failure at `index - 1`). */
	keepOnlyBelow(index: number): void {
		this.keepBelow = Math.min(this.keepBelow, index);
	}

	/** Commit every kept loader's writes, in loader order. Idempotent. */
	commit(): void {
		if (this.done) return;
		this.done = true;
		const jar = this.jar as Partial<CookieJar>;
		for (const index of [...this.buffered.keys()].sort((a, b) => a - b)) {
			if (index >= this.keepBelow) continue;
			for (const op of this.buffered.get(index)!) {
				if (typeof op === "string") jar.append!([op]);
				else {
					// A wrapper's own set() may throw at replay, outside any loader. Drop
					// that one write, keep the rest: commit runs on the response path.
					try {
						op();
					} catch (err) {
						console.error("[bosia] cookies.set failed while committing loader cookies:", err);
					}
				}
			}
		}
		this.buffered.clear();
		const reports = this.reports;
		this.reports = [];
		for (const log of reports) {
			// Runs inside the caller's finally: a throw would replace the request's
			// real error and skip the logs after it.
			try {
				log();
			} catch (err) {
				console.error("[bosia] failed to report a loader error:", err);
			}
		}
	}

	/** Drop every loader's writes: something else decided the response. */
	discard(): void {
		this.done = true;
		this.overruled = true;
		this.buffered.clear();
		this.reports = [];
	}

	private overruled = false;
	private reports: Array<() => void> = [];

	/**
	 * Log a loader failure — held, like the cookies, until the outcome is known.
	 * A failure in a request metadata() then answered reaches no one, so it is
	 * dropped instead of printed as a crash (serially, that loader never ran).
	 */
	report(log: () => void): void {
		if (this.overruled) return;
		if (this.done) log();
		else this.reports.push(log);
	}
}
