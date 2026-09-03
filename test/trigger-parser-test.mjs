// Regression test: node test/trigger-parser-test.mjs (from the module root, or from test/)
// Compares parseTrigger output against trigger-fixture.json (297 compendium triggers, reviewed 2026-09-02).
import { parseTrigger, generateDSID } from "../src/parser/trigger-parser.mjs";
import fs from "fs";
const fixture = JSON.parse(fs.readFileSync(new URL("./trigger-fixture.json", import.meta.url)));
let fail = 0;
for (const f of fixture) {
  const p = parseTrigger(f.trigger, { dsid: generateDSID(f.name), ownerName: f.owner });
  const got = { source: p.source, confidence: p.confidence, clauses: p.clauses.map(({events, ...c}) => c) };
  if (JSON.stringify(got) !== JSON.stringify(f.expected)) {
    fail++;
    console.log(`FAIL ${f.name} (${f.owner})\n  trigger:  ${f.trigger}\n  expected: ${JSON.stringify(f.expected.clauses)}\n  got:      ${JSON.stringify(got.clauses)}`);
  }
}
console.log(`${fixture.length - fail}/${fixture.length} passed`);
process.exit(fail ? 1 : 0);
