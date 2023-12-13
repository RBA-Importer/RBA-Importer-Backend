const axios = require('axios');
const xlsx = require('xlsx');
const { logger } = require('./logger');

const {
  OS_ALERTS_CONVERSION_URL,
  RBA_RUNBOOK_ENDPOINT,
  RBA_API_AUTH_TYPE,
  RBA_API_KEY,
  RBA_TRIGGER_ENDPOINT,
  OS_ALERTS_CONVERSION_AUTH,
} = process.env;

const folder = '/tmp/';
const severityJSON = require('./config/severities.json');

async function fullImport(filenames) {
  const entries = await parseFilesIntoRunbooks(filenames);
}

async function fetchAlertsConversions() {
  logger.info('Fetching converions from Object Server API ...');
  const { data } = await axios.get(OS_ALERTS_CONVERSION_URL, {
    headers: { Authorization: `Basic ${OS_ALERTS_CONVERSION_AUTH}` },
  });
  logger.info('Successfully fetched  conversions from Object Server API, parsing results ...');

  const { rowset } = data;
  const { rows } = rowset;

  return rows;
}

function parseFilesIntoRunbooks(filenames) {
  logger.info('Parsing excel files into runbooks ...');

  const validEntries = [];
  const invalidEntries = [];

  for (const filename of filenames) {
    const workbook = xlsx.readFile(folder + filename);
    const { SheetNames: sheetnames } = workbook;

    for (const sheetname of sheetnames) {
      const logPrefix = `[file: ${filename},  sheetname: ${sheetname}]`;
      logger.info(`${logPrefix} ${sheetname}`);
      const exceljson = xlsx.utils.sheet_to_json(workbook.Sheets[sheetname]);

      for (const row of exceljson) {
        const runbook = {};
        const {
          BF,
          'Netcool/Summary': netcoolSummary,
          Class,
          Severity,
          Tags,
          Beschreibung,
          Maßnahmen,
          'Multi steps': multisteps,
        } = row;

        if (!BF || !Class || !Severity || !Beschreibung) {
          logger.info(
            `Fields 'BF', 'Class', 'Severity', 'Beschreibung' are missing and required, current row: ${JSON.stringify(
              row,
              null,
              2,
            )}`,
          );
          invalidEntries.push({
            runbook: runbook,
            row: row,
            filename: filename,
            sheetname: sheetname,
            status: `Die Felder 'BF', 'Class', 'Severity' und 'Beschreibung' sind erforderlich`,
          });
          continue;
        }

        const convertedSeverity = getSeverity(Severity);

        if (convertedSeverity === undefined) {
          logger.info(
            `${logPrefix} no severity conversion found for  '${Severity}' hinterlegt, current row: ${JSON.stringify(
              row,
              null,
              2,
            )}`,
          );
          invalidEntries.push({
            runbook: runbook,
            row: row,
            filename: filename,
            sheetname: sheetname,
            status: `Es wurde keine Severity für '${Severity}' hinterlegt`,
          });
          continue;
        }

        const parsedTags = !!Tags ? Tags.split(',').map((tag) => tag.trim()) : [];

        runbook.name = `[${BF}] ${Class} - ${netcoolSummary} (${convertedSeverity})`; // Class und Severity Conversions fehlen noch
        runbook.description = Beschreibung;
        runbook.tags = [BF, netcoolSummary, Class, convertedSeverity, ...parsedTags]; // Class und Severity Conversions fehlen noch
        runbook.steps = [];

        if (multisteps === 'ja') {
          logger.info(`${logPrefix} Multisteps detected`);
          const { 'Multi step count': multiStepCount } = row;
          if (!multiStepCount) {
            invalidEntries.push({
              runbook: runbook,
              row: row,
              filename: filename,
              sheetname: sheetname,
              status: 'Multi step count ist leer',
            });
            continue;
          }

          const stepCount = parseInt(multiStepCount);

          let validSteps = true;

          for (let i = 1; i < stepCount + 1; i++) {
            const descriptionColumn = `Step ${i} - Beschreibung`;
            const titleColumn = `Step ${i} - Titel`;

            const description = row[descriptionColumn];
            const title = row[titleColumn];

            if (!description) {
              invalidEntries.push({
                runbook: runbook,
                row: row,
                filename: filename,
                sheetname: sheetname,
                status: `Beschreibung für Step ${i} fehlt`,
              });
              validSteps = false;
              break;
            }
            if (!title) {
              invalidEntries.push({
                runbook: runbook,
                row: row,
                filename: filename,
                sheetname: sheetname,
                status: `Titel für Step ${i} fehlt`,
              });
              validSteps = false;
              break;
            }

            const step = {
              number: i,
              title,
              type: 'manual',
              description,
            };
            runbook.steps.push(step);
          }

          if (!validSteps) {
            continue;
          }
        } else {
          if (!Maßnahmen) {
            logger.info(`${logPrefix} One of the fields 'Maßnahmen' or 'Multi Steps' is required`);
            invalidEntries.push({
              runbook: runbook,
              row: row,
              filename: filename,
              sheetname: sheetname,
              status: 'Maßnahmen oder Multi Steps müssen gefüllt sein',
            });

            continue;
          }

          if (Maßnahmen.trim().startsWith('1.')) {
            const trimmedMaßnahmen = Maßnahmen.trim().replace(/^1\./, '');

            const splitSteps = trimmedMaßnahmen.split(/\d+\./);

            for (let j = 0; j < splitSteps.length; j++) {
              const description = splitSteps[j].trim();
              const step = {
                number: j + 1,
                type: 'manual',
                description,
              };
              runbook.steps.push(step);
            }
          } else {
            const step = {
              number: 1,
              type: 'manual',
              description: Maßnahmen.trim(),
            };
            runbook.steps.push(step);
          }
        }
        validEntries.push({
          runbook: runbook,
          row: row,
          filename: filename,
          sheetname: sheetname,
        });
        logger.info('Runbook: ' + JSON.stringify(runbook, null, 2));
      }
    }
  }
  return { validEntries, invalidEntries };
}

