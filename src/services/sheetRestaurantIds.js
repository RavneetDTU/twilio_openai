// Sheet-imported tenants use stable ids `s_<hex>`. They live in Firestore only
// and are not registered on the Mybooki reservation API.

export function isSheetImportedRestaurantId(restaurantId) {
    return String(restaurantId || '').startsWith('s_');
}
