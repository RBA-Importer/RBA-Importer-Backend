const { addCorsHeaders } = require('./cors');
const fs = require('fs');
const axios = require('axios');
const xlsx = require('xlsx');
const cors = require('cors');
const express = require('express');
const { logger } = require('./src/logger');
const fileUpload = require('express-fileupload');
const {
  parseFilesIntoRunbooks,
  createRunbooks,
  parseTriggers,
  createTriggers,
} = require('./src/services');

// const { getFlightById } = require('./dao');

// const logger = log4js.getLogger('server');

const PORT = process.env.PORT || 4000;
const { RBA_API_KEY, RBA_API_KEY_PASSWORD, RBA_BASE_URL } = process.env;

const app = express();

// app.use(connectLogger(logger));
app.use(express.json());
app.use(cors());
app.use(fileUpload());
app.use(addCorsHeaders);

app.get('/health', (req, res) => {
  return res.status(200).send({ message: 'Health is good' });
});

app.post('/api/v1/upload', async (req, res) => {
  logger.info('Received upload request.');

  const folder = '/tmp/';

  const temporaryFiles = [];
  try {
    if (!req.files || Object.keys(req.files).length === 0) {
      return res.status(400).send('No files were uploaded.');
    }

    logger.info('Files found: ' + Object.keys(req.files).join(', '));

    for (let file of Object.keys(req.files)) {
      logger.info('Current file: ' + file);
      const currentFile = req.files[file];
      const uploadPath = folder + currentFile.name;
      logger.info('uploadPath', uploadPath);
      await currentFile.mv(uploadPath);
      temporaryFiles.push(currentFile.name);

      logger.info(`File '${currentFile.name}'uploaded.`);
    }

    let validEntries = [];
    let invalidEntries = [];

    logger.info('temporaryFiles', temporaryFiles);

    const { validEntries: validParsedEntries, invalidEntries: invalidParsedEntries } =
      parseFilesIntoRunbooks(temporaryFiles);
    invalidEntries = [...invalidEntries, ...invalidParsedEntries];
    validEntries = [...validEntries, ...validParsedEntries];

    // const { validEntries: validCreatedRunbookEntries, invalidCreatedRunbookEntries } =
    //   await createRunbooks(validParsedEntries);
    // invalidEntries = [...invalidEntries, ...invalidCreatedRunbookEntries];

    // const {
    //   validEntries: validParsedTriggersEntries,
    //   invalidEntries: invalidParsedTriggersEntries,
    // } = await parseTriggers(validCreatedRunbookEntries);

    // invalidEntries = [...invalidEntries, ...invalidParsedTriggersEntries];

    // const {
    //   validEntries: validCreatedTriggersEntries,
    //   invalidEntries: invalidCreatedTriggersEntries,
    // } = await createTriggers(validParsedTriggersEntries);

    return res.status(200).send({ validEntries, invalidEntries });
  } catch (error) {
    logger.info(error);
    return res.status(500).send({ message: 'Internal Server Error' });
  } finally {
    logger.info('Cleaning up files ...');
    for (const file of temporaryFiles) {
      fs.unlinkSync(folder + file);
    }
    logger.info('File cleanup successful.');
  }
});

app.listen(PORT, () => {
  logger.info('App is listening for requests on port ' + PORT);
});
