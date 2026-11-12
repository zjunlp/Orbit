# Claude Code trajectory fixture

`claude.jsonl` was produced by whitelisting conversation and attachment records from one real
Claude Code 2.1.319 development Run. Record order, UUID/parent relationships, shared model-message
IDs, content-block kinds, tool names, and block indices retain the observed native structure.
Text, tool inputs/results, identifiers, timestamps, model names, signatures, and token quantities
are deterministic synthetic replacements. Attachments have a synthetic rendered text payload.
Bookkeeping records and all unlisted fields were removed.

This is a sanitized structural fixture, not a raw Run artifact or a benchmark task/answer.
`claude.atif.json` is the reviewed expected conversion. Edge cases in `atif-claude.test.ts` are
explicit synthetic fixtures, including preserved UUIDs around compaction and sidechain files.
