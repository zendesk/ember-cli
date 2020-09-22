'use strict';

/**
@module ember-cli
*/

const path = require('path');
const fs = require('fs');
const DAGMap = require('dag-map').default;
const logger = require('heimdalljs-logger')('ember-cli:addons-factory');
const heimdall = require('heimdalljs');
const SilentError = require('silent-error');

/**
 * Create instances of a set of "child" addons for a parent addon or project.
 *
 * @method instantiateAddons
 * @param {Object} parent an Addon or Project that is the direct containing object of the list
 *   of children defined in addonPackages.
 * @param {Project} project the project that contains the parent (so either the addon's project
 *   if parent is an addon, or the project itself if it is a project). It is possible when
 *   constructing custom addon instances that the project will actually be undefined--various
 *   addon tests do this, for example.
 * @param {Object} a map of addon name (including scope) to an AddonInfo with the name, path and
 *   'pkg' object for that addon's package.json). These are what is turned into addons.
 */
function instantiateAddons(parent, project, addonPackages) {
  // depending on whether this is really a project or an addon, the 'name' property may be a getter.
  let parentName = typeof parent.name === 'function' ? parent.name() : parent.name;

  logger.info('instantiateAddons for: ', parentName);

  let addonNames = Object.keys(addonPackages || {});

  if (addonNames.length === 0) {
    logger.info('    no addons');
    return [];
  } else {
    logger.info('    addon names are:', addonNames);
  }

  let initializeAddonsToken = heimdall.start(`${parentName}: initializeAddons`);
  let graph = new DAGMap();

  addonNames.forEach((name) => {
    let addonInfo = addonPackages[name];
    let emberAddonConfig = addonInfo.pkg['ember-addon'];

    graph.add(name, addonInfo, emberAddonConfig.before, emberAddonConfig.after);
  });

  let addons = [];
  graph.each((key, addonInfo) => {
    if (addonInfo) {
      let initializeAddonToken = heimdall.start({
        name: `initialize ${addonInfo.name}`,
        addonName: addonInfo.name,
        addonInitializationNode: true,
      });

      let start = Date.now();

      // TODO: bring this back
      //if (!pkgInfo || !pkgInfo.valid) {
      //  throw new SilentError(
      //    `The \`${addonInfo.pkg.name}\` addon could not be found at \`${addonInfo.path}\` or was otherwise invalid.`
      //  );
      //}

      // Note: when we have both 'main' and ember-addon:main, the latter takes precedence
      let main = (addonInfo.pkg['ember-addon'] && addonInfo.pkg['ember-addon'].main) || addonInfo.pkg['main'];

      if (!main || main === '.' || main === './') {
        main = 'index.js';
      } else if (!path.extname(main)) {
        main = `${main}.js`;
      }

      logger.info('Addon entry point is %o', main);
      addonInfo.pkg.main = main;

      let mainPath = path.join(addonInfo.path, main);
      let mainRealPath = fs.realpathSync(mainPath);

      if (!mainRealPath) {
        // TODO: bring back an error here
        //pkgInfo.addError(Errors.ERROR_EMBER_ADDON_MAIN_MISSING, mainPath);
      }

      let addonModule = require(mainRealPath);
      let mainDir = path.dirname(mainRealPath);

      let AddonConstructor;
      if (typeof addonModule === 'function') {
        AddonConstructor = addonModule;
        AddonConstructor.prototype.root = AddonConstructor.prototype.root || mainDir;
        AddonConstructor.prototype.pkg = AddonConstructor.prototype.pkg || addonInfo.pkg;
      } else {
        const Addon = require('./addon'); // done here because of circular dependency

        AddonConstructor = Addon.extend(Object.assign({ root: mainDir, pkg: addonInfo.pkg }, addonModule));
      }

      AddonConstructor._meta_ = {
        modulePath: mainRealPath,
        lookupDuration: 0,
        initializeIn: 0,
      };

      let addon;

      try {
        addon = new AddonConstructor(parent, project);
      } catch (e) {
        if (parent && parent.ui) {
          parent.ui.writeError(e);
        }
        throw new SilentError(`An error occurred in the constructor for ${addonInfo.name} at ${addonInfo.path}`);
      }

      if (typeof addon.initializeAddons === 'function') {
        addon.initializeAddons();
      } else {
        addon.addons = [];
      }

      AddonConstructor._meta_.initializeIn = Date.now() - start;
      addon.constructor = AddonConstructor;
      initializeAddonToken.stop();

      addons.push(addon);
    }
  });

  logger.info(
    ' addon info %o',
    addons.map((addon) => ({
      name: addon.name,
      times: {
        initialize: addon.constructor._meta_.initializeIn,
        lookup: addon.constructor._meta_.lookupIn,
      },
    }))
  );

  initializeAddonsToken.stop();

  return addons;
}

module.exports = instantiateAddons;
