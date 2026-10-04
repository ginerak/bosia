import { describe, expect, test } from "bun:test";
import { LoadTimeoutError, runLoaderChain, timedLoad } from "../src/core/loaderChain.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("runLoaderChain()", () => {
	test("layers that don't call parent() run concurrently", async () => {
		const started: number[] = [];
		const t0 = performance.now();
		const settled = await runLoaderChain(
			[0, 1, 2, 3].map((i) => async () => {
				started.push(i);
				await sleep(40);
				return { [`l${i}`]: i };
			}),
		);
		const elapsed = performance.now() - t0;
		expect(started).toEqual([0, 1, 2, 3]);
		expect(settled.every((s) => s.status === "fulfilled")).toBe(true);
		// Four 40ms layers back to back would take 160ms.
		expect(elapsed).toBeLessThan(120);
	});

	test("parent() merges every ancestor in order, nearer layers winning", async () => {
		let seen: Record<string, any> | null = null;
		await runLoaderChain([
			async () => {
				await sleep(20);
				return { a: 1, shared: "root" };
			},
			async () => ({ b: 2, shared: "group" }),
			async (parent) => {
				seen = await parent();
				return {};
			},
		]);
		expect(seen!).toEqual({ a: 1, b: 2, shared: "group" });
	});

	test("parent() never includes the layer's own or later layers' data", async () => {
		let rootParent: Record<string, any> | null = null;
		await runLoaderChain([
			async (parent) => {
				rootParent = await parent();
				return { root: true };
			},
			async () => ({ child: true }),
		]);
		expect(rootParent!).toEqual({});
	});

	test("a layer awaiting parent() sees an ancestor's failure", async () => {
		const boom = new Error("boom");
		const settled = await runLoaderChain([
			async () => {
				throw boom;
			},
			async (parent) => {
				await parent();
				return {};
			},
		]);
		expect(settled[0]).toEqual({ status: "rejected", reason: boom });
		expect(settled[1]).toEqual({ status: "rejected", reason: boom });
	});

	test("a synchronous throw lands in the layer's own slot", async () => {
		const settled = await runLoaderChain([
			async () => ({ ok: true }),
			() => {
				throw new Error("sync");
			},
		]);
		expect(settled[0]!.status).toBe("fulfilled");
		expect(settled[1]!.status).toBe("rejected");
	});

	test("calling parent() without awaiting it does not leak an unhandled rejection", async () => {
		let unhandled = 0;
		const onUnhandled = () => unhandled++;
		process.on("unhandledRejection", onUnhandled);
		try {
			await runLoaderChain([
				async () => {
					throw new Error("root failed");
				},
				async (parent) => {
					void parent();
					return {};
				},
			]);
			await sleep(10);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
		expect(unhandled).toBe(0);
	});
});

describe("timedLoad()", () => {
	test("rejects with LoadTimeoutError when the loader runs too long", async () => {
		const run = timedLoad(
			async () => ({}),
			30,
			"page load (/x)",
			() => sleep(100),
		);
		await expect(run).rejects.toBeInstanceOf(LoadTimeoutError);
	});

	test("time spent waiting for parent() doesn't count against the loader", async () => {
		// Parent takes 40ms, the loader's own work 40ms: 80ms total, but each
		// part is within a 60ms budget, as it was when layers ran in sequence.
		const slowParent = async () => {
			await sleep(40);
			return { a: 1 };
		};
		const result = await timedLoad(slowParent, 60, "layout load", async (parent) => {
			const data = await parent();
			await sleep(40);
			return data;
		});
		expect(result).toEqual({ a: 1 });
	});

	test("ms <= 0 disables the limit", async () => {
		const result = await timedLoad(
			async () => ({}),
			0,
			"x",
			async () => "done",
		);
		expect(result).toBe("done");
	});
});
