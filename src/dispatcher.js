// src/services/dispatcher.js
import { billyPersona } from './bot_models/billys.js';
import logger from './utils/logger.js';
import { bjornPersona } from './bot_models/bjorns.js';
import { wineTastingPersona } from './bot_models/wine_tasting.js';
import { laRethaPersona } from './bot_models/la_retha.js';

export function getPersonaByNumber(callerNumber) {
    logger.info(`🧠 Dispatcher analyzing number: ${callerNumber}`);

    if (callerNumber === '+27765575522') {
        return bjornPersona; // Bjorn's Steakhouse
    }
    else if (callerNumber === '+27210073477') {
        return wineTastingPersona; // Wine Tasting Terrance
    }
    else if (callerNumber === '+270647211953' || callerNumber === '+918319377879') {
        return laRethaPersona; // La Retha
    }
    else {
        logger.warn("⚠️ No specific match found, defaulting to Billy.");
        return billyPersona; //male
    }
}