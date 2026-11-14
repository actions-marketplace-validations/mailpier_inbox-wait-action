# MailPier Inbox wait (GitHub Action)

Waits for an email in a [MailPier Inbox](https://mailpier.io) environment and outputs its one-time code, first link, id and
subject, so a later step can use them. Planned public name `mailpier/inbox-wait-action` (not published yet).

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
| `to` (alias `address`) | (required) | The address the mail was sent to. |
| `subject-contains` | | Only a mail whose subject contains this (case-insensitive). |
| `link-contains` | | `first-link` is the first link whose URL or text contains this. |
| `since` | | Only mail received at or after this ISO 8601 time. |
| `timeout` | `120` | Seconds to wait in total (long-polls of up to 120 s each). |
| `fail-on-timeout` | `true` | `false` sets `timed-out=true` and lets the job continue. |
| `base-url` | `https://api.mailpier.io` | API root. |

## Outputs

`code`, `first-link`, `message-id`, `subject`, `from`, `received-utc`, `timed-out`.

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
