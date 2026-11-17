// The action's logic, free of the runner so it can be unit-tested: inputs come from INPUT_* variables, outputs go to the
// $GITHUB_OUTPUT file, messages use workflow commands (::error::, ::add-mask::). No @actions/* dependency.
// wait-for: email (default) waits for a mail; wait-for: webhook waits for a request to the Webhook inspector's catch URL.

import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { MailPierInbox, MailPierInboxError, MailPierTimeoutError, type MailPierInboxOptions } from "../../node/src/index.js";

export interface RunDeps {
  env: Record<string, string | undefined>;
  log: (line: string) => void;
  /** Extra client options (tests: fetch, retry delays). */
  clientOptions?: Partial<MailPierInboxOptions>;
}

export interface RunResult {
  exitCode: number;
  outputs: Record<string, string>;
}

/** Reads an input the way @actions/core does: INPUT_<NAME> with spaces as '_' and upper case (hyphens stay). */
export function getInput(env: RunDeps["env"], name: string): string {
  return (env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
}

/** Escapes a workflow command's data. */
export function escapeData(s: string): string {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/**
 * Text that came from a caught request with every C0, DEL and C1 control character written as `\xHH` (like `mailpier listen`), so a
 * newline in a path can never start a `::` workflow command on the next log line.
 */
export function printable(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/** Writes outputs with the heredoc syntax, so a value can never break out of its line. */
export function writeOutputs(env: RunDeps["env"], outputs: Record<string, string>, log: RunDeps["log"]): void {
  const file = env.GITHUB_OUTPUT;
  if (!file) {
    // Old runners / local runs: print them instead.
    for (const [k, v] of Object.entries(outputs)) log(`${k}=${v}`);
    return;
  }
  let text = "";
  for (const [k, v] of Object.entries(outputs)) {
    const delim = `ghadelimiter_${randomUUID()}`;
    text += `${k}<<${delim}\n${v}\n${delim}\n`;
  }
  appendFileSync(file, text, "utf8");
}

/** The outputs of wait-for: webhook (empty strings when it timed out). */
const WEBHOOK_OUTPUTS = ["request-id", "method", "path", "body", "json"] as const;

export async function run(deps: RunDeps): Promise<RunResult> {
  const { env, log } = deps;
  const fail = (message: string): RunResult => {
    log(`::error title=MailPier Inbox::${escapeData(message)}`);
    return { exitCode: 1, outputs: {} };
  };

  const apiKey = getInput(env, "api-key");
  const waitFor = (getInput(env, "wait-for") || "email").toLowerCase();
  const to = getInput(env, "to") || getInput(env, "address");
  const subjectContains = getInput(env, "subject-contains") || undefined;
  const linkContains = getInput(env, "link-contains") || undefined;
  const since = getInput(env, "since") || undefined;
  const baseUrl = getInput(env, "base-url") || undefined;
  const timeoutText = getInput(env, "timeout") || "120";
  const failOnTimeout = (getInput(env, "fail-on-timeout") || "true").toLowerCase() !== "false";

  if (!apiKey) return fail("Input api-key is required (use a secret: api-key: ${{ secrets.MAILPIER_API_KEY }}).");
  log(`::add-mask::${apiKey}`);
  if (waitFor !== "email" && waitFor !== "webhook") return fail(`Input wait-for must be email or webhook (got "${waitFor}").`);
  if (waitFor === "email" && !to) return fail("Input to (the address the mail was sent to) is required.");
  const timeoutSeconds = Number(timeoutText);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) return fail(`Input timeout must be a number of seconds > 0 (got "${timeoutText}").`);
  if (since && Number.isNaN(Date.parse(since))) return fail(`Input since must be an ISO 8601 date/time (got "${since}").`);

  const inbox = new MailPierInbox({ apiKey, baseUrl, ...deps.clientOptions });
  if (waitFor === "webhook") {
    return waitForWebhook(deps, inbox, { path: getInput(env, "path"), method: getInput(env, "method") || undefined, since, timeoutSeconds, failOnTimeout }, fail);
  }

  log(`Waiting up to ${timeoutSeconds} s for a mail to ${to}${subjectContains ? ` with "${subjectContains}" in the subject` : ""}...`);
  try {
    const m = await inbox.waitForMessage({ to, subjectContains, since, timeoutMs: timeoutSeconds * 1000 });
    const outputs = {
      "message-id": m.id,
      subject: m.subject ?? "",
      from: m.from ?? "",
      "received-utc": m.receivedUtc,
      code: m.code ?? "",
      "first-link": m.firstLink(linkContains) ?? "",
      "timed-out": "false",
    };
    writeOutputs(env, outputs, log);
    log(`Received "${outputs.subject}" (${m.id}) from ${outputs.from}; code: ${outputs.code || "(none)"}; link: ${outputs["first-link"] || "(none)"}.`);
    if (linkContains && !outputs["first-link"]) log(`::warning title=MailPier Inbox::The mail holds no link containing "${escapeData(linkContains)}".`);
    return { exitCode: 0, outputs };
  } catch (err) {
    if (err instanceof MailPierTimeoutError) {
      if (failOnTimeout) return fail(err.message);
      const outputs = { "timed-out": "true", "message-id": "", subject: "", from: "", "received-utc": "", code: "", "first-link": "" };
      writeOutputs(env, outputs, log);
      log(`::warning title=MailPier Inbox::${escapeData(err.message)}`);
      return { exitCode: 0, outputs };
    }
    if (err instanceof MailPierInboxError) return fail(err.message);
    return fail(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** wait-for: webhook. Waits for a request to the environment's catch URL whose path starts with `path`. */
async function waitForWebhook(deps: RunDeps, inbox: MailPierInbox,
  o: { path: string; method?: string; since?: string; timeoutSeconds: number; failOnTimeout: boolean },
  fail: (message: string) => RunResult): Promise<RunResult> {
  const { env, log } = deps;
  if (!o.path) return fail("Input path is required with wait-for: webhook (the path after the webhook URL's token, e.g. /order-${{ github.run_id }}; / for any).");
  const path = o.path.startsWith("/") ? o.path : `/${o.path}`;
  log(`Waiting up to ${o.timeoutSeconds} s for a ${o.method ? `${o.method.toUpperCase()} ` : ""}webhook request to ${path}...`);
  try {
    const r = await inbox.waitForWebhook({ path, method: o.method, since: o.since, timeoutSeconds: o.timeoutSeconds });
    let json = "";
    try { json = JSON.stringify(r.jsonBody()) ?? ""; } catch { /* the body is not JSON: empty output */ }
    const outputs: Record<string, string> = {
      "request-id": String(r.id),
      method: r.method,
      path: r.path,
      body: r.body ?? "",
      json,
      "timed-out": "false",
    };
    writeOutputs(env, outputs, log);
    const binary = r.body === null || r.body === undefined ? (r.size > 0 ? `; binary body (${r.size} bytes), not in the body output` : "") : "";
    // Method, path and query come from whoever called the catch URL: a newline there could start a "::" workflow command.
    log(`Received ${printable(`${r.method} ${r.path}${r.query ? `?${r.query}` : ""}`)} (request ${r.id}, ${r.size} bytes${json ? ", JSON" : ""}${binary}).`);
    return { exitCode: 0, outputs };
  } catch (err) {
    if (err instanceof MailPierTimeoutError) {
      if (o.failOnTimeout) return fail(err.message);
      const outputs: Record<string, string> = { "timed-out": "true" };
      for (const k of WEBHOOK_OUTPUTS) outputs[k] = "";
      writeOutputs(env, outputs, log);
      log(`::warning title=MailPier Inbox::${escapeData(err.message)}`);
      return { exitCode: 0, outputs };
    }
    if (err instanceof MailPierInboxError) return fail(err.message);
    return fail(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
