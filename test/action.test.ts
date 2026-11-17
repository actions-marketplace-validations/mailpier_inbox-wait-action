import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { escapeData, getInput, printable, run } from "../src/main.js";
import { startFakeMailPier, type FakeMailPier } from "../../node/src/testing/index.js";

let fake: FakeMailPier;
let dir: string;
let outFile: string;
let lines: string[];

beforeAll(async () => { fake = await startFakeMailPier(); });
afterAll(async () => { await fake.close(); });
beforeEach(() => {
  fake.reset();
  dir = mkdtempSync(join(tmpdir(), "mpi-action-"));
  outFile = join(dir, "output.txt");
  lines = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Parses the $GITHUB_OUTPUT heredoc format back into a map. */
function readOutputs(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  const rows = readFileSync(file, "utf8").split("\n");
  for (let i = 0; i < rows.length; i++) {
    const m = /^([^<]+)<<(.+)$/.exec(rows[i]);
    if (!m) continue;
    const value: string[] = [];
    for (i++; rows[i] !== m[2]; i++) value.push(rows[i]);
    out[m[1]] = value.join("\n");
  }
  return out;
}

const env = (inputs: Record<string, string>) => {
  const e: Record<string, string> = { GITHUB_OUTPUT: outFile, "INPUT_API-KEY": fake.apiKey, "INPUT_BASE-URL": fake.url };
  for (const [k, v] of Object.entries(inputs)) e[`INPUT_${k.toUpperCase()}`] = v;
  return e;
};
const go = (inputs: Record<string, string>) =>
  run({ env: env(inputs), log: (l) => lines.push(l), clientOptions: { maxRetryDelayMs: 20 } });

describe("inbox-wait action", () => {
  it("waits for the mail and writes code, first-link, message-id, subject", async () => {
    const to = `signup-abc@${fake.zone}`;
    setTimeout(() => fake.deliver({
      to, from: "noreply@app.example.com", subject: "Confirm your account",
      text: "Your code is 482913.",
      html: '<a href="https://app.example.com/help">Help</a><a href="https://app.example.com/verify?t=1">Verify</a>',
    }), 200);
    const r = await go({ to, "subject-contains": "confirm", "link-contains": "verify", timeout: "10" });
    expect(r.exitCode).toBe(0);
    const outputs = readOutputs(outFile);
    expect(outputs).toMatchObject({
      code: "482913",
      "first-link": "https://app.example.com/verify?t=1",
      subject: "Confirm your account",
      from: "noreply@app.example.com",
      "timed-out": "false",
    });
    expect(outputs["message-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(lines).toContain(`::add-mask::${fake.apiKey}`);
    expect(fake.requests.at(-1)!.authorization).toBe(`Bearer ${fake.apiKey}`);
  });

  it("accepts `address` as an alias of `to` and passes since", async () => {
    const to = `x@${fake.zone}`;
    fake.deliver({ to, subject: "Hello" });
    const r = await go({ address: to, since: "2020-01-01T00:00:00Z", timeout: "5" });
    expect(r.exitCode).toBe(0);
    expect(r.outputs.code).toBe("");
    expect(fake.requests.at(-1)!.url).toContain("since=2020-01-01T00%3A00%3A00Z");
  });

  it("fails the step on timeout with a readable error", async () => {
    const r = await go({ to: `none@${fake.zone}`, timeout: "1" });
    expect(r.exitCode).toBe(1);
    expect(lines.some((l) => l.startsWith("::error title=MailPier Inbox::No mail to none@"))).toBe(true);
  });

  it("with fail-on-timeout false, sets timed-out=true and succeeds", async () => {
    const r = await go({ to: `none@${fake.zone}`, timeout: "1", "fail-on-timeout": "false" });
    expect(r.exitCode).toBe(0);
    expect(readOutputs(outFile)["timed-out"]).toBe("true");
  });

  it("reports API errors (401) with the server's text", async () => {
    const r = await run({ env: { ...env({ to: `a@${fake.zone}` }), "INPUT_API-KEY": "mpi_wrong" }, log: (l) => lines.push(l) });
    expect(r.exitCode).toBe(1);
    expect(lines.find((l) => l.startsWith("::error"))).toMatch(/API key.*HTTP 401/);
  });

  it("validates inputs", async () => {
    expect((await run({ env: { GITHUB_OUTPUT: outFile }, log: (l) => lines.push(l) })).exitCode).toBe(1);
    expect(lines.at(-1)).toMatch(/api-key is required/);
    expect((await go({})).exitCode).toBe(1);
    expect(lines.at(-1)).toMatch(/to .* is required/);
    expect((await go({ to: "a@b", timeout: "soon" })).exitCode).toBe(1);
    expect(lines.at(-1)).toMatch(/timeout must be a number/);
    expect((await go({ to: "a@b", since: "yesterday" })).exitCode).toBe(1);
    expect(lines.at(-1)).toMatch(/since must be an ISO 8601/);
  });

  it("a value with newlines cannot inject another output", async () => {
    const to = `nl@${fake.zone}`;
    fake.deliver({ to, subject: "line1\ncode<<EOF\nhacked" });
    await go({ to, timeout: "5" });
    const outputs = readOutputs(outFile);
    expect(outputs.subject).toBe("line1\ncode<<EOF\nhacked");
    expect(outputs.code).toBe("");
  });

  it("validates wait-for", async () => {
    expect((await go({ "wait-for": "sms", to: "a@b" })).exitCode).toBe(1);
    expect(lines.at(-1)).toMatch(/wait-for must be email or webhook/);
  });

  it("helpers: getInput and escapeData behave like @actions/core", () => {
    expect(getInput({ "INPUT_SUBJECT-CONTAINS": "  x " }, "subject-contains")).toBe("x");
    expect(getInput({ INPUT_MY_INPUT: "y" }, "my input")).toBe("y");
    expect(escapeData("a%b\r\nc")).toBe("a%25b%0D%0Ac");
  });
});

describe("wait-for: webhook", () => {
  it("waits for a request under path and writes request-id, method, path, body and json", async () => {
    setTimeout(() => {
      void fetch(`${fake.webhookUrl}/order-77/paid?x=1`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: '{"event":"order.paid","n":1}',
      });
    }, 200);
    const r = await go({ "wait-for": "webhook", path: "order-77", method: "post", timeout: "10" });
    expect(r.exitCode).toBe(0);
    const outputs = readOutputs(outFile);
    expect(outputs).toMatchObject({
      method: "POST", path: "/order-77/paid", body: '{"event":"order.paid","n":1}', json: '{"event":"order.paid","n":1}', "timed-out": "false",
    });
    expect(Number(outputs["request-id"])).toBeGreaterThan(0);
    expect(outputs.code).toBeUndefined();                                 // no mail outputs in webhook mode
    const wait = fake.requests.find((q) => q.url.startsWith("/v1/hooks/requests/wait"))!.url;
    expect(wait).toContain("path=%2Forder-77");
    expect(wait).toContain("method=post");
    expect(lines.some((l) => l.startsWith("Received POST /order-77/paid?x=1"))).toBe(true);
  });

  it("never prints a caught path's newline (it could start a :: workflow command)", async () => {
    fake.catchWebhook({ path: "/order-88\n::add-mask::x\u001b[2J" });
    const r = await go({ "wait-for": "webhook", path: "order-88", timeout: "5" });
    expect(r.exitCode).toBe(0);
    const received = lines.find((l) => l.startsWith("Received "))!;
    expect(received.startsWith("Received POST /order-88\\x0A::add-mask::x\\x1B[2J (request ")).toBe(true);
    // (The action's own "::add-mask::<key>" line is fine; the path's must never start a line.)
    expect(lines.some((l) => /[\u0000-\u001f]/.test(l) || l.startsWith("::add-mask::x"))).toBe(false);
    expect(printable("a\r\nb\u009b")).toBe("a\\x0D\\x0Ab\\x9B");
  });

  it("json is empty for a non-JSON body and body is empty for a binary one; since is passed", async () => {
    fake.catchWebhook({ path: "/t", body: "plain text", contentType: "text/plain" });
    let r = await go({ "wait-for": "webhook", path: "/t", since: "2020-01-01T00:00:00Z", timeout: "5" });
    expect(r.outputs).toMatchObject({ body: "plain text", json: "" });
    expect(fake.requests.at(-1)!.url).toContain("since=2020-01-01T00%3A00%3A00Z");
    fake.catchWebhook({ path: "/b", body: new Uint8Array([0xff, 0x00]) });
    r = await go({ "wait-for": "webhook", path: "/b", timeout: "5" });
    expect(r.outputs).toMatchObject({ body: "", json: "" });
    expect(lines.at(-1)).toMatch(/binary body \(2 bytes\)/);
  });

  it("needs a path", async () => {
    expect((await go({ "wait-for": "webhook" })).exitCode).toBe(1);
    expect(lines.at(-1)).toMatch(/path is required with wait-for: webhook/);
  });

  it("fails on timeout, or with fail-on-timeout false sets timed-out and empty outputs", async () => {
    let r = await go({ "wait-for": "webhook", path: "/none", timeout: "1" });
    expect(r.exitCode).toBe(1);
    expect(lines.some((l) => l.startsWith("::error title=MailPier Inbox::No webhook request to /none"))).toBe(true);
    r = await go({ "wait-for": "WEBHOOK", path: "/none", timeout: "1", "fail-on-timeout": "false" });
    expect(r.exitCode).toBe(0);
    expect(readOutputs(outFile)).toMatchObject({ "timed-out": "true", "request-id": "", body: "", json: "" });
  });

  it("reports 404 (webhooks off) with the server's text", async () => {
    const off = await startFakeMailPier({ webhooks: false });
    try {
      const r = await run({ env: { ...env({ "wait-for": "webhook", path: "/x" }), "INPUT_BASE-URL": off.url }, log: (l) => lines.push(l) });
      expect(r.exitCode).toBe(1);
      expect(lines.find((l) => l.startsWith("::error"))).toMatch(/HTTP 404/);
    } finally {
      await off.close();
    }
  });
});

describe("dist/index.js (what the runner executes)", () => {
  const dist = fileURLToPath(new URL("../dist/index.js", import.meta.url));

  it("runs as a separate process and writes outputs", async () => {
    const to = `dist@${fake.zone}`;
    fake.deliver({ to, subject: "Code 97531" });
    // spawnSync would block this process (and the fake server in it), so use the async spawn.
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [dist], { env: { ...process.env, ...env({ to, timeout: "10" }) } });
    let stdout = "";
    child.stdout.on("data", (d) => (stdout += d));
    const code = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? -1)));
    expect(stdout).toContain("Received");
    expect(code).toBe(0);
    expect(readOutputs(outFile).code).toBe("97531");
  });

  it("runs wait-for: webhook as a separate process", async () => {
    fake.catchWebhook({ path: "/dist-hook", body: { ok: true } });
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [dist], { env: { ...process.env, ...env({ "wait-for": "webhook", path: "/dist-hook", timeout: "10" }) } });
    const code = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? -1)));
    expect(code).toBe(0);
    expect(readOutputs(outFile).json).toBe('{"ok":true}');
  });

  it("is a single self-contained file (imports only Node built-ins)", () => {
    const text = readFileSync(dist, "utf8");
    const imports = [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports.filter((i) => !i.startsWith("node:") && !builtinModules.includes(i))).toEqual([]);
    expect(spawnSync(process.execPath, ["--check", dist]).status).toBe(0);
  });
});
