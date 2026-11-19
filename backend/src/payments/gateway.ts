import { Operator } from '../domain/types.js';

export type TxStatus = 'PENDING' | 'SUCCESSFUL' | 'FAILED';

export interface CollectRequest {
  amount: number;
  phone: string; // E.164
  description: string;
  externalReference: string; // our id, e.g. "order:<uuid>" or "topup:<uuid>"
}

export interface CollectResult {
  reference: string;
  operator?: Operator;
  ussdCode?: string;
}

export interface WithdrawRequest {
  amount: number;
  phone: string;
  description: string;
  externalReference: string;
}

export interface Transaction {
  reference: string;
  status: TxStatus;
  amount: number;
  externalReference?: string;
  operator?: Operator;
}

export interface WebhookNotice {
  reference: string;
  status: TxStatus;
  externalReference?: string;
}

/**
 * Mobile-money provider. Webhooks are only a hint: the service always re-reads the
 * transaction from the provider (getTransaction) before moving money in our books.
 */
export interface PaymentGateway {
  readonly name: 'campay' | 'simulated';
  collect(req: CollectRequest): Promise<CollectResult>;
  withdraw(req: WithdrawRequest): Promise<Transaction>;
  getTransaction(reference: string): Promise<Transaction>;
  /** Returns the parsed notice if the webhook is authentic, otherwise null. */
  parseWebhook(params: Record<string, unknown>): WebhookNotice | null;
}
