'use strict';

const request = require('request');
const config = require('./config/config');
const async = require('async');
const fs = require('fs');
const fp = require('lodash/fp');

let Logger;
let requestWithDefaults;

const MAX_PARALLEL_LOOKUPS = 10;

/**
 *
 * @param entities
 * @param options
 * @param cb
 */
function startup(logger) {
  let defaults = {};
  Logger = logger;

  const { cert, key, passphrase, ca, proxy, rejectUnauthorized } = config.request;

  if (typeof cert === 'string' && cert.length > 0) {
    defaults.cert = fs.readFileSync(cert);
  }

  if (typeof key === 'string' && key.length > 0) {
    defaults.key = fs.readFileSync(key);
  }

  if (typeof passphrase === 'string' && passphrase.length > 0) {
    defaults.passphrase = passphrase;
  }

  if (typeof ca === 'string' && ca.length > 0) {
    defaults.ca = fs.readFileSync(ca);
  }

  if (typeof proxy === 'string' && proxy.length > 0) {
    defaults.proxy = proxy;
  }

  if (typeof rejectUnauthorized === 'boolean') {
    defaults.rejectUnauthorized = rejectUnauthorized;
  }

  requestWithDefaults = request.defaults(defaults);
}

function doLookup(entities, options, cb) {
  let lookupResults = [];
  let tasks = [];

  Logger.debug(entities);

  entities.forEach((entity) => {
    let requestOptions = {
      method: 'GET',
      uri: 'https://rest.db.ripe.net/search.json',
      qs: {
        'query-string': entity.value
      },
      json: true
    };

    Logger.trace({ uri: requestOptions }, 'Request URI');

    tasks.push(function (done) {
      requestWithDefaults(requestOptions, function (error, res, body) {
        let processedResult = handleRestError(error, entity, res, body);

        if (processedResult.error) {
          done(processedResult);
          return;
        }

        done(null, processedResult);
      });
    });
  });

  async.parallelLimit(tasks, MAX_PARALLEL_LOOKUPS, (err, results) => {
    if (err) {
      Logger.error({ err: err }, 'Error');
      cb(err);
      return;
    }

    results.forEach((result) => {
      if (result.body === null || result.body.length === 0) {
        lookupResults.push({
          entity: result.entity,
          data: null
        });
      } else {
        lookupResults.push({
          entity: result.entity,
          data: {
            summary: getSummaryTags(result.body),
            details: result.body
          }
        });
      }
    });

    Logger.debug({ lookupResults }, 'Results');
    cb(null, lookupResults);
  });
}

function getSummaryTags(body) {
  const tags = [];
  let nameField, descField, countryField;

  if (body.objects.object.length > 0) {
    const object = body.objects.object[0];

    if (object && object.attributes.attribute.length > 0) {
      const att = object.attributes.attribute;
      nameField = fp.flow(
        fp.find(fp.flow(fp.get('name'), fp.equals('netname'))),
        fp.get('value'),
      )(att);
      descField = fp.flow(
        fp.find(fp.flow(fp.get('name'), fp.equals('descr'))),
        fp.get('value'),
      )(att);
      countryField = fp.flow(
        fp.find(fp.flow(fp.get('name'), fp.equals('country'))),
        fp.get('value'),
      )(att);
      if (nameField) {
        tags.push(nameField);
      }
      if (descField) {
        tags.push(descField);
      }
      if (countryField) {
        tags.push(countryField);
      }
    }
  }

  return tags;
}

function handleRestError(error, entity, res, body) {
  let result;

  if (error) {
    return {
      error: error,
      detail: 'HTTP Request Error'
    };
  }

  if (res.statusCode === 200 && body) {
    // we got data!
    result = {
      entity: entity,
      body: body
    };
  } else if (res.statusCode === 400) {
    result = {
      error: 'Bad Request',
      detail: body.query_status
    };
  } else if (res.statusCode === 403) {
    result = {
      error: 'Forbidden',
      detail: body.query_status
    };
  } else if (res.statusCode === 404) {
    result = {
      error: 'Not Found',
      detail: body.query_status
    };
  } else if (res.statusCode === 405) {
    result = {
      error: 'Method Not Allowed',
      detail: body.query_status
    };
  } else if (res.statusCode === 409) {
    result = {
      error: 'Conflict',
      detail: body.query_status
    };
  } else if (res.statusCode === 415) {
    result = {
      error: 'Unsupported Media Type',
      detail: body.query_status
    };
  } else if (res.statusCode === 500) {
    result = {
      error: 'Internal Server Error',
      detail: body.query_status
    };
  } else {
    result = {
      error: body,
      statusCode: res ? res.statusCode : 'Unknown',
      detail: 'An unexpected error occurred'
    };
  }

  return result;
}

module.exports = {
  doLookup: doLookup,
  startup: startup
};
