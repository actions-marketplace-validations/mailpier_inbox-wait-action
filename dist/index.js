// src/main.ts
import { appendFileSync } from "fs";
import { randomUUID } from "crypto";

// ../node/src/errors.ts
var MailPierInboxError = class extends Error {
  status;
  /** Set on 429: seconds to wait before the next call. */
  retryAfterSeconds;
  constructor(status, message, retryAfterSeconds) {
    super(message);
    this.name = "MailPierInboxError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
};
var MailPierTimeoutError = class extends Error {
  address;
  timeoutMs;
  constructor(address, timeoutMs, subjectContains) {
    super(`No mail to ${address}${subjectContains ? ` with "${subjectContains}" in the subject` : ""} arrived within ${Math.round(timeoutMs / 1e3)} seconds.`);
    this.name = "MailPierTimeoutError";
    this.address = address;
    this.timeoutMs = timeoutMs;
  }
};
var MailPierWebhookTimeoutError = class extends MailPierTimeoutError {
  path;
  method;
  constructor(path, timeoutMs, method) {
    super(path, timeoutMs);
    this.message = `No ${method ? `${method.toUpperCase()} ` : ""}webhook request to ${path} arrived within ${Math.round(timeoutMs / 1e3)} seconds.`;
    this.name = "MailPierWebhookTimeoutError";
    this.path = path;
    this.method = method;
  }
};

// ../node/src/message.ts
var InboxMessage = class {
  id;
  receivedUtc;
  from;
  to = [];
  subject;
  sizeBytes = 0;
  hasAttachments = false;
  text;
  html;
  headers;
  links = [];
  codes = [];
  attachments = [];
  auth;
  spam;
  constructor(data) {
    Object.assign(this, data);
    this.to = Array.isArray(data.to) ? data.to : [];
    this.links = Array.isArray(data.links) ? data.links.filter((l) => l && typeof l.href === "string") : [];
    this.codes = normaliseCodes(data.codes);
    this.attachments = Array.isArray(data.attachments) ? data.attachments : [];
  }
  /** The first one-time code in the mail (best guess first), or undefined when it has none. */
  get code() {
    return this.codes[0];
  }
  /**
   * The first link whose address (or text) contains `contains` (case-insensitive), or the first link when it is omitted;
   * undefined when none matches.
   */
  firstLink(contains) {
    if (contains === void 0 || contains === null || contains === "") return this.links[0]?.href;
    const needle = contains.toLowerCase();
    return this.links.find((l) => l.href.toLowerCase().includes(needle) || (l.text ?? "").toLowerCase().includes(needle))?.href;
  }
  /** The plain JSON (what the API returned), e.g. to pass through a Cypress task. */
  toJSON() {
    const { ...plain } = this;
    return { ...plain, code: this.code };
  }
};
function normaliseCodes(codes) {
  if (!Array.isArray(codes)) return [];
  const out = [];
  for (const c of codes) {
    if (typeof c === "string" && c.length > 0) out.push(c);
    else if (c && typeof c === "object") {
      for (const k of ["value", "code", "Value", "Code"]) {
        const v = c[k];
        if (typeof v === "string" && v.length > 0) {
          out.push(v);
          break;
        }
      }
    }
  }
  return out;
}

// ../node/src/webhook.ts
var WebhookRequest = class {
  id;
  receivedUtc;
  method = "";
  path = "/";
  query;
  contentType;
  size = 0;
  environment;
  status = 0;
  url;
  headers = [];
  body;
  bodyBase64;
  json;
  form;
  sourceIp;
  headersTruncated = false;
  ruleId;
  forwardStatus;
  constructor(data) {
    Object.assign(this, data);
    this.headers = Array.isArray(data.headers) ? data.headers.filter((h) => h && typeof h.name === "string").map((h) => ({ name: h.name, value: String(h.value ?? "") })) : [];
    this.headersTruncated = data.headersTruncated === true;
  }
  /** The first value of a header (name case-insensitive), or undefined when the request has none. */
  header(name) {
    const n = name.toLowerCase();
    return this.headers.find((h) => h.name.toLowerCase() === n)?.value;
  }
  /** The body bytes (from `body` or `bodyBase64`); empty when the request had no body. */
  bytes() {
    if (typeof this.bodyBase64 === "string" && this.bodyBase64) {
      const bin = atob(this.bodyBase64);
      const out = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
      return out;
    }
    return new TextEncoder().encode(this.body ?? "");
  }
  /**
   * The body as JSON: the server's parsed `json`, or the text body parsed here (a JSON body sent with another content type).
   * Throws when the body is not JSON.
   */
  jsonBody() {
    if (this.json !== void 0 && this.json !== null) return this.json;
    if (typeof this.body === "string" && this.body.trim()) {
      try {
        return JSON.parse(this.body);
      } catch {
      }
    }
    throw new Error(`The body of ${this.method} ${this.path} (request ${this.id}, ${this.contentType ?? "no content type"}) is not JSON.`);
  }
  /** The plain JSON (what the API returned), e.g. to pass through a Cypress task. */
  toJSON() {
    const { ...plain } = this;
    return plain;
  }
};

// ../node/src/client.ts
var DEFAULT_BASE_URL = "https://api.mailpier.io";
var MAX_POLL_SECONDS = 120;
var VERSION = "0.1.1";
var sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const t = setTimeout(() => {
    signal?.removeEventListener("abort", onAbort);
    resolve();
  }, ms);
  const onAbort = () => {
    clearTimeout(t);
    reject(signal.reason);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
});
function iso(t) {
  if (t === void 0) return void 0;
  return typeof t === "string" ? t : t.toISOString();
}
function env(name) {
  const p = globalThis.process;
  const v = p?.env?.[name];
  return v && v.trim() ? v.trim() : void 0;
}
function webhookPath(path) {
  const p = path?.trim();
  if (!p) return void 0;
  return p.startsWith("/") ? p : `/${p}`;
}
var MailPierInbox = class {
  baseUrl;
  apiKey;
  maxRetries;
  maxRetryDelayMs;
  fetchImpl;
  constructor(options = {}) {
    const key = (options.apiKey ?? env("MAILPIER_API_KEY") ?? "").trim();
    if (!key) throw new Error("An API key (mpi_...) is required: pass { apiKey } or set MAILPIER_API_KEY.");
    this.apiKey = key;
    this.baseUrl = (options.baseUrl ?? env("MAILPIER_BASE_URL") ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.maxRetries = Math.max(0, options.maxRetries ?? 5);
    this.maxRetryDelayMs = Math.max(0, options.maxRetryDelayMs ?? 6e4);
    const f = options.fetch ?? globalThis.fetch;
    if (!f) throw new Error("No fetch available: use Node 18 or later, or pass { fetch }.");
    this.fetchImpl = f;
  }
  /** A fresh random address of the key's environment, e.g. `signup-k3v9q2mz7a@qa.acme.mailpier.io`. */
  async newAddress(options = {}) {
    const body = {};
    if (options.domain) body.domain = options.domain;
    if (options.prefix) body.prefix = options.prefix;
    const resp = await this.request("POST", "/v1/addresses", {}, { body: JSON.stringify(body) });
    const json = await resp.json();
    if (!json?.address) throw new MailPierInboxError(resp.status, "The server returned no address.");
    return json.address;
  }
  /**
   * Waits until a mail to `to` arrives and returns it (the OLDEST match received at or after `since`).
   * Throws MailPierTimeoutError when nothing arrives within `timeoutMs`.
   */
  async waitForMessage(options) {
    const to = options.to?.trim();
    if (!to) throw new Error("waitForMessage needs { to: address }.");
    const timeoutMs = options.timeoutMs ?? 6e4;
    if (!(timeoutMs > 0)) throw new Error("timeoutMs must be greater than 0.");
    const deadline = Date.now() + timeoutMs;
    const since = iso(options.since);
    for (; ; ) {
      const left = deadline - Date.now();
      const seconds = Math.min(Math.max(Math.ceil(left / 1e3), 1), MAX_POLL_SECONDS);
      const resp = await this.request("GET", "/v1/messages/wait", {
        to,
        subject: options.subjectContains,
        since,
        afterId: since ? options.afterId : void 0,
        timeoutSeconds: seconds
      }, { signal: options.signal, timeoutMs: (seconds + 30) * 1e3 });
      if (resp.status !== 204) return new InboxMessage(await resp.json());
      if (Date.now() >= deadline) throw new MailPierTimeoutError(to, timeoutMs, options.subjectContains);
    }
  }
  /**
   * Waits for the next mail to `to` after `previous` (one you already received): passes its receivedUtc as `since` and its id as
   * `afterId`, so a mail stored in the same millisecond is not missed and `previous` itself is never returned again.
   */
  waitForNextMessage(previous, options) {
    return this.waitForMessage({ ...options, since: previous.receivedUtc, afterId: previous.id });
  }
  /** Mail of the environment, newest first (at most 100 per call). */
  async listMessages(options = {}) {
    const since = iso(options.since);
    const resp = await this.request("GET", "/v1/messages", {
      to: options.to,
      subject: options.subjectContains,
      since,
      afterId: since ? options.afterId : void 0,
      take: options.take ?? 50,
      skip: options.skip ?? 0
    }, { signal: options.signal });
    const json = await resp.json();
    return json?.items ?? [];
  }
  /** One mail with its text, HTML, headers, links, codes and attachment list; null when it does not exist (or expired). */
  async getMessage(id) {
    const resp = await this.request("GET", `/v1/messages/${encodeURIComponent(id)}`, {}, { allow404: true });
    if (resp.status === 404) return null;
    return new InboxMessage(await resp.json());
  }
  /** The original message (.eml bytes); null when it does not exist. */
  getRaw(id) {
    return this.download(`/v1/messages/${encodeURIComponent(id)}/raw`);
  }
  /** One attachment's bytes; null when it does not exist. */
  getAttachment(id, index) {
    return this.download(`/v1/messages/${encodeURIComponent(id)}/attachments/${index}`);
  }
  /** Deletes one mail. False when it did not exist. Throws (409) when the mail was also sent outside this environment. */
  async deleteMessage(id) {
    const resp = await this.request("DELETE", `/v1/messages/${encodeURIComponent(id)}`, {}, { allow404: true });
    return resp.status !== 404;
  }
  /** Deletes every mail to one address; returns how many were deleted. */
  async deleteAll(to) {
    return (await this.deleteAllDetailed(to)).deleted;
  }
  /** Like deleteAll, but also says how many shared mails were skipped. */
  async deleteAllDetailed(to) {
    if (!to?.trim()) throw new Error("deleteAll needs the address.");
    const resp = await this.request("DELETE", "/v1/messages", { to: to.trim() });
    const json = await resp.json();
    return { deleted: json?.deleted ?? 0, skippedShared: json?.skippedShared ?? 0 };
  }
  /** The key's account, environment, domains, plan and usage (GET /v1/me). */
  async me() {
    const resp = await this.request("GET", "/v1/me", {});
    return await resp.json();
  }
  // ------------------------------------------------------------------ Webhook inspector (/v1/hooks; 404 while the feature is off)
  /** The environment's catch URL (made on first use), its switches and the plan's webhook limits. */
  async getWebhookEndpoint() {
    const resp = await this.request("GET", "/v1/hooks", {});
    const json = await resp.json();
    if (!json?.url) throw new MailPierInboxError(resp.status, "The server returned no webhook URL.");
    return json;
  }
  /**
   * The catch URL with a fresh random path, e.g. `{ url: "https://hook.gather-io.com/<token>/t-8f2k1x", path: "/t-8f2k1x" }`.
   * Give `url` to the app under test and wait with `waitForWebhook({ path })`. Nothing is stored: any path works without this call.
   */
  async createWebhookUrl() {
    const resp = await this.request("POST", "/v1/hooks/urls", {});
    const json = await resp.json();
    if (!json?.url || !json.path) throw new MailPierInboxError(resp.status, "The server returned no webhook URL.");
    return { url: json.url, path: json.path };
  }
  /**
   * Waits until a request to the catch URL arrives and returns it: the OLDEST match newer than `afterId` / `since`.
   * Throws MailPierWebhookTimeoutError (a MailPierTimeoutError) when nothing arrives within `timeoutSeconds`.
   */
  async waitForWebhook(options = {}) {
    const path = webhookPath(options.path);
    const method = options.method?.trim() || void 0;
    const timeoutSeconds = options.timeoutSeconds ?? 60;
    if (!(timeoutSeconds > 0)) throw new Error("timeoutSeconds must be greater than 0.");
    const timeoutMs = timeoutSeconds * 1e3;
    const deadline = Date.now() + timeoutMs;
    const since = iso(options.since);
    for (; ; ) {
      const left = deadline - Date.now();
      const seconds = Math.min(Math.max(Math.ceil(left / 1e3), 1), MAX_POLL_SECONDS);
      const resp = await this.request("GET", "/v1/hooks/requests/wait", {
        path,
        method,
        afterId: options.afterId,
        since,
        timeoutSeconds: seconds
      }, { signal: options.signal, timeoutMs: (seconds + 30) * 1e3 });
      if (resp.status !== 204) return new WebhookRequest(await resp.json());
      if (Date.now() >= deadline) throw new MailPierWebhookTimeoutError(path ?? "/", timeoutMs, method);
    }
  }
  /** Caught requests of the environment, newest first (at most 100 per call). */
  async listWebhooks(options = {}) {
    const resp = await this.request("GET", "/v1/hooks/requests", {
      path: webhookPath(options.path),
      method: options.method?.trim() || void 0,
      afterId: options.afterId,
      since: iso(options.since),
      take: options.take ?? 50,
      skip: options.skip ?? 0
    }, { signal: options.signal });
    const json = await resp.json();
    return json?.items ?? [];
  }
  /** One caught request with headers and body; null when it does not exist (or expired). */
  async getWebhook(id) {
    const resp = await this.request("GET", `/v1/hooks/requests/${encodeURIComponent(String(id))}`, {}, { allow404: true });
    if (resp.status === 404) return null;
    return new WebhookRequest(await resp.json());
  }
  /** The raw body bytes of a caught request; null when it does not exist. */
  getWebhookBody(id) {
    return this.download(`/v1/hooks/requests/${encodeURIComponent(String(id))}/body`);
  }
  /** Deletes one caught request. False when it did not exist. */
  async deleteWebhook(id) {
    const resp = await this.request("DELETE", `/v1/hooks/requests/${encodeURIComponent(String(id))}`, {}, { allow404: true });
    return resp.status !== 404;
  }
  /** Deletes the caught requests whose path starts with `path` (every request of the environment when omitted); returns how many. */
  async deleteWebhooks(options = {}) {
    const resp = await this.request("DELETE", "/v1/hooks/requests", { path: webhookPath(options.path) });
    const json = await resp.json();
    return json?.deleted ?? 0;
  }
  /**
   * Sends a caught request again (method, path, query, headers, body) to `url`, a PUBLIC http(s) address (MailPier never calls
   * private or loopback addresses: 400). Not retried on 502/504 or network errors, so the target never gets it twice.
   */
  async replayWebhook(id, url) {
    if (!url?.trim()) throw new Error("replayWebhook needs the URL to send the request to.");
    const resp = await this.request(
      "POST",
      `/v1/hooks/requests/${encodeURIComponent(String(id))}/replay`,
      {},
      { body: JSON.stringify({ url: url.trim() }), once: true }
    );
    const json = await resp.json();
    return { status: json?.status ?? null, durationMs: json?.durationMs ?? null, error: json?.error ?? null };
  }
  /**
   * Adds a custom response: requests whose path starts with `rule.path` (and of `rule.method`, when given) get this status,
   * content type, body and delay instead of 200 OK. Throws MailPierInboxError (400) when it is invalid or over the plan's count.
   */
  async addWebhookResponse(rule) {
    const path = webhookPath(rule?.path);
    if (!path) throw new Error('addWebhookResponse needs a path (e.g. "/stripe"; "/" for every request).');
    const isObject = rule.body !== void 0 && rule.body !== null && typeof rule.body === "object";
    const payload = {
      method: rule.method?.trim() ? rule.method.trim().toUpperCase() : null,
      path,
      status: rule.status ?? 200,
      contentType: rule.contentType ?? (isObject ? "application/json" : "text/plain"),
      body: isObject ? JSON.stringify(rule.body) : rule.body ?? "",
      delayMs: rule.delayMs ?? 0
    };
    const resp = await this.request("POST", "/v1/hooks/responses", {}, { body: JSON.stringify(payload), once: true });
    return await resp.json();
  }
  /** The environment's custom responses. */
  async listWebhookResponses() {
    const resp = await this.request("GET", "/v1/hooks/responses", {});
    const json = await resp.json();
    return json?.items ?? [];
  }
  /** Deletes a custom response. False when it did not exist. */
  async deleteWebhookResponse(id) {
    const resp = await this.request("DELETE", `/v1/hooks/responses/${encodeURIComponent(String(id))}`, {}, { allow404: true });
    return resp.status !== 404;
  }
  // ------------------------------------------------------------------ plumbing
  async download(path) {
    const resp = await this.request("GET", path, {}, { allow404: true, accept: "*/*" });
    if (resp.status === 404) return null;
    return new Uint8Array(await resp.arrayBuffer());
  }
  url(path, query) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== void 0 && v !== null && v !== "") q.set(k, String(v));
    const s = q.toString();
    return `${this.baseUrl}${path}${s ? `?${s}` : ""}`;
  }
  /**
   * One call with retries: 429 waits Retry-After (default 1 s), 502/503/504 and network errors back off 0.5, 1, 2, 4 ... s
   * (both capped at maxRetryDelayMs). Other errors throw MailPierInboxError with the server's {"error": "..."} text.
   * `once`: a call that must not run twice (replay, add a rule) is retried only on 429 and 503 (refused before any work), never
   * on 502/504 or network errors (it may have been done).
   */
  async request(method, path, query, o = {}) {
    const url = this.url(path, query);
    const headers = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: o.accept ?? "application/json",
      "User-Agent": `mailpier-inbox-node/${VERSION}`
    };
    if (o.body !== void 0) headers["Content-Type"] = "application/json";
    for (let attempt = 0; ; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(
        () => ctl.abort(new Error(`No answer within ${Math.round((o.timeoutMs ?? 6e4) / 1e3)} s.`)),
        o.timeoutMs ?? 6e4
      );
      const onAbort = () => ctl.abort(o.signal.reason);
      if (o.signal?.aborted) onAbort();
      else o.signal?.addEventListener("abort", onAbort, { once: true });
      let resp;
      try {
        resp = await this.fetchImpl(url, { method, headers, body: o.body, signal: ctl.signal });
      } catch (err) {
        clearTimeout(timer);
        o.signal?.removeEventListener("abort", onAbort);
        if (o.signal?.aborted) throw err;
        if (attempt >= this.maxRetries || o.once) {
          throw new MailPierInboxError(0, `Could not reach MailPier Inbox at ${this.baseUrl}: ${err instanceof Error ? err.message : String(err)}`);
        }
        await sleep(this.backoff(attempt), o.signal);
        continue;
      }
      clearTimeout(timer);
      o.signal?.removeEventListener("abort", onAbort);
      if (resp.ok || o.allow404 && resp.status === 404) return resp;
      const message = await errorText(resp);
      if (resp.status === 429) {
        const retryAfter = parseRetryAfter(resp.headers.get("Retry-After"));
        if (attempt < this.maxRetries) {
          await sleep(Math.min((retryAfter ?? 1) * 1e3, this.maxRetryDelayMs), o.signal);
          continue;
        }
        throw new MailPierInboxError(429, message ?? "Too many requests.", retryAfter);
      }
      const retryable = resp.status === 503 || !o.once && (resp.status === 502 || resp.status === 504);
      if (retryable && attempt < this.maxRetries) {
        await sleep(this.backoff(attempt), o.signal);
        continue;
      }
      throw new MailPierInboxError(resp.status, message ?? `MailPier Inbox answered ${resp.status}.`);
    }
  }
  backoff(attempt) {
    return Math.min(500 * 2 ** attempt, this.maxRetryDelayMs);
  }
};
async function errorText(resp) {
  try {
    const text = await resp.text();
    if (!text) return void 0;
    try {
      const e = JSON.parse(text).error;
      return typeof e === "string" && e ? `${e} (HTTP ${resp.status})` : void 0;
    } catch {
      return void 0;
    }
  } catch {
    return void 0;
  }
}
function parseRetryAfter(v) {
  if (!v) return void 0;
  const n = Number.parseInt(v, 10);
  if (Number.isFinite(n) && n >= 0) return n;
  const t = Date.parse(v);
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - Date.now()) / 1e3)) : void 0;
}

