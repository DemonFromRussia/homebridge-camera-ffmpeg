import { argv } from 'node:process';
export class Logger {
    log;
    debugMode;
    constructor(log) {
        this.log = log;
        this.debugMode = argv.includes('-D') || argv.includes('--debug');
    }
    formatMessage(message, device) {
        let formatted = '';
        if (device) {
            formatted += `[${device}] `;
        }
        formatted += message;
        return formatted;
    }
    success(message, device) {
        this.log.success(this.formatMessage(message, device));
    }
    info(message, device) {
        this.log.info(this.formatMessage(message, device));
    }
    warn(message, device) {
        this.log.warn(this.formatMessage(message, device));
    }
    error(message, device) {
        this.log.error(this.formatMessage(message, device));
    }
    debug(message, device, alwaysLog = false) {
        if (this.debugMode) {
            this.log.debug(this.formatMessage(message, device));
        }
        else if (alwaysLog) {
            this.info(message, device);
        }
    }
}
