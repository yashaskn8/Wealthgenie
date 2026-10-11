import { readFile } from 'node:fs/promises';
import { verifyExportedGenieProofPassport } from '../agents/genieProof/genieProofPassportVerifier.js';

const passportPath = process.argv[2];
if (!passportPath || process.argv.length !== 3) {
  process.stderr.write('Usage: node server/scripts/verifyGenieProofPassport.js <passport.json>\n');
  process.exitCode = 64;
} else {
  try {
    const signedPassport = JSON.parse(await readFile(passportPath, 'utf8'));
    const trustedPublicKeys = process.env.GENIEPROOF_VERIFY_PUBLIC_KEYS_JSON
      ? JSON.parse(process.env.GENIEPROOF_VERIFY_PUBLIC_KEYS_JSON)
      : {};
    const result = verifyExportedGenieProofPassport(signedPassport, { trustedPublicKeys });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.status === 'VERIFICATION_FAILED' ? 1
      : result.status === 'VERIFICATION_INCOMPLETE' ? 2 : 0;
  } catch {
    process.stderr.write('Passport JSON or configured public-key trust store could not be read.\n');
    process.exitCode = 64;
  }
}
