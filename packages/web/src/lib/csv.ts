/**
 * Splits delimited text into rows of fields, following RFC 4180: a field may be quoted, `""`
 * inside a quoted field is a literal quote, and a separator or newline inside quotes stays part of
 * the field. Parsing stops after `limit` rows so a large file cannot freeze the preview.
 */
export function parseDelimited(text: string, sep: string, limit = 1001): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  while (i < text.length && rows.length < limit) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      i++;
      continue;
    }
    if (ch === sep) {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      row.push(field);
      field = "";
      // A CRLF pair ends one row, not two.
      i += ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      rows.push(row);
      row = [];
      continue;
    }
    field += ch;
    i++;
  }
  // Trailing data without a final newline still belongs to a row.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}
