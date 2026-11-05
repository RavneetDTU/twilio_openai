import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    importKeyFor,
    mapSheetRow,
    normalisePhone,
    parseCsv,
    parseOperatingHours,
    parsePhones,
    restaurantIdFor,
    venueTypeFrom,
} from '../../src/services/sheetRestaurantImport.js';

describe('sheet restaurant mapping', () => {
    it('parses quoted CSV addresses', () => {
        const rows = parseCsv('Name,City,Address \nQuay Four,Cape Town,"4 Dock Road, Cape Town"\n');
        assert.equal(rows[1][2], '4 Dock Road, Cape Town');
    });

    it('normalises South African phones and splits multiples', () => {
        assert.equal(normalisePhone('+27 21 020 4864'), '+27210204864');
        assert.equal(normalisePhone('0215319233'), '+27215319233');
        assert.deepEqual(parsePhones('+27 82 644 8889;+27 21 531 9233'), ['+27826448889', '+27215319233']);
    });

    it('parses weekday opening hours without inventing extra days', () => {
        const { hours, raw } = parseOperatingHours('Mo-Th 08:00-21:00; Fr-Sa 08:00-22:00; Su 08:00-20:00');
        assert.equal(raw.includes('Mo-Th'), true);
        assert.equal(hours.Monday.open, '8:00 AM');
        assert.equal(hours.Monday.close, '9:00 PM');
        assert.equal(hours.Friday.close, '10:00 PM');
        assert.equal(hours.Sunday.close, '8:00 PM');
    });

    it('keeps a stable id for the same name, city and phone', () => {
        const key = importKeyFor("Cincinnati Spur", 'Cape Town', '+27210204864');
        assert.equal(restaurantIdFor(key), restaurantIdFor(key));
        assert.match(restaurantIdFor(key), /^s_[a-f0-9]{16}$/);
    });

    it('rejects rows without a usable email or phone', () => {
        const bad = mapSheetRow({ Name: 'No Contact', City: 'Cape Town', Phone: '', Email: '', _row: 9 });
        assert.ok(bad.errors.includes('missing phone'));
        assert.ok(bad.errors.includes('missing email'));
    });

    it('maps steak cuisine to steakhouse without hardcoding a restaurant name', () => {
        assert.equal(venueTypeFrom('restaurant', 'steak_house'), 'steakhouse');
        assert.equal(venueTypeFrom('cafe', 'coffee_shop'), 'cafe');
    });
});
