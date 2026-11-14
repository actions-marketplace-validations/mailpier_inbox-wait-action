import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { escapeData, getInput, run } from "../src/main.js";
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

  it("helpers: getInput and escapeData behave like @actions/core", () => {
    expect(getInput({ "INPUT_SUBJECT-CONTAINS": "  x " }, "subject-contains")).toBe("x");
    expect(getInput({ INPUT_MY_INPUT: "y" }, "my input")).toBe("y");
    expect(escapeData("a%b\r\nc")).toBe("a%25b%0D%0Ac");
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

  it("is a single self-contained file (imports only Node built-ins)", () => {
    const text = readFileSync(dist, "utf8");
    const imports = [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports.filter((i) => !i.startsWith("node:") && !builtinModules.includes(i))).toEqual([]);
    expect(spawnSync(process.execPath, ["--check", dist]).status).toBe(0);
  });
});
