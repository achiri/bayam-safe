import crypto from 'crypto';

export class OtpService {
  private static readonly SALT = 'bayam_sellam_salt_cm_2026';

  /**
   * Generates a secure 4-digit numeric code (e.g. "4921")
   */
  static generate4DigitCode(): string {
    const num = crypto.randomInt(1000, 10000);
    return num.toString();
  }

  /**
   * Hashes the 4-digit release code with a deterministic HMAC
   */
  static hashCode(code: string): string {
    return crypto
      .createHmac('sha256', this.SALT)
      .update(code.trim())
      .digest('hex');
  }

  /**
   * Verifies if the supplied code matches the stored hash
   */
  static verifyCode(suppliedCode: string, storedHash: string): boolean {
    const suppliedHash = this.hashCode(suppliedCode);
    return crypto.timingSafeEqual(
      Buffer.from(suppliedHash, 'utf-8'),
      Buffer.from(storedHash, 'utf-8')
    );
  }
}
