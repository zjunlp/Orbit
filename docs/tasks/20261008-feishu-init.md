# Feishu bot setup by QR code
branch: feat/feishu-init · status: completed · updated: 2026-10-08

## Goal
`orbit feishu init` creates a Feishu bot by scanning a QR code with the Feishu app, saves it paired with
the scanner and checks it, instead of setting the app up by hand in the developer console.

## Changes
- CLI `feishu init [name]`: SDK `registerApp` (device flow, `createOnly`), QR in the terminal (`uqr` 0.1.3,
  exact, no dependencies), pre-filled bot permissions and `im.message.receive_v1`; saves the target with the
  scanner's open_id; then the same check as `feishu check`.
- CLI `feishu check <name>`: `POST notify/:name/reconnect`, waits up to 30 s for the long connection, sends a
  test card, prints the console page to fix on failure (exit 1).
- Store: one `feishu-app` target per app id (`NotifyError`, HTTP 400).

## Validation
| Check | Revision | Result | Notes |
| --- | --- | --- | --- |
| `pnpm verify` | working tree | passed | 13 tests in `feishu.test.ts` (fake registration and client) |
| `orbit feishu check <name>` on the real daemon | working tree | passed | connected, test card sent |
| `orbit feishu init` up to the QR code | working tree | passed | QR printed, aborted before scanning, nothing saved |
| Scan and create a new app | 7ae06c3 | passed | QR flow created a connected app paired with the scanner |

## Next / open issues
- If new apps do not default to the long connection, `check` tells the user to switch it in the console.
