// The action's logic, free of the runner so it can be unit-tested: inputs come from INPUT_* variables, outputs go to the
// $GITHUB_OUTPUT file, messages use workflow commands (::error::, ::add-mask::). No @actions/* dependency.

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

export async function run(deps: RunDeps): Promise<RunResult> {
  const { env, log } = deps;
  const fail = (message: string): RunResult => {
    log(`::error title=MailPier Inbox::${escapeData(message)}`);
    return { exitCode: 1, outputs: {} };
  };

  const apiKey = getInput(env, "api-key");
  const to = getInput(env, "to") || getInput(env, "address");
  const subjectContains = getInput(env, "subject-contains") || undefined;
  const linkContains = getInput(env, "link-contains") || undefined;
  const since = getInput(env, "since") || undefined;
  const baseUrl = getInput(env, "base-url") || undefined;
  const timeoutText = getInput(env, "timeout") || "120";
  const failOnTimeout = (getInput(env, "fail-on-timeout") || "true").toLowerCase() !== "false";

  if (!apiKey) return fail("Input api-key is required (use a secret: api-key: ${{ secrets.MAILPIER_API_KEY }}).");
  log(`::add-mask::${apiKey}`);
  if (!to) return fail("Input to (the address the mail was sent to) is required.");
  const timeoutSeconds = Number(timeoutText);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) return fail(`Input timeout must be a number of seconds > 0 (got "${timeoutText}").`);
  if (since && Number.isNaN(Date.parse(since))) return fail(`Input since must be an ISO 8601 date/time (got "${since}").`);

  const inbox = new MailPierInbox({ apiKey, baseUrl, ...deps.clientOptions });
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
