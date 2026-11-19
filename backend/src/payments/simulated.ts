import { randomUUID } from 'node:crypto';
import { detectOperator } from '../domain/phone.js';
import { CollectRequest, CollectResult, PaymentGateway, Transaction, WebhookNotice, WithdrawRequest } from './gateway.js';

/**
 * Local stand-in for a mobile-money provider. Collections stay PENDING until approve()/fail()
 * is called (from tests, or the dev-only HTTP endpoint). Never enabled in production.
 */
export class SimulatedGateway implements PaymentGateway {
  readonly name = 'simulated' as const;
  private readonly txs = new Map<string, Transaction>();
  /** Phones whose withdrawals fail, to exercise payout retries in tests. */
  readonly failingPayoutPhones = new Set<string>();
  readonly withdrawals: WithdrawRequest[] = [];

  async collect(req: CollectRequest): Promise<CollectResult> {
    const reference = `SIM-${randomUUID()}`;
    const operator = detectOperator(req.phone);
    this.txs.set(reference, { reference, status: 'PENDING', amount: req.amount, externalReference: req.externalReference, operator });
    return { reference, operator, ussdCode: operator === 'ORANGE' ? '#150*50#' : '*126#' };
  }

  async withdraw(req: WithdrawRequest): Promise<Transaction> {
    if (this.failingPayoutPhones.has(req.phone)) throw new Error('Simulated payout failure');
    this.withdrawals.push(req);
    const reference = `SIMW-${randomUUID()}`;
    const tx: Transaction = { reference, status: 'SUCCESSFUL', amount: req.amount, externalReference: req.externalReference };
    this.txs.set(reference, tx);
    return tx;
  }

  async getTransaction(reference: string): Promise<Transaction> {
    const tx = this.txs.get(reference);
    if (!tx) throw new Error(`Unknown simulated transaction ${reference}`);
    return { ...tx };
  }

  parseWebhook(params: Record<string, unknown>): WebhookNotice | null {
    const reference = typeof params.reference === 'string' ? params.reference : '';
    return this.txs.has(reference) ? { reference, status: this.txs.get(reference)!.status } : null;
  }

  approve(reference: string, amount?: number) {
    const tx = this.txs.get(reference);
    if (!tx) throw new Error(`Unknown simulated transaction ${reference}`);
    tx.status = 'SUCCESSFUL';
    if (amount !== undefined) tx.amount = amount; // lets tests simulate an amount mismatch
  }

  fail(reference: string) {
    const tx = this.txs.get(reference);
    if (tx) tx.status = 'FAILED';
  }
}
