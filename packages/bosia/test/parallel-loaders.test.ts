import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";

import { getEphemeralPort } from "../src/core/prerender.ts";
import { BOSIA_NODE_PATH } from "../src/core/paths.ts";

// Loaders used to run root → leaf one at a time, with metadata() before all of
// them. Now every loader starts at once and parent() is what orders them;
// metadata() runs alongside, and only the page load waits for its data. Static
// files are answered before the user's handle hook.
//
// Each loader reports when it started, so overlap is asserted from the
// server's own clock rather than from wall time on a busy CI box.

let tmpDir: string;
let child: Bun.Subprocess | null = null;
let origin: string;

const SLEEP = 200;

beforeAll(async () => {
	tmpDir = join(import.meta.dir, "..", `.tmp-parallel-loaders-${Date.now()}`);
	const routes = join(tmpDir, "src", "routes");
	const par = join(routes, "par");
	mkdirSync(par, { recursive: true });
	mkdirSync(join(routes, "count"), { recursive: true });
	mkdirSync(join(routes, "feed.txt"), { recursive: true });
	mkdirSync(join(routes, "shared"), { recursive: true });
	mkdirSync(join(tmpDir, "public"), { recursive: true });

	writeFileSync(join(tmpDir, "tsconfig.json"), JSON.stringify({ compilerOptions: { paths: {} } }));
	writeFileSync(join(tmpDir, "src", "app.css"), `@import "tailwindcss";\n@source "../src";\n`);
	writeFileSync(
		join(tmpDir, "src", "app.html"),
		`<!doctype html>\n<html lang="%bosia.lang%">\n<head>%bosia.head%</head>\n<body>%bosia.body%</body>\n</html>\n`,
	);
	writeFileSync(join(tmpDir, "public", "hello.txt"), "hello from public\n");

	const stats = `(globalThis.__stats ??= { pageLoads: 0, hooks: [] })`;

	writeFileSync(
		join(tmpDir, "src", "hooks.server.ts"),
		`import type { Handle } from "bosia";\n` +
			`const embed = new Response(null, { status: 204, headers: { "x-bosia-no-frame-guard": "1" } });\n` +
			`const plainShared = new Response(null, { status: 204, headers: { "x-own": "1" } });\n` +
			`export const handle: Handle = async ({ event, resolve }) => {\n` +
			`\t${stats}.hooks.push(event.url.pathname);\n` +
			`\tif (event.url.pathname === "/embed") return embed;\n` +
			`\tif (event.url.pathname === "/plain-shared") return plainShared;\n` +
			`\treturn resolve(event);\n` +
			`};\n`,
	);

	writeFileSync(join(routes, "+page.svelte"), `<h1>Home</h1>\n`);
	writeFileSync(join(routes, "+error.svelte"), `<h1>Error page</h1>\n`);
	writeFileSync(
		join(routes, "+layout.svelte"),
		`<script>let { children } = $props();</script>\n{@render children()}\n`,
	);
	writeFileSync(
		join(routes, "+layout.server.ts"),
		`import { error, redirect } from "bosia";\n` +
			`export async function load({ url, cookies }) {\n` +
			`\tconst rootStart = Date.now();\n` +
			`\tawait Bun.sleep(${SLEEP});\n` +
			`\tif (url.searchParams.has("order")) cookies.set("theme", "dark");\n` +
			`\tif (url.searchParams.has("boom-root")) throw error(404, "root");\n` +
			`\tif (url.searchParams.has("guest")) throw redirect(303, "/");\n` +
			`\treturn { root: "r", rootStart };\n` +
			`}\n`,
	);
	writeFileSync(
		join(par, "+layout.svelte"),
		`<script>let { children } = $props();</script>\n{@render children()}\n`,
	);
	// Never calls parent(): must start with the root, not after it.
	writeFileSync(
		join(par, "+layout.server.ts"),
		`import { error } from "bosia";\n` +
			`export async function load({ url, cookies, parent }) {\n` +
			`\tconst innerStart = Date.now();\n` +
			`\tif (url.searchParams.has("cookie")) cookies.set("from_inner", "1");\n` +
			`\tif (url.searchParams.has("order")) cookies.set("theme", "light");\n` +
			// Starts parent() and fails before awaiting it; parent() then rejects
			// with the root's redirect. Must not crash the server.
			`\tif (url.searchParams.has("orphan")) {\n` +
			`\t\tparent();\n` +
			`\t\tthrow new Error("own failure");\n` +
			`\t}\n` +
			`\tif (url.searchParams.has("boom-inner")) throw error(403, "inner");\n` +
			`\tawait Bun.sleep(${SLEEP});\n` +
			`\treturn { innerStart };\n` +
			`}\n`,
	);
	writeFileSync(
		join(par, "+page.svelte"),
		`<script>let { data } = $props();</script>\n<h1 data-parent={data.sawParent} data-meta={data.sawMeta}>Par</h1>\n`,
	);
	writeFileSync(
		join(par, "+page.server.ts"),
		`import { redirect } from "bosia";\n` +
			`export const cache = false;\n` +
			`export async function metadata({ url }) {\n` +
			`\tconst metaStart = Date.now();\n` +
			// Instant under ?slow, so the page load's clock starts while the root
			// layout is still running and parent() really waits.
			`\tif (!url.searchParams.has("slow")) await Bun.sleep(${SLEEP});\n` +
			`\tif (url.searchParams.has("meta-redirect")) throw redirect(303, "/");\n` +
			`\treturn { title: "Par title", data: { fromMeta: "m", metaStart } };\n` +
			`}\n` +
			`export async function load({ parent, metadata, url }) {\n` +
			`\t${stats}.pageLoads++;\n` +
			`\tconst p = await parent();\n` +
			// Own work after a long parent() wait: inside LOAD_TIMEOUT on its own,
			// past it if the wait were counted too.
			`\tif (url.searchParams.has("slow")) await Bun.sleep(${SLEEP});\n` +
			`\treturn { sawParent: p.root, sawMeta: metadata?.fromMeta ?? null, metaStart: metadata?.metaStart ?? null };\n` +
			`}\n`,
	);
	writeFileSync(
		join(routes, "count", "+server.ts"),
		`export function GET() {\n\treturn Response.json(${stats});\n}\n` +
			`export const cache = false;\n`,
	);
	// One Response object returned to every request, each setting its own cookie.
	writeFileSync(
		join(routes, "shared", "+server.ts"),
		`export const cache = false;\n` +
			`const shared = new Response(null, { status: 204 });\n` +
			`export function GET({ cookies, url }) {\n` +
			`\tcookies.set("who", url.searchParams.get("who") ?? "none");\n` +
			`\treturn shared;\n` +
			`}\n`,
	);
	// A route that looks like a static file: must still win over public/ lookup.
	writeFileSync(
		join(routes, "feed.txt", "+server.ts"),
		`export const cache = false;\n` +
			`export function GET() {\n\treturn new Response("from route");\n}\n`,
	);

	const build = Bun.spawn(["bun", "run", join(import.meta.dir, "..", "src", "core", "build.ts")], {
		cwd: tmpDir,
		env: { ...process.env, NODE_ENV: "production", NODE_PATH: BOSIA_NODE_PATH },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, out, err] = await Promise.all([
		build.exited,
		new Response(build.stdout).text(),
		new Response(build.stderr).text(),
	]);
	if (code !== 0) throw new Error(`build failed (${code})\n${out}\n${err}`);

	const port = await getEphemeralPort();
	origin = `http://localhost:${port}`;
	child = Bun.spawn(["bun", "run", join(tmpDir, "dist", "server", "index.js")], {
		cwd: tmpDir,
		env: {
			...process.env,
			NODE_ENV: "production",
			PORT: String(port),
			NODE_PATH: BOSIA_NODE_PATH,
			// Root (SLEEP) + page's own work (SLEEP) > timeout > either alone.
			LOAD_TIMEOUT: String(Math.round(SLEEP * 1.5)),
			CACHE_MAX_ENTRIES: "0",
		},
		stdout: "ignore",
		stderr: "ignore",
	});

	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline) {
		try {
			if ((await fetch(`${origin}/_health`)).ok) return;
		} catch {
			/* not up yet */
		}
		await Bun.sleep(50);
	}
	throw new Error("server never became ready");
}, 180_000);

