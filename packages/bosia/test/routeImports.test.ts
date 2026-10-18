import { describe, expect, test } from "bun:test";
import { memoizeImport, memoizeRouteImports } from "../src/core/routeImports.ts";

describe("memoizeImport", () => {
	test("runs the importer once and returns the same promise", async () => {
		let calls = 0;
		const memo = memoizeImport(async () => ({ n: ++calls }));
		const a = memo();
		expect(memo()).toBe(a);
		expect(await a).toEqual({ n: 1 });
		expect(await memo()).toEqual({ n: 1 });
		expect(calls).toBe(1);
	});

	test("a rejected import is retried on the next call", async () => {
		let calls = 0;
		const memo = memoizeImport(async () => {
			if (++calls === 1) throw new Error("boom");
			return "ok";
		});
		await expect(memo()).rejects.toThrow("boom");
		expect(await memo()).toBe("ok");
		expect(calls).toBe(2);
	});

	test("wrapping twice is a no-op", () => {
		const memo = memoizeImport(async () => 1);
		expect(memoizeImport(memo)).toBe(memo);
	});
});

describe("memoizeRouteImports", () => {
	test("wraps every importer in the route tables", async () => {
		let calls = 0;
		const imp = () => async () => ({ id: ++calls });
		const api = [{ module: imp() }];
		const server = [
			{
				pageModule: imp(),
				layoutModules: [imp(), imp()],
				pageServer: imp(),
				layoutServers: [{ loader: imp(), depth: 0 }],
				errorPages: [{ loader: imp(), depth: 0 }],
			},
			{
				pageModule: imp(),
				layoutModules: [],
				pageServer: null,
				layoutServers: [],
				errorPages: [],
			},
		];
		memoizeRouteImports(api, server);
		const r = server[0]!;
		const all = [
			api[0]!.module,
			r.pageModule,
			...r.layoutModules,
			r.pageServer!,
			r.layoutServers[0]!.loader,
			r.errorPages[0]!.loader,
			server[1]!.pageModule,
		];
		for (const fn of all) await fn();
		for (const fn of all) await fn();
		expect(calls).toBe(all.length);
		expect(server[1]!.pageServer).toBeNull();
	});
});
