/** Copyright (c) 2018 Uber Technologies, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/* eslint-env node */

const fs = require('fs');
const path = require('path');

const webpack = require('webpack');
const chalk = require('chalk');
const webpackHotMiddleware = require('webpack-hot-middleware');
const rimraf = require('rimraf');
const {getEnv} = require('fusion-core');

const webpackDevMiddleware = require('../lib/simple-webpack-dev-middleware');
const getWebpackConfig = require('./get-webpack-config.js');
const {DeferredState} = require('./shared-state-containers.js');
const loadFusionRC = require('./load-fusionrc.js');

const {assetPath} = getEnv();

function getStatsLogger({dir, logger, envs}) {
  return (err, stats) => {
    // syntax errors are logged 4 times (once by webpack, once by babel, once on server and once on client)
    // we only want to log each syntax error once
    function dedupeErrors(items) {
      const re = /BabelLoaderError(.|\n)+( {4}at transpile)/gim;
      return items.map(item => item.replace(re, '$2'));
    }

    const isProd = envs.includes('production');

    if (err) {
      logger.error(err.stack || err);
      if (err.details) {
        logger.error(err.details);
      }
      return;
    }

    const file = path.resolve(dir, '.fusion/stats.json');
    const info = stats.toJson({context: path.resolve(dir)});
    fs.writeFile(file, JSON.stringify(info, null, 2), () => {});

    if (stats.hasErrors()) {
      dedupeErrors(info.errors).forEach(e => logger.error(e));
    }
    // TODO(#13): These logs seem to be kinda noisy for dev.
    if (isProd) {
      info.children.forEach(child => {
        child.assets
          .slice()
          .filter(asset => {
            return !asset.name.endsWith('.map');
          })
          .sort((a, b) => {
            return b.size - a.size;
          })
          .forEach(asset => {
            logger.info(`Entrypoint: ${chalk.bold(child.name)}`);
            logger.info(`Asset: ${chalk.bold(asset.name)}`);
            logger.info(`Size: ${chalk.bold(asset.size)} bytes`);
          });
      });
    }
    if (stats.hasWarnings()) {
      dedupeErrors(info.warnings).forEach(e => logger.warn(e));
    }
  };
}

/*::
type CompilerType = {
  on: (type: any, callback: any) => any,
  start: (callback: any) => any,
  getMiddleware: () => any,
  clean: () => any,
};
*/

function Compiler(
  {dir = '.', envs = [], watch = false, logger = console} /*: any */
) /*: CompilerType */ {
  const state = {
    clientChunkMetadata: new DeferredState(),
    i18nManifest: new DeferredState(),
  };
  const root = path.resolve(dir);
  const fusionConfig = loadFusionRC(root);
  const appPkgJsonPath = path.join(root, 'package.json');
  const legacyPkgConfig = fs.existsSync(appPkgJsonPath)
    ? // $FlowFixMe
      require(appPkgJsonPath)
    : {};

  const sharedOpts = {dir: root, watch, state, fusionConfig, legacyPkgConfig};

  const profiles = envs.map(env => {
    return [
      getWebpackConfig({target: 'web', env, ...sharedOpts}),
      getWebpackConfig({target: 'node', env, ...sharedOpts}),
    ];
  });
  const flattened = [].concat(...profiles);
  const compiler = webpack(flattened);

  const statsLogger = getStatsLogger({dir, logger, envs});

  this.on = (type, callback) => compiler.hooks[type].tap('compiler', callback);
  this.start = cb => {
    cb = cb || function noop() {};
    // Handler may be called multiple times by `watch`
    // But only call `cb` the first tiem
    // subsequent rebuilds are subscribed to with 'compiler.on('done')'
    let hasCalledCb = false;
    const handler = (err, stats) => {
      statsLogger(err, stats);
      if (!hasCalledCb) {
        hasCalledCb = true;
        cb(err, stats);
      }
    };
    if (watch) {
      return compiler.watch({}, handler);
    } else {
      compiler.run(handler);
      // mimic watcher interface for API consistency
      return {
        close() {},
        invalidate() {},
      };
    }
  };

  this.getMiddleware = () => {
    const dev = webpackDevMiddleware(compiler, {
      filter: c => c.name === 'client',
      noInfo: true,
      quiet: true,
      lazy: false,
      stats: {
        colors: true,
      },
      reporter: null,
      serverSideRender: true,
      publicPath: assetPath,
    });
    const hot = webpackHotMiddleware(compiler, {log: false});
    return (req, res, next) => {
      dev(req, res, err => {
        if (err) return next(err);
        return hot(req, res, next);
      });
    };
  };

  this.clean = () => {
    return new Promise((resolve, reject) => {
      rimraf(`${dir}/.fusion`, e => (e ? reject(e) : resolve()));
    });
  };

  return this;
}

module.exports.Compiler = Compiler;
