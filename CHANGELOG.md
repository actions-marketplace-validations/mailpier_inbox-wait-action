# Changelog

## 0.1.1 (2026-11-16)
- Webhook inspector: input `wait-for` (`email` default, or `webhook`) with `path` and `method`; outputs `request-id`, `method`,
  `path`, `body`, `json` (and `timed-out`). `to` is only required for `wait-for: email`; `since`, `timeout` and
  `fail-on-timeout` apply to both. `dist/index.js` rebuilt.
- The "Received ..." log line prints the caught method, path and query with control characters as `\xHH`, so a newline in a path
  can never start a `::` workflow command (security review 2026-11-16). `dist/index.js` rebuilt.

## 0.1.0 (2026-11-14)
- First version: inputs api-key, to/address, subject-contains, link-contains, since, timeout, fail-on-timeout, base-url;
  outputs code, first-link, message-id, subject, from, received-utc, timed-out. Bundled single file for `node24`.
