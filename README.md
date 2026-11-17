# MailPier Inbox wait (GitHub Action)

Waits for an email in a [MailPier Inbox](https://mailpier.io) environment and outputs its one-time code, first link, id and
subject, so a later step can use them. With `wait-for: webhook` it waits for a request to the environment's webhook URL instead
and outputs its method, path and body. Docs: https://mailpier.io/docs#github

## Quick start

```yaml
- uses: mailpier/inbox-wait-action@v0
  id: mail
  with: { api-key: "${{ secrets.MAILPIER_API_KEY }}", to: "${{ env.SIGNUP_EMAIL }}", subject-contains: Confirm }
- run: ./confirm-account.sh "${{ steps.mail.outputs.code }}" "${{ steps.mail.outputs.first-link }}"
```

## Inputs

| Input | Default | |
|---|---|---|
| `api-key` | (required) | MailPier Inbox API key (`mpi_...`), from a secret. |
| `wait-for` | `email` | `email` (a mail to `to`) or `webhook` (a request to the environment's webhook URL under `path`). |
| `to` (alias `address`) | (required for email) | The address the mail was sent to. |
| `subject-contains` | | Only a mail whose subject contains this (case-insensitive). |
| `link-contains` | | `first-link` is the first link whose URL or text contains this. |
| `path` | (required for webhook) | Only a request whose path after the token starts with this (`/` for any). |
| `method` | | Only a request with this HTTP method (webhook). |
| `since` | | Only a mail or request received at or after this ISO 8601 time. |
| `timeout` | `120` | Seconds to wait in total (long-polls of up to 120 s each). |
| `fail-on-timeout` | `true` | `false` sets `timed-out=true` and lets the job continue. |
| `base-url` | `https://api.mailpier.io` | API root. |

## Outputs

Email: `code`, `first-link`, `message-id`, `subject`, `from`, `received-utc`, `timed-out`.

Webhook: `request-id`, `method`, `path`, `body` (text; empty for a binary body), `json` (the body as JSON text; empty when it is
not JSON), `timed-out`.

## Webhooks

Every environment has a webhook URL (`https://hook.gather-io.com/<token>`, shown on the environment's **Webhooks** tab): any
request to it, or to any path below it, is caught. Give your app a unique path per run and wait for it:

```yaml
env:
  HOOK_URL: ${{ vars.MAILPIER_WEBHOOK_URL }}/order-${{ github.run_id }}   # your environment's webhook URL + a unique path
steps:
  - name: Pay an order on the test site (it sends the order.paid webhook to HOOK_URL)
    run: curl -fsS -X POST https://test.example.com/api/orders/42/pay -d "webhookUrl=$HOOK_URL"
  - uses: mailpier/inbox-wait-action@v0
    id: hook
    with:
      api-key: ${{ secrets.MAILPIER_API_KEY }}
      wait-for: webhook
      path: /order-${{ github.run_id }}
      method: POST
      timeout: 60
  - env:
      HOOK_JSON: ${{ steps.hook.outputs.json }}
    run: test "$(jq -r .event <<< "$HOOK_JSON")" = "order.paid"
```

Read `body` and `json` through `env:` as above, never by pasting `${{ steps.hook.outputs.body }}` into a script: anyone who knows
the URL can post to it. The same file is in `examples/webhook-e2e.yml`. Requests are deleted with the environment's mail
retention.

## Full workflow example

```yaml
name: e2e
on: [push]
jobs:
  signup:
    runs-on: ubuntu-latest
    env:
      SIGNUP_EMAIL: ci-${{ github.run_id }}@qa.acme.mailpier.io   # any address of your environment works
    steps:
      - uses: actions/checkout@v4
      - name: Sign up on the test site (it sends the confirmation mail)
        run: curl -fsS -X POST https://test.example.com/api/signup -d "email=$SIGNUP_EMAIL"
      - uses: mailpier/inbox-wait-action@v0
        id: mail
        with:
          api-key: ${{ secrets.MAILPIER_API_KEY }}
          to: ${{ env.SIGNUP_EMAIL }}
          subject-contains: Confirm
          link-contains: verify
          timeout: 180
      - name: Confirm with the code
        run: curl -fsS -X POST https://test.example.com/api/confirm -d "email=$SIGNUP_EMAIL&code=${{ steps.mail.outputs.code }}"
      - name: Or open the link
        run: curl -fsS "${{ steps.mail.outputs.first-link }}"
```

The same file is in `examples/signup-e2e.yml`. The action is a single bundled file (`dist/index.js`, Node 24, no `npm install`
at run time); it masks the API key and writes outputs with the multi-line-safe `$GITHUB_OUTPUT` syntax. 429 answers are retried
after `Retry-After`, 5xx and network errors with backoff.

## Develop

`npm install`, `npm run build` (rebuilds `dist/index.js` from `src/` and the Node client in `../node/src`: commit `dist/` with
every change), `npm test` (vitest against the fake MailPier API, including a run of `dist/index.js` as a separate process).

License: MIT.
