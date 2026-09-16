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
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  convertFile,
  findPoFiles,
  parseHeaders,
  parsePo,
  poToJed,
} from '../../scripts/internal/po2json';

const PO = `# French translations for Superset.
msgid ""
msgstr ""
"Project-Id-Version: Superset VERSION\\n"
"Language: fr\\n"
"Plural-Forms: nplurals=2; plural=(n > 1);\\n"
"Content-Type: text/plain; charset=utf-8\\n"

#: superset/views/core.py:10
msgid "Dashboards"
msgstr "Tableaux de bords"

#, fuzzy
msgid "Charts"
msgstr "Graphiques"

msgid "Untranslated"
msgstr ""

msgid "Multi"
"line \\"quoted\\"\\tid"
msgstr ""
"première\\n"
"seconde"

msgctxt "menu"
msgid "Open"
msgstr "Ouvrir"

msgid "%s row"
msgid_plural "%s rows"
msgstr[0] "%s ligne"
msgstr[1] ""

#~ msgid "Obsolete"
#~ msgstr "Obsolète"
`;

test('parsePo reads entries in file order and skips obsolete ones', () => {
  const entries = parsePo(PO);
  expect(entries.map(e => e.msgid)).toEqual([
    '',
    'Dashboards',
    'Charts',
    'Untranslated',
    'Multiline "quoted"\tid',
    'Open',
    '%s row',
  ]);
  expect(entries[4].msgstr).toEqual(['première\nseconde']);
  expect(entries[5].msgctxt).toBe('menu');
  expect(entries[6]).toEqual({
    msgid: '%s row',
    msgid_plural: '%s rows',
    msgstr: ['%s ligne', ''],
  });
});

test('parsePo rejects malformed input', () => {
  expect(() => parsePo('"dangling"')).toThrow(/continuation/);
  expect(() => parsePo('msgstr "no id"')).toThrow(/without msgid/);
  expect(() => parsePo('msgid "unterminated')).toThrow(/Malformed/);
  expect(() => parsePo('bogus "x"')).toThrow(/Unrecognized/);
});

test('parseHeaders lowercases keys and trims values', () => {
  expect(parseHeaders('Language: fr\nPlural-Forms:  nplurals=2;\n')).toEqual({
    language: 'fr',
    'plural-forms': 'nplurals=2;',
  });
});

test('poToJed produces the Jed 1.x catalog shape', () => {
  expect(poToJed(PO, 'superset')).toEqual({
    domain: 'superset',
    locale_data: {
      superset: {
        '': {
          domain: 'superset',
          plural_forms: 'nplurals=2; plural=(n > 1);',
          lang: 'fr',
        },
        Dashboards: ['Tableaux de bords'],
        Charts: ['Graphiques'],
        Untranslated: [''],
        'Multiline "quoted"\tid': ['première\nseconde'],
        'menu\u0004Open': ['Ouvrir'],
        '%s row': ['%s ligne', '%s rows'],
      },
    },
  });
});

test('poToJed keeps the last of duplicated msgids', () => {
  const catalog = poToJed(
    'msgid "a"\nmsgstr "1"\n\nmsgid "a"\nmsgstr "2"\n',
    'd',
  );
  expect(catalog.locale_data.d.a).toEqual(['2']);
});

test('convertFile writes messages.json next to every .po found', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'po2json-'));
  const poPath = path.join(dir, 'fr', 'LC_MESSAGES', 'messages.po');
  fs.mkdirSync(path.dirname(poPath), { recursive: true });
  fs.writeFileSync(poPath, PO);
  fs.writeFileSync(path.join(dir, 'messages.pot'), PO);

  expect(findPoFiles(dir)).toEqual([poPath]);
  const jsonPath = convertFile(poPath, 'superset');
  expect(jsonPath).toBe(path.join(dir, 'fr', 'LC_MESSAGES', 'messages.json'));
  expect(JSON.parse(fs.readFileSync(jsonPath, 'utf8'))).toEqual(
    poToJed(PO, 'superset'),
  );
  fs.rmSync(dir, { recursive: true });
});
