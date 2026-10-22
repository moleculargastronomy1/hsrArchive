import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { consume, defaultPolicy, parsePolicy } from '../worker/policy.ts';
import { consumeBehavior, behaviorLifetime } from '../worker/behavior.ts';

// Virtual time exercises the same policies used inside the real DO transaction.
// It measures enforced waiting, not real network/cloud latency or a bot classifier.
function guard(policy = defaultPolicy) {
  let short: any, long: any;
  return (session: string, kind: string, files: string[], now: number) => {
    const quick = consume(short, session, kind, files, now, policy);
    short = quick.usage;
    const steady = consumeBehavior(
      long,
      quick.allowed || kind === 'trap' ? kind : 'other',
      files,
      now,
      policy,
    );
    long = steady.usage;
    return !steady.allowed ? steady : quick;
  };
}
function collect(interval: number, ipCount = 1) {
  const guards = Array.from({ length: ipCount }, () => guard());
  let now = Date.UTC(2026, 9, 22, 23, 50),
    accepted = 0,
    denied = 0;
  const started = now;
  const reasons: Record<string, number> = {};
  while (accepted < 2840) {
    const index = accepted % ipCount;
    const result = guards[index](
      'rotated-' + Math.floor(accepted / 30),
      'page',
      ['chapter-' + accepted],
      now,
    );
    if (result.allowed) {
      accepted++;
      now += interval;
    } else {
      denied++;
      reasons[result.reason] = (reasons[result.reason] ?? 0) + 1;
      now += Math.max(interval, result.retryAfter * 1000);
    }
    assert.ok(denied < 100000, 'Retry must eventually allow reading');
  }
  return { accepted, denied, simulatedSeconds: (now - started) / 1000, reasons };
}

test('ordinary readers sharing an IP keep search, context and three-language comparison smooth over four hours', () => {
  const check = guard();
  let accepted = 0;
  for (let tick = 0; tick < 80; tick++) {
    for (let reader = 0; reader < 5; reader++) {
      const now = tick * 180000 + reader * 1000;
      const file = `reader-${reader}-chapter-${tick}`;
      for (const kind of ['page', 'page', 'page', 'page', 'page', 'search']) {
        assert.equal(
          check('reader-' + reader, kind, kind === 'search' ? [] : [file], now).allowed,
          true,
        );
        accepted++;
      }
    }
  }
  assert.equal(accepted, 2400);
});

test('five readers may compare all three languages on 50 distinct book search results without false chapter-sweep limits', () => {
  const check = guard();
  for (let reader = 0; reader < 5; reader++) {
    assert.equal(check('reader-' + reader, 'search', [], 0).allowed, true);
    for (const language of ['en', 'zh-CN', 'ja'])
      for (let offset = 0; offset < 50; offset += 8) {
        const files = Array.from(
          { length: Math.min(8, 50 - offset) },
          (_, i) => `reader-${reader}-book-${offset + i}`,
        );
        assert.equal(check('reader-' + reader, 'page', files, 0).allowed, true, language);
      }
  }
});

test('chapter sweeps, bursts, slow collection, very slow and distributed bypasses are measured explicitly', async () => {
  const rapid = collect(1000);
  const slow = collect(10000);
  const verySlow = collect(30000);
  const distributed = collect(1000, 10);
  assert.ok(rapid.denied > 0 && rapid.reasons['sustained-chapter'] > 0);
  assert.ok(slow.denied > 0 && slow.reasons['sustained-chapter'] > 0);
  assert.ok(rapid.simulatedSeconds >= ((2840 - 360) / 180) * 3600);
  assert.equal(verySlow.denied, 0); // Below the sustained allowance remains possible.
  assert.ok(distributed.simulatedSeconds < rapid.simulatedSeconds);
  const result = {
    schema: 'hsr-collection-simulation.v1',
    chapterCount: 2840,
    rapid,
    slow,
    verySlow,
    distributed,
  };
  await fs.mkdir('.cache', { recursive: true });
  await fs.writeFile('.cache/anti-collection-results.json', JSON.stringify(result, null, 2));
});

test('repeated sync and many pages in one chapter consume long budgets; rotation and clearance cannot reset them', () => {
  const policy = parsePolicy(JSON.stringify({ sustainedReads: 2, sustainedReadsPerHour: 1 }));
  let state: any;
  for (let i = 0; i < 2; i++) {
    const result = consumeBehavior(state, 'page', ['same-chapter'], 1000, policy);
    assert.equal(result.allowed, true);
    state = result.usage;
  }
  const denied = consumeBehavior(state, 'page', ['same-chapter'], 61000, policy);
  assert.equal(denied.reason, 'sustained-read');
  assert.equal(denied.retryAfter, 3540);
  assert.equal(
    consumeBehavior(denied.usage, 'page', ['same-chapter'], 3601000, policy).allowed,
    true,
  );
  assert.ok(behaviorLifetime(policy) > 7200);
  const batch = consumeBehavior(
    undefined,
    'page',
    Array.from({ length: 8 }, (_, i) => 'chapter-' + i),
    0,
    defaultPolicy,
  );
  assert.equal(batch.usage.chapter?.tokens, 352);
  assert.equal(
    consumeBehavior(batch.usage, 'page', ['chapter-0'], 1, defaultPolicy).usage.chapter?.tokens! >
      352,
    true,
  );
});

test('one export probe never blocks; repeated probes cause a brief cooldown with no fake game data', () => {
  let state: any;
  for (let i = 0; i < 3; i++) {
    state = consumeBehavior(state, 'trap', [], 1000 + i, defaultPolicy).usage;
    const read = consumeBehavior(state, 'page', ['chapter'], 1005, defaultPolicy);
    assert.equal(read.allowed, i < 2);
  }
  const denied = consumeBehavior(state, 'page', ['chapter'], 1005, defaultPolicy);
  assert.equal(denied.reason, 'trap-cooldown');
  assert.equal(denied.retryAfter, 60);
  assert.equal(consumeBehavior(state, 'page', ['chapter'], 61003, defaultPolicy).allowed, true);
  // Export-probe evidence ages out independently of read budgets.
  const later = consumeBehavior(state, 'trap', [], 601003, defaultPolicy);
  assert.equal(later.usage.trapHits, 1);
});

test('six-hour external synchronization attempts stay limited across releases while slower reading is allowed', () => {
  const check = guard();
  for (let cycle = 0; cycle < 4; cycle++) {
    let denied = 0;
    for (let i = 0; i < 2840; i++) {
      const result = check(
        `release-${cycle}-session-${Math.floor(i / 30)}`,
        'page',
        ['chapter-' + i],
        cycle * 21600000 + i * 1000,
      );
      if (!result.allowed) denied++;
    }
    assert.ok(denied > 2000, 'Each synchronization sweep must be curtailed');
  }
});