afterAll(() => {
	child?.kill();
	rmSync(tmpDir, { recursive: true, force: true });
});

const stats = async () =>
	(await (await fetch(`${origin}/count`)).json()) as { pageLoads: number; hooks: string[] };

describe("loaders run in parallel", () => {
	test("a layout that never calls parent() starts with the root, not after it", async () => {
		const res = await fetch(`${origin}/__bosia/data/par.json`);
		const body = await res.json();
		const [root, inner] = body.layoutData;
		expect(Math.abs(inner.innerStart - root.rootStart)).toBeLessThan(SLEEP / 2);
	});

	test("parent() still sees the layers above", async () => {
		const html = await (await fetch(`${origin}/par`)).text();
		expect(html).toContain(`data-parent="r"`);
	});

	test("the shallowest failing layer decides the error", async () => {
		const res = await fetch(`${origin}/par?boom-root&boom-inner`);
		expect(res.status).toBe(404);
	});

	test("a loader's timeout does not count its wait in parent()", async () => {
		const res = await fetch(`${origin}/par?slow`);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain(`data-parent="r"`);
	});
});

describe("metadata() runs alongside the loaders", () => {
	test("metadata starts with the root layout, and the page load gets its data", async () => {
		const body = await (await fetch(`${origin}/__bosia/data/par.json`)).json();
		expect(body.pageData.sawMeta).toBe("m");
		expect(Math.abs(body.pageData.metaStart - body.layoutData[0].rootStart)).toBeLessThan(
			SLEEP / 2,
		);
		expect(body.metadata.title).toBe("Par title");
		// metadata.data is server-only.
		expect(JSON.stringify(body.metadata)).not.toContain("fromMeta");
	});

	test("SSR renders metadata and hands its data to the page load", async () => {
		const html = await (await fetch(`${origin}/par`)).text();
		expect(html).toContain("<title>Par title</title>");
		expect(html).toContain(`data-meta="m"`);
	});

	test("a metadata() redirect still wins, and the page load does not run", async () => {
		const before = (await stats()).pageLoads;
		const res = await fetch(`${origin}/par?meta-redirect`, { redirect: "manual" });
		expect(res.status).toBe(303);
		expect(res.headers.get("location")).toBe("/");
		expect((await stats()).pageLoads).toBe(before);
	});
});