// src/main.ts
function getInput(env2, name) {
  return (env2[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`] ?? "").trim();
}
function escapeData(s) {
  return s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
function printable(text) {
  return text.replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\x${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}
function writeOutputs(env2, outputs, log) {
  const file = env2.GITHUB_OUTPUT;
  if (!file) {
    for (const [k, v] of Object.entries(outputs)) log(`${k}=${v}`);
    return;
  }
  let text = "";
  for (const [k, v] of Object.entries(outputs)) {
    const delim = `ghadelimiter_${randomUUID()}`;
    text += `${k}<<${delim}
${v}
${delim}
`;
  }
  appendFileSync(file, text, "utf8");
}
var WEBHOOK_OUTPUTS = ["request-id", "method", "path", "body", "json"];
async function run(deps) {
  const { env: env2, log } = deps;
  const fail = (message) => {
    log(`::error title=MailPier Inbox::${escapeData(message)}`);
    return { exitCode: 1, outputs: {} };
  };
  const apiKey = getInput(env2, "api-key");
  const waitFor = (getInput(env2, "wait-for") || "email").toLowerCase();
  const to = getInput(env2, "to") || getInput(env2, "address");
  const subjectContains = getInput(env2, "subject-contains") || void 0;
  const linkContains = getInput(env2, "link-contains") || void 0;
  const since = getInput(env2, "since") || void 0;
  const baseUrl = getInput(env2, "base-url") || void 0;
  const timeoutText = getInput(env2, "timeout") || "120";
  const failOnTimeout = (getInput(env2, "fail-on-timeout") || "true").toLowerCase() !== "false";
  if (!apiKey) return fail("Input api-key is required (use a secret: api-key: ${{ secrets.MAILPIER_API_KEY }}).");
  log(`::add-mask::${apiKey}`);
  if (waitFor !== "email" && waitFor !== "webhook") return fail(`Input wait-for must be email or webhook (got "${waitFor}").`);
  if (waitFor === "email" && !to) return fail("Input to (the address the mail was sent to) is required.");
  const timeoutSeconds = Number(timeoutText);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) return fail(`Input timeout must be a number of seconds > 0 (got "${timeoutText}").`);
  if (since && Number.isNaN(Date.parse(since))) return fail(`Input since must be an ISO 8601 date/time (got "${since}").`);
  const inbox = new MailPierInbox({ apiKey, baseUrl, ...deps.clientOptions });
  if (waitFor === "webhook") {
    return waitForWebhook(deps, inbox, { path: getInput(env2, "path"), method: getInput(env2, "method") || void 0, since, timeoutSeconds, failOnTimeout }, fail);
  }
  log(`Waiting up to ${timeoutSeconds} s for a mail to ${to}${subjectContains ? ` with "${subjectContains}" in the subject` : ""}...`);
  try {
    const m = await inbox.waitForMessage({ to, subjectContains, since, timeoutMs: timeoutSeconds * 1e3 });
    const outputs = {
      "message-id": m.id,
      subject: m.subject ?? "",
      from: m.from ?? "",
      "received-utc": m.receivedUtc,
      code: m.code ?? "",
      "first-link": m.firstLink(linkContains) ?? "",
      "timed-out": "false"
    };
    writeOutputs(env2, outputs, log);
    log(`Received "${outputs.subject}" (${m.id}) from ${outputs.from}; code: ${outputs.code || "(none)"}; link: ${outputs["first-link"] || "(none)"}.`);
    if (linkContains && !outputs["first-link"]) log(`::warning title=MailPier Inbox::The mail holds no link containing "${escapeData(linkContains)}".`);
    return { exitCode: 0, outputs };
  } catch (err) {
    if (err instanceof MailPierTimeoutError) {
      if (failOnTimeout) return fail(err.message);
      const outputs = { "timed-out": "true", "message-id": "", subject: "", from: "", "received-utc": "", code: "", "first-link": "" };
      writeOutputs(env2, outputs, log);
      log(`::warning title=MailPier Inbox::${escapeData(err.message)}`);
      return { exitCode: 0, outputs };
    }
    if (err instanceof MailPierInboxError) return fail(err.message);
    return fail(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
async function waitForWebhook(deps, inbox, o, fail) {
  const { env: env2, log } = deps;
  if (!o.path) return fail("Input path is required with wait-for: webhook (the path after the webhook URL's token, e.g. /order-${{ github.run_id }}; / for any).");
  const path = o.path.startsWith("/") ? o.path : `/${o.path}`;
  log(`Waiting up to ${o.timeoutSeconds} s for a ${o.method ? `${o.method.toUpperCase()} ` : ""}webhook request to ${path}...`);
  try {
    const r = await inbox.waitForWebhook({ path, method: o.method, since: o.since, timeoutSeconds: o.timeoutSeconds });
    let json = "";
    try {
      json = JSON.stringify(r.jsonBody()) ?? "";
    } catch {
    }
    const outputs = {
      "request-id": String(r.id),
      method: r.method,
      path: r.path,
      body: r.body ?? "",
      json,
      "timed-out": "false"
    };
    writeOutputs(env2, outputs, log);
    const binary = r.body === null || r.body === void 0 ? r.size > 0 ? `; binary body (${r.size} bytes), not in the body output` : "" : "";
    log(`Received ${printable(`${r.method} ${r.path}${r.query ? `?${r.query}` : ""}`)} (request ${r.id}, ${r.size} bytes${json ? ", JSON" : ""}${binary}).`);
    return { exitCode: 0, outputs };
  } catch (err) {
    if (err instanceof MailPierTimeoutError) {
      if (o.failOnTimeout) return fail(err.message);
      const outputs = { "timed-out": "true" };
      for (const k of WEBHOOK_OUTPUTS) outputs[k] = "";
      writeOutputs(env2, outputs, log);
      log(`::warning title=MailPier Inbox::${escapeData(err.message)}`);
      return { exitCode: 0, outputs };
    }
    if (err instanceof MailPierInboxError) return fail(err.message);
    return fail(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// src/index.ts
run({ env: process.env, log: (line) => console.log(line) }).then((r) => {
  process.exitCode = r.exitCode;
}).catch((err) => {
  console.log(`::error title=MailPier Inbox::${String(err)}`);
  process.exitCode = 1;
});
