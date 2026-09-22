import { hashAdminPassword } from "../src/middleware/adminAuth.js";

/**
 * `npm run admin:hash-password -- <password>`
 *
 * Prints a `scrypt:<saltHex>:<hashHex>` string suitable for ADMIN_PASSWORD_HASH — never prints or
 * stores the plaintext password anywhere else. See docs/business-admin.md's "Enabling the
 * dashboard" section.
 */
const password = process.argv[2];
if (!password) {
  process.stderr.write("Usage: npm run admin:hash-password -- <password>\n");
  process.exit(1);
}
if (password.length < 12) {
  process.stderr.write("Refusing to hash a password shorter than 12 characters — this protects a production admin login.\n");
  process.exit(1);
}
process.stdout.write(hashAdminPassword(password) + "\n");
