import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

/**
 * Centralized Logger — writes to daily-rotated log files + console.
 * 
 * Log files:  logs/call-YYYY-MM-DD.log
 * Retention:  7 days (older files auto-deleted)
 * Rotation:   New file created at midnight each day
 */
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        winston.format.printf(({ timestamp, level, message }) => {
            return `${timestamp} [${level.toUpperCase()}]: ${message}`;
        })
    ),
    transports: [
        // 1. Daily rotating file transport — keeps only last 7 days
        new DailyRotateFile({
            dirname: 'logs',
            filename: 'call-%DATE%.log',
            datePattern: 'YYYY-MM-DD',
            maxFiles: '7d',
            zippedArchive: false,
        }),
        // 2. Console transport — keeps existing terminal/PM2 output
        new winston.transports.Console({
            format: winston.format.combine(
                winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
                winston.format.printf(({ timestamp, level, message }) => {
                    return `${timestamp} [${level.toUpperCase()}]: ${message}`;
                })
            )
        })
    ]
});

export default logger;
