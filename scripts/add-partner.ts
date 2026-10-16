/** Deprecated alias of `scripts/partner.ts add <pubkey>` (kept for older runbooks). Usage: npx tsx scripts/add-partner.ts <pubkey> */
import { runPartner } from "./partner";

runPartner(["add", process.argv[2] ?? ""]).catch((e) => { console.error(e.message ?? e); process.exit(1); });
