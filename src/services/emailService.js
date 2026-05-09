import nodemailer from 'nodemailer';
import logger from '../utils/logger.js';

const NOTIFICATION_CC_EMAILS = [
    'ryan.hearingaidlabs@gmail.com',
    'bjornguido@gmail.com',
    'ravneet.dtu@gmail.com'
];

const createSmtpTransporter = () => {
    const host = (process.env.SMTP_HOST || 'smtp.gmail.com').trim();
    const port = Number(process.env.SMTP_PORT || 587);
    const secure = process.env.SMTP_SECURE === 'true' || port === 465;
    const user = (process.env.SMTP_USER || process.env.GMAIL_USER || '').trim();
    const pass = (process.env.SMTP_PASS || process.env.GMAIL_PASS || '').replace(/\s+/g, '');

    if (!user || !pass) {
        throw new Error('Missing SMTP credentials: set SMTP_USER/SMTP_PASS (or GMAIL_USER/GMAIL_PASS)');
    }

    return nodemailer.createTransport({
        host,
        port,
        secure,
        auth: { user, pass }
    });
};

export const sendBookingNotificationEmail = async ({
    toEmail,
    restaurantName,
    customerName,
    customerPhone,
    guests,
    bookingDate,
    bookingTime,
    paymentId,
    bookingAmount
}) => {
    if (!toEmail) {
        return { success: false, error: 'Missing restaurant recipient email' };
    }

    const fromAddress = (process.env.SMTP_FROM || process.env.GMAIL_FROM || process.env.SMTP_USER || process.env.GMAIL_USER || '').trim();
    if (!fromAddress) {
        return { success: false, error: 'Missing SMTP_FROM/GMAIL_FROM sender email' };
    }

    const subject = `New Booking: ${restaurantName || 'Restaurant'} - ${customerName || 'Guest'}`;
    const text = [
        'A new booking has been created. Please find the details below:',
        '',
        `Restaurant: ${restaurantName || 'N/A'}`,
        `Customer Name: ${customerName || 'N/A'}`,
        `Customer Phone: ${customerPhone || 'N/A'}`,
        `Guests: ${guests ?? 'N/A'}`,
        `Date: ${bookingDate || 'N/A'}`,
        `Time: ${bookingTime || 'N/A'}`,
        `Payment ID: ${paymentId || 'N/A'}`,
        `Booking Amount: ${bookingAmount ?? 0}`,
        '',
        'Regards,',
        'Billy Steakhouse'
    ].join('\n');

    try {
        const transporter = createSmtpTransporter();
        const response = await transporter.sendMail({
            from: fromAddress,
            to: toEmail,
            cc: NOTIFICATION_CC_EMAILS,
            subject,
            text
        });

        return {
            success: true,
            messageId: response.messageId,
            accepted: response.accepted || [],
            response: response.response || null,
            sentAt: new Date()
        };
    } catch (error) {
        logger.error(`❌ Restaurant booking email failed: ${error.message}`);
        return {
            success: false,
            error: error.message,
            sentAt: new Date()
        };
    }
};

