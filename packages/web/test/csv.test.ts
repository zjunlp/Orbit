import { expect, it } from "vitest";
import { parseDelimited } from "../src/lib/csv.ts";

it("keeps a separator inside quotes in the same field", () => {
  expect(parseDelimited('a,b\n1,"passed first try, no retries"\n', ",")).toEqual([
    ["a", "b"],
    ["1", "passed first try, no retries"],
  ]);
});

it("unescapes doubled quotes and keeps quotes inside a field", () => {
  expect(parseDelimited('say "hi",2\n"she said ""no""",3\n', ",")).toEqual([
    ['say "hi"', "2"],
    ['she said "no"', "3"],
  ]);
});

it("keeps a newline inside quotes and splits CRLF rows once", () => {
  expect(parseDelimited('a,b\r\n"one\ntwo",2\r\n', ",")).toEqual([
    ["a", "b"],
    ["one\ntwo", "2"],
  ]);
});

it("accepts a missing final newline and skips blank lines", () => {
  expect(parseDelimited("a,b\n1,2", ",")).toEqual([
    ["a", "b"],
    ["1", "2"],
  ]);
  expect(parseDelimited("a,b\n\n1,2\n", ",")).toEqual([
    ["a", "b"],
    ["1", "2"],
  ]);
});

it("splits TSV on tabs only", () => {
  expect(parseDelimited('x\ty\n"a,b"\tc\n', "\t")).toEqual([
    ["x", "y"],
    ["a,b", "c"],
  ]);
});

it("stops after the row limit", () => {
  const rows = parseDelimited("a\n1\n2\n3\n", ",", 3);
  expect(rows).toHaveLength(3);
});
