/*
 * Copyright 2016, Lorenzo Mangani (lorenzo.mangani@gmail.com)
 * Copyright 2015, Rao Chenlin (rao.chenlin@gmail.com)
 *
 * This file is part of Sentinl (http://github.com/sirensolutions/sentinl)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *  http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import _ from 'lodash';
import later from 'later';
import doActions from './actions';
import getConfiguration from './get_configuration';
import Watcher from './classes/watcher';

export default function getScheduler(server) {


  const config = getConfiguration(server);
  let sirenVanguardAvailable = false;
  try {
    const elasticsearchPlugins = server.config().get('elasticsearch.plugins');
    if (elasticsearchPlugins && elasticsearchPlugins.indexOf('siren-vanguard') > -1) {
      sirenVanguardAvailable = true;
    }
  } catch (err) {
    // 'elasticsearch.plugins' not available when running from kibana
  }

  let Schedule = [];


  function getReportActions(actions) {
    const filteredActions = {};
    _.forEach(actions, (settings, name) => {
      if (_.has(settings, 'report')) filteredActions[name] = settings;
    });
    return filteredActions;
  }


  function getNonReportActions(actions) {
    const filteredActions = {};
    _.forEach(actions, (settings, name) => {
      if (!_.has(settings, 'report')) filteredActions[name] = settings;
    });
    return filteredActions;
  }


  function removeOrphans(resp) {
    let orphans = _.difference(_.each(Object.keys(Schedule)), _.map(resp.hits.hits, '_id'));
    _.each(orphans, function (orphan) {
      server.log(['status', 'info', 'Sentinl'], 'Deleting orphan watcher: ' + orphan);
      if (_.isObject(Schedule[orphan].later) && _.has(Schedule[orphan].later, 'clear')) {
        Schedule[orphan].later.clear();
      }
      delete Schedule[orphan];
    });
  }


  function handleReports(task, watcherConfig) {
    server.log(['status', 'info', 'Sentinl'], `Executing report action: ${task._id}`);

    const actions = getReportActions(watcherConfig.actions);
    const payload = { _id: task._id };

    if (_.keys(actions).length) {
      doActions(server, actions, payload, watcherConfig);
    }
  }


  function handleActions(watcher, client, task, watcherConfig) {
    server.log(['status', 'info', 'Sentinl'], `Executing action: ${task._id}`);

    const actions = getNonReportActions(watcherConfig.actions);
    let request = _.has(watcherConfig, 'input.search.request') ? watcherConfig.input.search.request : undefined;
    let condition = _.has(watcherConfig, 'condition.script.script') ? watcherConfig.condition.script.script : undefined;
    let transform = watcherConfig.transform ? watcherConfig.transform : {};

    let method = 'search';
    if (sirenVanguardAvailable) {
      for (let candidate of ['kibi_search', 'vanguard_search', 'search']) {
        if (client[candidate]) {
          method = candidate;
          break;
        }
      }
    }

    if (!request || !condition) {
      server.log(['status', 'debug', 'Sentinl', 'WATCHER TASK'], `Watcher ${watcherConfig.uuid} search request or condition malformed`);
      return;
    }

    watcher.search(method, request).then((payload) => {
      server.log(['status', 'info', 'Sentinl', 'PAYLOAD DEBUG'], payload);

      if (!payload) {
        server.log(['status', 'debug', 'Sentinl', 'WATCHER TASK'], `Watcher ${watcherConfig.uuid}` +
          ' malformed or missing key parameters!');
        return;
      }

      server.log(['status', 'debug', 'Sentinl', 'PAYLOAD DEBUG'], payload);

      /* Validate Condition */
      let ret;
      try {
        ret = eval(condition); // eslint-disable-line no-eval
      } catch (err) {
        server.log(['status', 'info', 'Sentinl'], `Condition Error for ${task._id}: ${err}`);
      }

      if (ret) {
        if (transform.script) {
          try {
            eval(transform.script.script); // eslint-disable-line no-eval
          } catch (err) {
            server.log(['status', 'info', 'Sentinl'], `Transform Script Error for ${task._id}: ${err}`);
          }
          doActions(server, actions, payload, watcherConfig);
        } else if (transform.search) {
          watcher.search(method, transform.search.request).then((payload) => {
            if (!payload) return;
            doActions(server, actions, payload, watcherConfig);
          });
        } else {
          doActions(server, actions, payload, watcherConfig);
        }
      }

    })
    .catch((error) => {
      server.log(['error', 'Sentinl'], `An error occurred while executing the watcherConfig: ${error}`);
    });
  }


  function watching(watcher, client, task, interval) {
    if (!task._source || task._source.disable) {
      server.log(['status', 'debug', 'Sentinl'], `Non-Executing Disabled Watch: ${task._id}`);
      return;
    }

    server.log(['status', 'info', 'Sentinl'], `Executing watcherConfig: ${task._id}`);
    server.log(['status', 'debug', 'Sentinl', 'WATCHER DEBUG'], task);

    let watcherConfig = task._source;
    if (!watcherConfig.actions || _.isEmpty(watcherConfig.actions)) {
      server.log(['status', 'debug', 'Sentinl', 'WATCHER TASK'], `Watcher ${watcherConfig.uuid} has no actions.`);
      return;
    }

    let actions = [];

    if (watcherConfig.report) {
      handleReports(task, watcherConfig);
    }

    if (_.keys(getNonReportActions(watcherConfig.actions)).length) {
      handleActions(watcher, client, task, watcherConfig);
    }
  }


  function doalert(server, client) {
    server.log(['status', 'debug', 'Sentinl'], 'Reloading Watchers...');

    const watcher = new Watcher(client, config);

    watcher.getCount().then(function (resp) {
      watcher.getWatchers(resp.count).then(function (resp) {

        /* Orphanizer */
        try {
          removeOrphans(resp);
        } catch (err) {
          server.log(['status', 'debug', 'Sentinl'], `Failed to remove orphans`);
        }

        /* Scheduler */
        _.each(resp.hits.hits, function (hit) {

          if (Schedule[hit._id]) {
            if (_.isEqual(Schedule[hit._id].hit, hit)) {
              return;
            }
            else {
              server.log(['status', 'info', 'Sentinl'], `Clearing watcher: ${hit._id}`);
              Schedule[hit._id].later.clear();
            }
          }

          Schedule[hit._id] = {};
          Schedule[hit._id].hit = hit;

          let interval;
          if (hit._source.trigger.schedule.later) {
            // https://bunkat.github.io/later/parsers.html#text
            interval = later.parse.text(hit._source.trigger.schedule.later);
            Schedule[hit._id].interval = hit._source.trigger.schedule.later;
          }
          else if (hit._source.trigger.schedule.interval % 1 === 0) {
            // max 60 seconds!
            interval = later.parse.recur().every(hit._source.trigger.schedule.interval).second();
            Schedule[hit._id].interval = hit._source.trigger.schedule.interval;
          }

          /* Run Watcher in interval */
          Schedule[hit._id].later = later.setInterval(function () {
            watching(watcher, client, hit, interval);
          }, interval);
          server.log(['status', 'info', 'Sentinl'], `Scheduled Watch: ${hit._id} every ${Schedule[hit._id].interval}`);

        });

      }).catch((error) => {
        server.log(['status', 'error', 'Sentinl'], 'Failed to get watchers.');
      });
    })
    .catch((error) => {
      if (error.statusCode === 404) {
        server.log(['status', 'info', 'Sentinl'], 'No indices found, initializing.');
      } else {
        server.log(['status', 'error', 'Sentinl'], `An error occurred while looking for indices: ${error}`);
      }
    });
  }


  return {
    doalert
  };

};
