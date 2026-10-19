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