async function parseTriggers(entries) {
  const validEntries = [];
  const invalidEntries = [];

  const alertsConversions = await fetchAlertsConversions();

  for (let entry of entries) {
    const { runbook, row, filename, sheetname, runbookId } = entry;
    const { name, description } = runbook;
    const { Class, Severity, 'Netcool/Summary': netcoolSummary } = row;

    const convertedClass = await getClass(Class, alertsConversions);
    const logPrefix = `[file: ${filename},  sheetname: ${sheetname}]`;

    if (convertedClass === undefined) {
      logger.info(
        `${logPrefix} No class conversion found for '${Severity}', current row: ${JSON.stringify(
          row,
          null,
          2,
        )}`,
      );
      entry.status = `Keine Class-Konvertierung für '${Class}' gefunden`;
      invalidEntries.push(entry);
      continue;
    }

    const convertedSeverity = getSeverity(Severity);

    const trigger = {
      name,
      description,
      runbookId,
      enabled: true,
      executionType: 'manual',
      filterOperator: 'and',
      filterPriority: 5,
      filters: [
        {
          name: 'Type',
          attribute: 'Type',
          operator: '=',
          value: '1',
        },
        {
          name: 'Class',
          attribute: 'Class',
          operator: '=',
          value: convertedClass.toString(),
        },
        {
          name: 'Severity',
          attribute: 'Severity',
          operator: '=',
          value: convertedSeverity.toString(),
        },
        {
          name: 'Summary',
          attribute: 'Summary',
          operator: '=',
          value: netcoolSummary,
        },
      ],
      parameterMappings: [
        {
          parameterName: 'appName',
          mappingType: 'automatic',
          parameterValue: 'Application',
        },
        {
          parameterName: 'platform',
          mappingType: 'automatic',
          parameterValue: 'Platform',
        },
      ],
      eventSources: [],
    };

    entry.trigger = trigger;
    validEntries.push(entry);
  }
  return entries;
}

function getSeverity(severityString) {
  for (let entry of Object.entries(severityJSON)) {
    if (entry[1].map((sev) => sev.toLowerCase()).includes(severityString.toLowerCase())) {
      return entry[0];
    }
  }
  return undefined;
}

async function getClass(classString, alertsConversions) {
  const matchingRow = alertsConversions.find(({ Conversion }) => Conversion === classString);
  logger.info(matchingRow);
  if (matchingRow != undefined) {
    return matchingRow.Value;
  }
  return { validEntries, invalidEntries };
}

async function createRunbooks(entries) {
  const validEntries = [];
  const invalidEntries = [];

  for (let entry of entries) {
    try {
      const { runbook } = entry;

      const { data } = await axios.post(RBA_RUNBOOK_ENDPOINT, {
        headers: {
          Authorization: `${RBA_API_AUTH_TYPE} ${RBA_API_KEY}`,
        },
        runbook,
      });

      const { readOnly } = data;

      if (!readOnly || !readOnly._runbookId) {
        logger.info(
          'An error occurred while parsing the created runbooks Runbooks, json: ' +
            JSON.stringify(data, null, 2),
        );
        entry.status = 'RunbookId konnte nach dem Erstellen des Runbooks nicht geparst werden';
        invalidEntries.push(entry);
        continue;
      }

      entry.runbookId = readOnly._runbookId;
      validEntries.push(entry);
    } catch (error) {
      logger.error('An error occurred during runbook creation: ' + error);
      entry.status = 'Fehler beim Erstellen des Runbooks, siehe logs';
      invalidEntries.push(entry);
    }
  }

  return { validEntries, invalidEntries };
}

async function createTriggers(entries) {
  const validEntries = [];
  const invalidEntries = [];

  for (let entry of entries) {
    try {
      const { trigger } = entry;

      await axios.post(RBA_TRIGGER_ENDPOINT, {
        headers: {
          Authorization: `${RBA_API_AUTH_TYPE} ${RBA_API_KEY}`,
        },
        trigger,
      });

      entry.status = 'Runbook und Trigger wurden erfolgreich erstellt';
      validEntries.push(entry);
    } catch (error) {
      logger.info('An error occurred during trigger creation: ' + error);
      entry.status = 'Fehler beim Erstellen des Triggers, siehe logs';
      invalidEntries.push(entry);
    }
  }

  return { validEntries, invalidEntries };
}

exports.fullImport = fullImport;
exports.fetchAlertsConversions = fetchAlertsConversions;
exports.parseFilesIntoRunbooks = parseFilesIntoRunbooks;
exports.parseTriggers = parseTriggers;
exports.getClass = getClass;
exports.createTriggers = createTriggers;
exports.getSeverity = getSeverity;
exports.createRunbooks = createRunbooks;