describe("static files skip the user's handle hook", () => {
	test("a public/ file is served without running the hook, security headers intact", async () => {
		const res = await fetch(`${origin}/hello.txt`);
		expect(await res.text()).toBe("hello from public\n");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect((await stats()).hooks).not.toContain("/hello.txt");
	});

	test("a +server.ts route that looks static still wins, and runs the hook", async () => {
		const res = await fetch(`${origin}/feed.txt`);
		expect(await res.text()).toBe("from route");
		expect((await stats()).hooks).toContain("/feed.txt");
	});

	test("pages still run the hook", async () => {
		await fetch(`${origin}/`);
		expect((await stats()).hooks).toContain("/");
	});
});

describe("review fixes", () => {
	test("a parent() left unawaited when an ancestor redirects does not crash the server", async () => {
		const res = await fetch(`${origin}/par?guest&orphan`, { redirect: "manual" });
		expect(res.status).toBe(303);
		// The orphaned parent() rejects once the root finishes; give it time.
		await Bun.sleep(SLEEP * 2);
		expect((await fetch(`${origin}/_health`)).ok).toBe(true);
	});

	test("a metadata() redirect withdraws cookies the layouts set meanwhile", async () => {
		const res = await fetch(`${origin}/par?meta-redirect&cookie`, { redirect: "manual" });
		expect(res.status).toBe(303);
		expect(res.headers.get("set-cookie") ?? "").not.toContain("from_inner");
	});

	test("a failing ancestor withdraws cookies set by deeper loaders", async () => {
		const res = await fetch(`${origin}/par?boom-root&cookie`);
		expect(res.status).toBe(404);
		expect(res.headers.get("set-cookie") ?? "").not.toContain("from_inner");
	});

	test("cookies from a loader on a normal response still ship", async () => {
		const res = await fetch(`${origin}/par?cookie`);
		expect(res.status).toBe(200);
		expect(res.headers.get("set-cookie") ?? "").toContain("from_inner=1");
	});

	test("on client navigation, a metadata() redirect decides the response and the page load does not run", async () => {
		const before = (await stats()).pageLoads;
		const res = await fetch(`${origin}/__bosia/data/par.json?meta-redirect&cookie`);
		expect(await res.json()).toMatchObject({ redirect: "/", status: 303 });
		expect(res.headers.get("set-cookie") ?? "").not.toContain("from_inner");
		expect((await stats()).pageLoads).toBe(before);
	});
});

describe("a Response object shared across requests", () => {
	test("one request's Set-Cookie never reaches the next", async () => {
		const a = await fetch(`${origin}/shared?who=alice`);
		const b = await fetch(`${origin}/shared?who=bob`);
		expect(a.headers.get("set-cookie")).toContain("who=alice");
		const bob = b.headers.get("set-cookie") ?? "";
		expect(bob).toContain("who=bob");
		expect(bob).not.toContain("alice");
	});
});

describe("review fixes, pass 3", () => {
	test("Set-Cookie follows loader order: the deeper loader's write wins", async () => {
		const res = await fetch(`${origin}/par?order`);
		expect(res.status).toBe(200);
		const themes = res.headers.getSetCookie().filter((c) => c.startsWith("theme="));
		// Inner layout wrote first, root after its sleep; serial order is root → inner.
		expect(themes.map((c) => c.split(";")[0])).toEqual(["theme=dark", "theme=light"]);
	});

	test("a reused Response keeps its frame-guard opt-out on every request", async () => {
		for (let i = 0; i < 2; i++) {
			const res = await fetch(`${origin}/embed`);
			expect(res.status).toBe(204);
			expect(res.headers.get("x-frame-options")).toBeNull();
			expect(res.headers.get("x-bosia-no-frame-guard")).toBeNull();
			// Bun sends a Response object it has sent before with none of its
			// headers, so in-place decoration lost these from the second request on.
			expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		}
	});
});

describe("a reused Response without per-request headers", () => {
	test("keeps its security headers after the first request", async () => {
		for (let i = 0; i < 3; i++) {
			const res = await fetch(`${origin}/plain-shared`);
			expect(res.status).toBe(204);
			expect(res.headers.get("x-content-type-options")).toBe("nosniff");
			expect(res.headers.get("x-own")).toBe("1");
		}
	});
});
