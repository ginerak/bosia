import { describe, expect, test } from "bun:test";
import { CookieJar } from "../src/core/cookies.ts";
import { LoaderCookies } from "../src/core/loaderCookies.ts";
import type { Cookies } from "../src/core/hooks.ts";

const names = (jar: CookieJar) => jar.outgoing.map((h) => h.split(";")[0]);

describe("LoaderCookies", () => {
	test("commits in loader order, not the order the writes happened", () => {
		const jar = new CookieJar("");
		const lc = new LoaderCookies(jar);
		lc.writer(1).set("theme", "light"); // page finishes first
		lc.writer(0).set("theme", "dark"); // layout later
		expect(jar.outgoing).toHaveLength(0);
		lc.commit();
		// Serial order: the deeper loader's header comes last and wins.
		expect(names(jar)).toEqual(["theme=dark", "theme=light"]);
	});

	test("keepOnlyBelow drops deeper loaders, writes after commit are dropped", () => {
		const jar = new CookieJar("");
		const lc = new LoaderCookies(jar);
		lc.writer(0).set("a", "1");
		lc.writer(1).set("b", "1");
		lc.keepOnlyBelow(1);
		lc.writer(1).set("c", "1");
		lc.commit();
		lc.writer(0).set("late", "1"); // a timed-out loader resuming
		expect(names(jar)).toEqual(["a=1"]);
	});

	test("discard drops everything", () => {
		const jar = new CookieJar("");
		const lc = new LoaderCookies(jar);
		lc.writer(0).set("a", "1");
		lc.discard();
		lc.commit();
		expect(jar.outgoing).toHaveLength(0);
	});

	test("an invalid cookie still throws inside the loader", () => {
		const lc = new LoaderCookies(new CookieJar(""));
		expect(() => lc.writer(0).set("bad name", "1")).toThrow(/Invalid cookie name/);
	});

	test("a wrapped (non-CookieJar) Cookies gets its calls replayed at commit", () => {
		const calls: string[] = [];
		const wrapped: Cookies = {
			get: () => undefined,
			getAll: () => ({}),
			set: (n, v) => void calls.push(`set ${n}=${v}`),
			delete: (n) => void calls.push(`delete ${n}`),
		};
		const lc = new LoaderCookies(wrapped);
		lc.writer(1).set("b", "2");
		lc.writer(0).delete("a");
		lc.writer(2).set("x", "1");
		lc.keepOnlyBelow(2);
		expect(calls).toEqual([]);
		lc.commit();
		expect(calls).toEqual(["delete a", "set b=2"]);
	});
});

describe("LoaderCookies with a wrapped CookieJar", () => {
	test("a Proxy that overrides set() still has its override run", () => {
		const jar = new CookieJar("");
		const wrapped = new Proxy(jar, {
			get(target, prop, receiver) {
				if (prop === "set") {
					return (n: string, v: string, o?: object) =>
						target.set(n, v, { ...o, domain: "example.com" });
				}
				const value = Reflect.get(target, prop, receiver);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const lc = new LoaderCookies(wrapped);
		lc.writer(0).set("session", "1");
		lc.commit();
		expect(jar.outgoing[0]).toContain("Domain=example.com");
	});

	test("a subclass that overrides set() still has its override run", () => {
		class Prefixed extends CookieJar {
			override set(n: string, v: string, o?: object) {
				super.set(`app_${n}`, v, o);
			}
		}
		const jar = new Prefixed("");
		const lc = new LoaderCookies(jar);
		lc.writer(0).set("session", "1");
		lc.commit();
		expect(jar.outgoing[0]).toStartWith("app_session=1");
	});
});

test("a replayed write that throws is dropped; the rest still commit", () => {
	const calls: string[] = [];
	const wrapped: Cookies = {
		get: () => undefined,
		getAll: () => ({}),
		set: (n) => {
			if (n === "bad") throw new Error("rejected by wrapper");
			calls.push(n);
		},
		delete: () => {},
	};
	const lc = new LoaderCookies(wrapped);
	lc.writer(0).set("bad", "1");
	lc.writer(1).set("good", "1");
	const errors: unknown[] = [];
	const orig = console.error;
	console.error = (...a: unknown[]) => void errors.push(a);
	try {
		expect(() => lc.commit()).not.toThrow();
	} finally {
		console.error = orig;
	}
	expect(calls).toEqual(["good"]);
	expect(errors).toHaveLength(1);
});

test("a replayed write uses the options as they were at the call", () => {
	const seen: Array<object | undefined> = [];
	const wrapped: Cookies = {
		get: () => undefined,
		getAll: () => ({}),
		set: (_n, _v, o) => void seen.push(o),
		delete: () => {},
	};
	const lc = new LoaderCookies(wrapped);
	const o: { path: string; maxAge?: number } = { path: "/" };
	lc.writer(0).set("a", "1", o);
	o.maxAge = 0;
	lc.commit();
	expect(seen).toEqual([{ path: "/" }]);
});
