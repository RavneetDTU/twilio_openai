import mongoose from 'mongoose';

const CallLogSchema = new mongoose.Schema({
    callSid: {
        type: String,
        required: true,
        unique: true,
        index: true
    },
    restaurantId: {
        type: String,
        required: true
    },
    customerPhone: {
        type: String,
        required: true
    },
    botPhone: {
        type: String,
        required: true
    },
    startTime: {
        type: Date,
        default: Date.now
    },
    status: {
        type: String,
        enum: ['active', 'completed'],
        default: 'active'
    },
    recordingUrl: {
        type: String,
        default: null
    },
    localFilePath: {
        type: String,
        default: null
    },
    transcription: {
        type: String,
        default: null
    },
    booking: {
        name: { type: String, default: null },
        date: { type: String, default: null },
        time: { type: String, default: null },
        guests: { type: Number, default: null },
        phoneNo: { type: String, default: null },
        allergy: { type: String, default: null },
        notes: { type: String, default: null }
    },
    duration: {
        type: Number,
        default: 0
    }
}, { timestamps: true });

const CallLog = mongoose.model('CallLog', CallLogSchema);

export default CallLog;
