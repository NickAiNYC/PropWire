import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSandbox,
  loadApp,
  attachSyntheticQuote,
  authorizeSyntheticExecution,
} from './helpers/sandbox.mjs';

async function setup() {
  const { sandbox, lsStore, registry } = buildSandbox();
  const P = loadApp(sandbox);
  await P.loadSlate('2026_w7');
  const quote = attachSyntheticQuote(P);
  P.state.filters.market = 'receiving_yards';
  P.state.portfolio = [];
  return { P, quote, lsStore, registry, row: P.state.slate.find((item) => item.player_id === quote.player_id) };
}

test('unverified quote is blocked in both the decision and mutation paths', async () => {
  const { P, quote, row, lsStore } = await setup();
  P.state.userTier = 'sharp';
  const decision = P.executionDecision(row);
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'unverified');
  P.logBet(quote.player_id);
  assert.equal(P.state.portfolio.length, 0);
  assert.equal(lsStore.get('propwire_portfolio_ledger_v2'), undefined);
});

test('stale odds block an otherwise verified and entitled quote', async () => {
  const { P, quote, row } = await setup();
  authorizeSyntheticExecution(P, quote);
  P.state.feedHealth.oddsUpdatedAt = '2026-10-01T00:00:00Z';
  const decision = P.executionDecision(row);
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'stale_odds');
  P.logBet(quote.player_id);
  assert.equal(P.state.portfolio.length, 0);
});

test('client-side entitlement escalation is impossible and defaults closed', async () => {
  const { P, quote, row } = await setup();
  authorizeSyntheticExecution(P, quote);
  P.state.userTier = 'free';
  const decision = P.executionDecision(row);
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, 'unauthorized');
  P.logBet(quote.player_id);
  assert.equal(P.state.portfolio.length, 0);
});

test('only explicit confirmation of a complete, fresh, verified, entitled quote creates a wager record', async () => {
  const { P, quote, row, lsStore, registry } = await setup();
  authorizeSyntheticExecution(P, quote);
  const decision = P.executionDecision(row);
  assert.equal(decision.allowed, true);
  P.logBet(quote.player_id);
  assert.equal(P.state.portfolio.length, 0, 'reviewing a slip must not write to the ledger');
  assert.equal(registry.get('#executionDialog').open, true);
  assert.match(registry.get('#executionContent').innerHTML, /Cross-book comparison/);
  assert.match(registry.get('#executionContent').innerHTML, /I placed this bet/);
  assert.equal(P.confirmExecution(quote.player_id), true);
  assert.equal(P.state.portfolio.length, 1);
  const stored = JSON.parse(lsStore.get('propwire_portfolio_ledger_v2'));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].line, quote.line);
  assert.equal(stored[0].odds, quote.over_odds);
});

test('confirmation rechecks the guard and fails closed if the quote becomes stale', async () => {
  const { P, quote } = await setup();
  authorizeSyntheticExecution(P, quote);
  P.logBet(quote.player_id);
  P.state.feedHealth.oddsUpdatedAt = '2026-10-01T00:00:00Z';
  assert.equal(P.confirmExecution(quote.player_id), false);
  assert.equal(P.state.portfolio.length, 0);
});
