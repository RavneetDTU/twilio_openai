// Repeatable Google Sheet → Firestore tenant import.
// Default is dry-run. Pass --apply to write.
// Usage: node scripts/import-sheet-restaurants.js [--apply]

import { importSheetRestaurants } from '../src/services/sheetRestaurantImport.js';

const apply = process.argv.includes('--apply');

const result = await importSheetRestaurants({ apply });
console.log(JSON.stringify(result, null, 2));
if (!apply) {
    console.log('\nDry run only. Re-run with --apply to write tenants.');
}
process.exit(0);
