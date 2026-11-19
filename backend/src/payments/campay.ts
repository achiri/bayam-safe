import { toGatewayMsisdn } from '../domain/phone.js';
import { Operator } from '../domain/types.js';
import { CollectRequest, CollectResult, PaymentGateway, Transaction, TxStatus, WebhookNotice, WithdrawRequest } from './gateway.js';
import { verifyHs256 } from './jwt.js';

interface CampayOptions {
  baseUrl: string; // https://demo.campay.net/api (sandbox) or https://www.campay.net/api (live)
  username: string;
  password: string;
  webhookKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const mapStatus = (s: unknown): TxStatus => (s === 'SUCCESSFUL' ? 'SUCCESSFUL' : s === 'FAILED' ? 'FAILED' : 'PENDING');
const mapOperator = (s: unknown): Operator | undefined => {
  const v = String(s ?? '').toUpperCase();
  return v.includes('MTN') ? 'MTN' : v.includes('ORANGE') ? 'ORANGE' : undefined;
};

/**
 * Campay (campay.net) client: collections (USSD push), withdrawals (payouts) and
 * transaction lookup. Check field names against your Campay dashboard docs before going live.
 */
export class CampayGateway implements PaymentGateway {
  readonly name = 'campay' as const;
  private token?: { value: string; expiresAt: number };
  private readonly fetch: typeof fetch;

  constructor(private readonly opts: CampayOptions) {
    this.fetch = opts.fetchImpl ?? fetch;
  }

  private async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const res = await this.request('/token/', { username: this.opts.username, password: this.opts.password }, false);
    const ttl = Number(res.expires_in ?? 3600) * 1000;
    this.token = { value: String(res.token), expiresAt: Date.now() + ttl };
    return this.token.value;
  }

  private async request(path: string, body?: unknown, auth = true): Promise<any> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = `Token ${await this.getToken()}`;
    const res = await this.fetch(`${this.opts.baseUrl.replace(/\/$/, '')}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000)
    });
    const text = await res.text();
    let data: any;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { message: text.slice(0, 200) };
    }
    if (!res.ok) {
      if (res.status === 401) this.token = undefined;
      throw new Error(`Campay ${path} failed (${res.status}): ${data.message ?? data.detail ?? 'unknown error'}`);
    }
    return data;
  }

  async collect(req: CollectRequest): Promise<CollectResult> {
    const data = await this.request('/collect/', {
      amount: String(req.amount),
      currency: 'XAF',
      from: toGatewayMsisdn(req.phone),
      description: req.description.slice(0, 100),
      external_reference: req.externalReference
    });
    if (!data.reference) throw new Error('Campay collect returned no reference');
    return { reference: String(data.reference), operator: mapOperator(data.operator), ussdCode: data.ussd_code };
  }

  async withdraw(req: WithdrawRequest): Promise<Transaction> {
    const data = await this.request('/withdraw/', {
      amount: String(req.amount),
      currency: 'XAF',
      to: toGatewayMsisdn(req.phone),
      description: req.description.slice(0, 100),
      external_reference: req.externalReference
    });
    if (!data.reference) throw new Error('Campay withdraw returned no reference');
    // Withdrawals can complete asynchronously; read the final state.
    return this.getTransaction(String(data.reference)).catch(() => ({
      reference: String(data.reference),
      status: 'PENDING' as const,
      amount: req.amount,
      externalReference: req.externalReference
    }));
  }

  async getTransaction(reference: string): Promise<Transaction> {
    const data = await this.request(`/transaction/${encodeURIComponent(reference)}/`);
    return {
      reference: String(data.reference ?? reference),
      status: mapStatus(data.status),
      amount: Number(data.amount),
      externalReference: data.external_reference ?? undefined,
      operator: mapOperator(data.operator)
    };
  }

  parseWebhook(params: Record<string, unknown>): WebhookNotice | null {
    const signature = typeof params.signature === 'string' ? params.signature : '';
    if (!signature || !verifyHs256(signature, this.opts.webhookKey)) return null;
    const reference = typeof params.reference === 'string' ? params.reference : '';
    if (!reference) return null;
    return {
      reference,
      status: mapStatus(params.status),
      externalReference: typeof params.external_reference === 'string' ? params.external_reference : undefined
    };
  }
}
