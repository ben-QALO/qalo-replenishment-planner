// File decoding + delimited-text parsing (RFC 4180 quotes, tab or comma).

export function decodeBuffer(buf: Buffer): string {
  // UTF-16 BOMs first, then UTF-8 (with or without BOM).
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString('utf16le').replace(/^﻿/, '');
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16BE: swap byte pairs, then decode as LE.
    const swapped = Buffer.alloc(buf.length - 2);
    for (let i = 2; i + 1 < buf.length; i += 2) {
      swapped[i - 2] = buf[i + 1];
      swapped[i - 1] = buf[i];
    }
    return swapped.toString('utf16le');
  }
  return buf.toString('utf8').replace(/^﻿/, '');
}

export function sniffDelimiter(text: string): '\t' | ',' | ';' {
  const header = text.slice(0, text.indexOf('\n') === -1 ? text.length : text.indexOf('\n'));
  const scores: Array<['\t' | ',' | ';', number]> = [
    ['\t', (header.match(/\t/g) ?? []).length],
    [',', (header.match(/,/g) ?? []).length],
    [';', (header.match(/;/g) ?? []).length],
  ];
  scores.sort((a, b) => b[1] - a[1]);
  return scores[0][1] > 0 ? scores[0][0] : ',';
}

/** Minimal RFC-4180 parser: quoted fields, escaped quotes, embedded delimiters/newlines. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const push = () => { row.push(field); field = ''; };
  const pushRow = () => {
    // skip fully empty trailing lines
    if (row.length > 1 || (row.length === 1 && row[0].trim() !== '')) rows.push(row);
    row = [];
  };
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === delimiter) { push(); i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { push(); pushRow(); i++; continue; }
    field += c; i++;
  }
  if (field !== '' || row.length > 0) { push(); pushRow(); }
  return rows;
}

export interface ParsedFile {
  headers: string[];
  records: Record<string, string>[];
  delimiter: string;
}

export function parseFile(buf: Buffer): ParsedFile {
  const text = decodeBuffer(buf);
  const delimiter = sniffDelimiter(text);
  const rows = parseDelimited(text, delimiter);
  if (rows.length === 0) return { headers: [], records: [], delimiter };
  const headers = rows[0].map(h => h.trim());
  const records = rows.slice(1).map(cells => {
    const rec: Record<string, string> = {};
    headers.forEach((h, idx) => { rec[h] = (cells[idx] ?? '').trim(); });
    return rec;
  });
  return { headers, records, delimiter };
}
