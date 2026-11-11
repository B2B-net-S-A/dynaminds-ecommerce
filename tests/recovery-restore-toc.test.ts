import assert from 'node:assert/strict';
import test from 'node:test';
import { splitRestoreEventTriggers } from '../server/recovery-restore-toc';

test('defers event triggers and their metadata while preserving other dump order', () => {
  const lines = [
    '; Archive created at 2026-10-15',
    '10; 1255 42 FUNCTION public ordinary182_invalidate() postgres',
    '11; 1259 43 TABLE public ordinary182_runtime_generation postgres',
    '12; 0 43 TABLE DATA public ordinary182_runtime_generation postgres',
    '13; 0 0 ACL public TABLE ordinary182_runtime_generation postgres',
    '14; 3466 44 EVENT TRIGGER - ordinary182_schema_ddl postgres',
    '15; 0 0 COMMENT - EVENT TRIGGER ordinary182_schema_ddl postgres',
    '16; 0 0 SECURITY LABEL - EVENT TRIGGER ordinary182_schema_ddl postgres',
    '17; 2620 45 TRIGGER public business_table business_trigger postgres',
  ];
  const result = splitRestoreEventTriggers(lines.join('\n'));
  assert.equal(result.entries, 3);
  assert.equal(result.ordinary, [...lines.slice(0, 5), lines[8]].join('\n') + '\n');
  assert.equal(result.deferred, lines.slice(5, 8).join('\n') + '\n');
});
test('empty event-trigger selection does not defer functions, comments or ordinary triggers', () => {
  const toc = '; EVENT TRIGGER in archive header\n1; 1255 5 FUNCTION public event_trigger_helper() postgres\n2; 0 0 COMMENT public FUNCTION event_trigger_helper() postgres\n';
  const result = splitRestoreEventTriggers(toc);
  assert.equal(result.entries, 0);
  assert.equal(result.ordinary, toc + '\n');
});
