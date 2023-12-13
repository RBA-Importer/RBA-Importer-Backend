const pino = require('pino');
const logger = pino({
  transport: {
    target: 'pino-pretty',
  },
});

exports.logger = logger;
