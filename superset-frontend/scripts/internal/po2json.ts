/**
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

// Converts gettext `.po` catalogs into the Jed 1.x JSON language packs the
// frontend loads at runtime (`superset/translations/<lang>/LC_MESSAGES/
// messages.json`, served by `/language_pack/<lang>/`).
//
// Output shape, for domain `superset`:
//
//   {
//     "domain": "superset",
//     "locale_data": {
//       "superset": {
//         "": { "domain": "superset", "plural_forms": "...", "lang": "fr" },
//         "msgid": ["msgstr"],
//         "msgid with plural": ["msgstr[0]", "msgstr[1]", ...],
//         "msgctxt\u0004msgid": ["msgstr"]
//       }
//     }
//   }
//
// Fuzzy entries are kept (Superset serves them on purpose), obsolete `#~`
// entries are dropped, and an empty plural form falls back to `msgid_plural`.
//
// Usage: tsx scripts/po2json.ts [--domain <name>] [<translations-dir>]

import fs from 'node:fs';
import path from 'node:path';

export interface PoEntry {
  msgctxt?: string;
  msgid: string;
  msgid_plural?: string;
  msgstr: string[];
}

export interface JedHeader {
  domain: string;
  plural_forms: string | undefined;
  lang: string | undefined;
}

export type JedLocaleData = { '': JedHeader } & Record<string, string[]>;

export interface JedCatalog {
  domain: string;
  locale_data: Record<string, JedLocaleData>;
}

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r' };

function unquote(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) {
    throw new Error(`Malformed PO string: ${raw}`);
  }
  const body = raw.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const chr = body[i];
    if (chr === '\\' && i + 1 < body.length) {
      i += 1;
      out += ESCAPES[body[i]] ?? body[i];
    } else {
      out += chr;
    }
  }
  return out;
}

const KEYWORD_RE =
  /^(msgctxt|msgid_plural|msgid|msgstr)(?:\[(\d+)\])?\s+(".*)$/;

type StringField = 'msgctxt' | 'msgid' | 'msgid_plural';

/** Where the next `"..."` continuation line is appended. */
interface Target {
  entry: PoEntry;
  field: StringField | 'msgstr';
  index: number;
}

function append({ entry, field, index }: Target, text: string): void {
  if (field === 'msgstr') {
    entry.msgstr[index] = (entry.msgstr[index] ?? '') + text;
  } else {
    entry[field] = (entry[field] ?? '') + text;
  }
}

/** Parse the entries of a PO file, in file order, skipping obsolete ones. */
export function parsePo(contents: string): PoEntry[] {
  const entries: PoEntry[] = [];
  let current: PoEntry | null = null;
  let target: Target | null = null;

  const flush = () => {
    if (current) {
      entries.push(current);
    }
    current = null;
    target = null;
  };

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') {
      continue;
    }
    if (line.startsWith('#')) {
      // Comments (including `#~` obsolete entries) end any continuation.
      target = null;
      continue;
    }
    if (line.startsWith('"')) {
      if (!target) {
        throw new Error(`Unexpected string continuation: ${rawLine}`);
      }
      append(target, unquote(line));
      continue;
    }
    const match = KEYWORD_RE.exec(line);
    if (!match) {
      throw new Error(`Unrecognized PO line: ${rawLine}`);
    }
    const [, keyword, pluralIndex, rawValue] = match;

    if (keyword === 'msgctxt') {
      flush();
      current = { msgctxt: '', msgid: '', msgstr: [] };
    } else if (keyword === 'msgid' && (!current || current.msgstr.length)) {
      flush();
      current = { msgid: '', msgstr: [] };
    } else if (!current) {
      throw new Error(`${keyword} without msgid: ${rawLine}`);
    }
    if (keyword === 'msgstr') {
      const index = Number(pluralIndex ?? 0);
      current.msgstr[index] = '';
      target = { entry: current, field: 'msgstr', index };
    } else {
      target = { entry: current, field: keyword as StringField, index: 0 };
    }
    append(target, unquote(rawValue));
  }
  flush();
  return entries;
}

/** Parse the `Key: Value` lines of the catalog header (the `msgid ""` entry). */
export function parseHeaders(header: string): Record<string, string> {
  const headers: Record<string, string> = {};
  header.split('\n').forEach(line => {
    const separator = line.indexOf(':');
    if (separator > 0) {
      const key = line.slice(0, separator).trim().toLowerCase();
      headers[key] = line.slice(separator + 1).trim();
    }
  });
  return headers;
}

/** Build a Jed 1.x catalog from PO file contents. */
export function poToJed(contents: string, domain: string): JedCatalog {
  const entries = parsePo(contents);
  const headerEntry = entries.find(
    e => e.msgid === '' && e.msgctxt === undefined,
  );
  const headers = parseHeaders(headerEntry?.msgstr[0] ?? '');

  const localeData = {
    '': {
      domain,
      plural_forms: headers['plural-forms'],
      lang: headers.language,
    },
  } as JedLocaleData;

  entries.forEach(entry => {
    if (entry === headerEntry) {
      return;
    }
    const key =
      entry.msgctxt !== undefined
        ? `${entry.msgctxt}\u0004${entry.msgid}`
        : entry.msgid;
    localeData[key] = Array.from(entry.msgstr, (form, index) => {
      const value = form ?? '';
      return index > 0 && value === '' && entry.msgid_plural !== undefined
        ? entry.msgid_plural
        : value;
    });
  });

  return { domain, locale_data: { [domain]: localeData } };
}

export function findPoFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(dirent => dirent.isFile() && dirent.name.endsWith('.po'))
    .map(dirent => path.join(dirent.parentPath, dirent.name))
    .sort();
}

export function convertFile(poPath: string, domain: string): string {
  const jsonPath = poPath.replace(/\.po$/, '.json');
  const catalog = poToJed(fs.readFileSync(poPath, 'utf8'), domain);
  fs.writeFileSync(jsonPath, `${JSON.stringify(catalog, null, 2)}\n`);
  return jsonPath;
}

export function main(argv: string[] = process.argv.slice(2)): void {
  let domain = 'superset';
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--domain') {
      i += 1;
      domain = argv[i];
    } else {
      positional.push(argv[i]);
    }
  }
  const translationsDir = positional[0] ?? '../superset/translations';

  findPoFiles(translationsDir).forEach(poPath => {
    const jsonPath = convertFile(poPath, domain);
    // eslint-disable-next-line no-console
    console.log(`po2json --domain ${domain} ${poPath} ${jsonPath}`);
  });
}
