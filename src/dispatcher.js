// src/services/dispatcher.js
import { billyPersona } from './bot_models/billys.js';
import logger from './utils/logger.js';
import { bjornPersona } from './bot_models/bjorns.js';
import { wineTastingPersona } from './bot_models/wine_tasting.js';

export function getPersonaByNumber(callerNumber) {
    logger.info(`🧠 Dispatcher analyzing number: ${callerNumber}`);

    if (callerNumber === '+27765575522') {
        return bjornPersona; // Bjorn's Steakhouse
    }
    else if (callerNumber === '+27210073477') {
        return wineTastingPersona; // Wine Tasting Terrance
    }
    else {
        logger.warn("⚠️ No specific match found, defaulting to Billy.");
        return billyPersona; //male
    }
}