# Feishu app: phone access through a long connection
branch: feat/feishu-app · status: completed · updated: 2026-10-08

## Goal
Check experiments and GPU / CPU state from a phone in Feishu without exposing the daemon: run and group
cards with metric curves, and read-only `/gpu`, `/runs`, `/show <id>` for paired users.

## Changes
- Contract: `NotifyTargetInput` is a union of webhook targets and `feishu-app` `{ appId, appSecret, users[] }`;
  public `NotifyTarget` adds `users` and `connection`; `NotifyPairInput`.
- `notify/feishu.ts`: OpenAPI client (cached tenant token) and Card 2.0 layouts (run, group, resources, runs).
  Curves: at most 2 series, `loss` first, 200 points, plain lines (palette blue checked with the dataviz validator).
- `feishu/`: one `WSClient` per app target (SDK `@larksuiteoapi/node-sdk` 1.74.0, exact, lazy import,
  `wsConfig.pingTimeout = 3` as in OpenClaw), pairing codes, mention rule in groups, in-memory dedup,
  commands through `app.request()` on the daemon's own API.
- Daemon: notifier gets run metrics; `POST notify/:name/pair`; saving or removing targets resyncs bots.
- CLI: `notify add --kind feishu-app --app-id --secret-stdin|--secret-env`, `notify pair`, list shows users
  and connection. Boundaries: `feishu` → core + notify; daemon → feishu. Docs: design §3/§5/§6, READMEs.

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | working tree | passed | 124 orbit tests (9 new in `feishu.test.ts`, fakes for SDK and OpenAPI) |
| Probe: token, long connection, receive, send cards | /tmp scripts | passed | Test message received; text, chart, table, column cards rendered on a phone |
| Chart marks (`markPoint` / `markLine`) | /tmp scripts | failed | not rendered by Feishu; dropped, plain curves kept |
| Real daemon: long connection, pairing by code | working tree | passed | `notify list` confirms connection and pairing |
| Real daemon: `notify test`, run card after a real run with metrics | working tree | passed | sent without errors in the daemon log; seen on the phone by the user |
| `/gpu` `/runs` `/show` on the phone | working tree | not_run | Phone command replies were not confirmed |

## Next / open issues
- Dedup is in memory: a redelivery right after a daemon restart could answer twice (harmless for read-only commands).
- No write commands (cancel, submit) by design for now.
