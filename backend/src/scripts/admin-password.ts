import { generatePassword, hashPassword } from '../api/admin-auth.js';

/**
 * Creates the admin dashboard password.
 *   npm run admin:password            → generates a strong password
 *   npm run admin:password -- "mine"  → hashes a password you chose (12+ characters)
 * Put the printed hash in ADMIN_PASSWORD_HASH on the server. Keep the password in a password
 * manager; the server never stores it.
 */
const chosen = process.argv[2];
if (chosen !== undefined && chosen.length < 12) {
  console.error('Choose at least 12 characters.');
  process.exit(1);
}
const password = chosen ?? generatePassword();
console.log(`Password:             ${password}`);
console.log(`ADMIN_PASSWORD_HASH:  ${hashPassword(password)}`);
