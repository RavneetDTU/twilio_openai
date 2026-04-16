// src/services/dispatcher.js
import { billyPersona } from './bot_models/billys.js';
import logger from './utils/logger.js';
import { ryanPersona } from './bot_models/ryans.js';
import { bjornPersona } from './bot_models/bjorns.js';
import { wineTastingPersona } from './bot_models/wine_tasting.js';

export function getPersonaByNumber(callerNumber) {
    logger.info(`🧠 Dispatcher analyzing number: ${callerNumber}`);

    // LOGIC: Check number and return model
    // Later we will add: if (callerNumber === '...') return ryanPersona;

    if (callerNumber === '+918930276263' || callerNumber === '+27844500010' || callerNumber === '+918319377879') { 
        return ryanPersona; // female
    }
    else if (callerNumber === '+27765575522') {
        return bjornPersona; // female
    }
    else if (callerNumber === '+27210073477') {
        return wineTastingPersona; // Wine Tasting Terrance
    }

    else {
        logger.warn("⚠️ No specific match found, defaulting to Billy.");
        return billyPersona; //male
    }
}