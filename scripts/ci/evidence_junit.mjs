// JUnit view of the Compose regression evidence (for the MR test widget and the LLM review).
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { evidenceChecks } from './release_gate.mjs';

const rules = JSON.parse(readFileSync('scripts/ci/release-rules.json', 'utf8'));
const fs = { exists: p => existsSync(resolve(p)), read: p => readFileSync(resolve(p), 'utf8'), list: p => readdirSync(resolve(p)) };
const xml = s => String(s).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const checks = evidenceChecks(rules, fs);
const cases = checks.map(c => `  <testcase classname="compose.regression" name="${xml(c.test)}" file="${xml(c.file)}">${c.passed ? '' : `<failure message="${xml(c.name)}: ${xml(c.detail)}"/>`}</testcase>`);
writeFileSync('artifacts/junit-regression.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="compose-regression" tests="${checks.length}" failures="${checks.filter(c => !c.passed).length}">\n${cases.join('\n')}\n</testsuite>\n`);
console.log(checks.map(c => `${c.passed ? 'PASS' : 'FAIL'} ${c.test}`).join('\n'));
