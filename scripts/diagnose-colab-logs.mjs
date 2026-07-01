#!/usr/bin/env node
// Tally colab_ws lifecycle logs to decide WHERE connections fail.
// Usage: node scripts/diagnose-colab-logs.mjs <logfile.ndjson>
// Accepts NDJSON where each line is either a raw colab_ws payload object
// or a wrapper containing one (e.g. {"jsonPayload": {...}} from gcloud).

import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/diagnose-colab-logs.mjs <logfile.ndjson>');
  process.exit(1);
}

const lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());

const events = new Map();
const authFailureReasons = new Map();
const closeCodes = new Map();
let staleSocketCloses = 0; // opened, then closed unauthenticated with reason "Stale socket"
const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

let parsed = 0;
for (const line of lines) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    continue;
  }
  // Unwrap common log shapes.
  const p = obj.scope === 'colab_ws' ? obj : obj.jsonPayload ?? obj.payload ?? obj;
  if (!p || p.scope !== 'colab_ws' || typeof p.event !== 'string') continue;
  parsed += 1;
  bump(events, p.event);
  if (p.event === 'auth_failure' && typeof p.reason === 'string') bump(authFailureReasons, p.reason);
  if (p.event === 'connection_closed' && p.code !== undefined) {
    bump(closeCodes, String(p.code));
    if (p.authenticated === false && p.reason === 'Stale socket') staleSocketCloses += 1;
  }
}

const get = (map, key) => map.get(key) ?? 0;
const opened = get(events, 'connection_opened');
const authReceived = get(events, 'auth_message_received');
const authSuccess = get(events, 'auth_success') || get(events, 'workspace_joined');
const authFailure = get(events, 'auth_failure');
const authTimeout = get(events, 'auth_timeout_termination');
const heartbeatKills = get(events, 'heartbeat_termination');

const sorted = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);

console.log(`\nParsed ${parsed} colab_ws events from ${lines.length} lines\n`);
console.log('=== Event counts ===');
for (const [event, count] of sorted(events)) console.log(`  ${String(count).padStart(5)}  ${event}`);

if (authFailureReasons.size) {
  console.log('\n=== auth_failure reasons ===');
  for (const [reason, count] of sorted(authFailureReasons)) console.log(`  ${String(count).padStart(5)}  ${reason}`);
}
if (closeCodes.size) {
  console.log('\n=== connection_closed codes ===');
  for (const [code, count] of sorted(closeCodes)) console.log(`  ${String(count).padStart(5)}  code ${code}`);
}

console.log('\n=== Funnel ===');
console.log(`  opened socket .......... ${opened}`);
console.log(`  sent auth message ...... ${authReceived}`);
console.log(`  authenticated OK ....... ${authSuccess}`);
console.log(`  auth_failure ........... ${authFailure}`);
console.log(`  auth timed out (no auth) ${authTimeout}`);
console.log(`  heartbeat killed ....... ${heartbeatKills}`);
console.log(`  "Stale socket" closes .. ${staleSocketCloses}`);

console.log('\n=== VERDICT ===');
if (opened === 0) {
  console.log('  No connection_opened at all → connections NEVER REACH the backend.');
  console.log('  → TRANSPORT problem (Next.js rewrite WS-upgrade / proxy / load balancer). Not an app-auth bug.');
} else if (staleSocketCloses > 0 && authFailure === 0 && heartbeatKills === 0) {
  console.log(`  ${staleSocketCloses} socket(s) opened then self-closed unauthenticated as "Stale socket".`);
  console.log('  → CLIENT effect race: the React connection effect is disposed before onopen sends auth');
  console.log('    (app/collab/page.tsx). Backend is healthy (no auth_failure / heartbeat kills).');
} else if (authReceived < opened * 0.8 && authTimeout > 0) {
  console.log('  Sockets open but many never send a valid auth (auth_timeout_termination).');
  console.log('  → Client-side: ticket missing/late or auth frame lost. Look at the frontend ticket gate.');
} else if (authFailure > 0) {
  const top = sorted(authFailureReasons)[0];
  console.log(`  Sockets reach auth but are REJECTED. Dominant reason: ${top ? top[0] : 'unknown'}.`);
  console.log('  → Map the reason: invalid_join_ticket=secret/expiry; user_mismatch/workspace_mismatch=identity;');
  console.log('    replay_detected=ticket reuse; missing_join_ticket=empty token from client.');
} else if (heartbeatKills > 0 && authSuccess > 0) {
  console.log('  Users authenticate then get heartbeat-terminated → DROP after connect, not "never connect".');
} else {
  console.log('  Mixed / inconclusive. Eyeball the event counts above.');
}
console.log('');
