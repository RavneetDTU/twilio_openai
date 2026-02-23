// src/services/dispatcher.js
import { billyPersona } from './bot_models/billys.js';
import { ryanPersona } from './bot_models/ryans.js';
import { bjornPersona } from './bot_models/bjorns.js';

export function getPersonaByNumber(callerNumber) {
    console.log(`🧠 Dispatcher analyzing number: ${callerNumber}`);

    // LOGIC: Check number and return model
    // Later we will add: if (callerNumber === '...') return ryanPersona;

    if (callerNumber === '+918930276263' || callerNumber === '+27844500010') {
        return ryanPersona; // female
    }
    else if (callerNumber === '+27765575522') {
        return bjornPersona; // female
    }

    else {
        console.log("⚠️ No specific match found, defaulting to Billy.");
        return billyPersona; //male
    }
}