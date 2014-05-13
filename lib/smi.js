
require("require.async")(require);

const ASSERT = require("assert");
const PATH = require("path");
const FS = require("fs-extra");
const URL = require("url");
const WAITFOR = require("waitfor");
const REQUEST = require("request");
const EXEC = require("child_process").exec;
const COLORS = require("colors");
const CRYPTO = require("crypto");
const DEEPCOPY = require("deepcopy");
const DEEPMERGE = require("deepmerge");
const SPAWN = require("child_process").spawn;
const DEEPEQUAL = require("deepequal");
const ASYNC = require("async");
const MOMENT = require("moment");
const GLOB = require("glob");


COLORS.setTheme({
    error: 'red'
});



var throttle_waiting = [];
var throttle_running = 0;
function throttle(callback, runner) {
	throttle_waiting.push([callback, runner]);
	if (throttle_waiting.length === 1) {
		(function iterate() {
			if (throttle_waiting.length === 0) return;
			if (throttle_running > 5) {
				console.log("Waiting before starting additional code path.");
				return;
			}
			throttle_running += 1;
			var task = throttle_waiting.shift();
			return task[1](function() {
				throttle_running -= 1;
				iterate();
				return callback.apply(null, Array.prototype.slice.call(arguments, 0));
			});
		})();
	}
}



function packagesDirectoryForDescriptor(descriptor) {
	var packagesDirectory = "_packages";
	if (
		descriptor &&
		descriptor.config &&
		descriptor.config["smi.cli"] &&
		descriptor.config["smi.cli"].packagesDirectory
	) {
		packagesDirectory = descriptor.config["smi.cli"].packagesDirectory;
	}
	return packagesDirectory;
}


/**
 * Read a package descriptor and overlay descriptors.
 * Looks for `package.json`, then `package.1.json` and so on until not found.
 * Descriptors will get merged on top of each other using rules declared in descriptor.
 * For now, higher layers get merged on top of lower ones.
 * TODO: Replace with with `pinf.descriptor`.
 */
exports.readDescriptor = function(path, options, callback) {
	function loadLayer(layerIndex, callback) {
		var _path = path;
		if (layerIndex > 0) {
			_path = _path.replace(/\.json/, "." + layerIndex + ".json");
		}
		return FS.exists(_path, function(exists) {
			if (!exists) return callback(null, null);
			return FS.readJson(_path, function(err, descriptor) {
				if (err) return callback(err);
				return loadLayer(layerIndex + 1, function(err, _descriptor) {
					if (err) return callback(err);
					if (_descriptor) {
						descriptor = DEEPMERGE(descriptor, _descriptor);
					}
					return callback(null, descriptor);
				});
			});
		});
	}
	return loadLayer(0, function(err, _descriptor) {
		if (err) return callback(err);
		if (!_descriptor) return callback(null, null);
		var descriptor = Object.create({
			_path: path
		});
		for (var name in _descriptor) {
			descriptor[name] = _descriptor[name];
		}
		if (options.resolve) {
			return exports.resolveDescriptor(descriptor, options, callback);
		}
		return callback(null, descriptor);
	});
}
exports.resolveDescriptor = function(descriptor, options, done) {
	if (!descriptor) {
		return done(null, null);
	}
	var basePath = options.basePath;
	var previousSummary = options.previousSummary;
	var descriptorPath = descriptor._path;
	var repeatEnsureAfterInstall = descriptor._repeatEnsureAfterInstall || false;
	var _descriptor = DEEPCOPY(descriptor);
	var descriptor = Object.create({
		_path: descriptorPath,
		_repeatEnsureAfterInstall: repeatEnsureAfterInstall
	});
	for (var name in _descriptor) {
		descriptor[name] = _descriptor[name];
	}
	var callback = function(err, descriptor) {
		if (err) return done(err);
		var _desc = Object.create({
			_path: descriptorPath,
			// NOTE: This is a hack until we have a better resolution + installation flow where we can
			//       resolve and install incrementally.
			_repeatEnsureAfterInstall: repeatEnsureAfterInstall
		});
		for (var name in descriptor) {
			if (descriptor.hasOwnProperty(name)) {
				_desc[name] = descriptor[name];
			}
		}
		return done(null, _desc);
	}
	// TODO: Use `pinf-descriptor` to resolve.
	if (
		descriptor &&
		descriptor.config &&
		descriptor.config["smi.cli"] &&
		descriptor.config["smi.cli"].descriptorPath
	) {
		if (descriptorPath === PATH.join(descriptorPath, "..", descriptor.config["smi.cli"].descriptorPath)) {
			return callback(null, descriptor);
		}
		return exports.readDescriptor(PATH.join(descriptorPath, "..", descriptor.config["smi.cli"].descriptorPath), options, function(err, _descriptor) {
			if (err) return callback(err);
			delete descriptor.config["smi.cli"].descriptorPath;
			for (var name in _descriptor) {
				if (typeof _descriptor[name] === "object") {
					descriptor[name] = DEEPMERGE(descriptor[name] || {}, _descriptor[name]);
				} else {
					descriptor[name] = DEEPCOPY(_descriptor[name]);
				}
			}
			return callback(null, descriptor);
//			_descriptor.config = DEEPMERGE(_descriptor.config, {
//				"smi.cli": descriptor.config["smi.cli"]
//			});
//			return exports.resolveDescriptor(_descriptor, options, callback);
		});
	} else
	if (
		descriptor &&
		descriptor.extends
	) {
		var locators = descriptor.extends;
		delete descriptor.extends;
		var waitfor = WAITFOR.serial(function(err) {
			if (err) return callback(err);
			return exports.resolveDescriptor(descriptor, options, callback);
		});
		function read(path, callback) {
			return FS.readJson(path, function(err, _descriptor) {
				if (err) return callback(err);
				for (var name in _descriptor) {
					descriptor[name] = DEEPMERGE(_descriptor[name], descriptor[name]);
				}
				return callback(null);
			});
		}
		locators.forEach(function(locator, i) {
			return waitfor(function(callback) {
				if (/^\./.test(locator)) {
					var path = PATH.join(descriptorPath, "..", locator);
					return FS.exists(path, function(exists) {
						if (!exists) {
							return callback(new Error("Extends path '" + path + "' does not exist!"));
						}
						return read(path, callback);
					});
				} else {
					var hash = CRYPTO.createHash("sha1");
				    hash.update(locator);
					var extendsPath = descriptorPath + "~extends~" + hash.digest("hex").substring(0, 7);
					// TODO: Issue GET with etag after cache expiry?
					return FS.exists(extendsPath, function(exists) {
						if (exists) {
							return read(extendsPath, callback);
						}
						try {
							// Remove symlink if it points nowhere.
							FS.unlinkSync(extendsPath);
						} catch(err) {}
						function checkIfPackageSymlink(callback) {
							var locatorParts = locator.split("/");
							if (!descriptor.mappings || !descriptor.mappings[locatorParts[0]]) {
								return callback(null, false);
							}
							var packagePath = PATH.join(basePath, packagesDirectoryForDescriptor(descriptor), locatorParts[0]);
							if (previousSummary && previousSummary[locatorParts[0]]) {
								packagePath = PATH.join(basePath, previousSummary[locatorParts[0]].installedPath);
							}
							return FS.exists(packagePath, function(exists) {
								if (!exists) {
									// NOTE: We assume we have a fully resolved locator here.
									// TODO: Layer the resolving and installation steps better so we can run the whole
									//       process repeatedly until everything is resolved and installed. To do this
									//       we need to keep track of which aspects have been resolved.
									repeatEnsureAfterInstall = locatorParts[0];
									return callback(null, null);
								}
								var path = PATH.join(packagePath, locatorParts.slice(1).join("/"));
								return FS.exists(path, function(exists) {
									if (!exists) {
										return callback(new Error("Resolved extends locator '" + locator + "' not found at '" + path + "'!"));
									}
									console.log(("Linking (resolveDescriptor) '" + path + "' to '" + extendsPath + "'.").magenta);
									return FS.symlink(PATH.relative(PATH.dirname(extendsPath), path), extendsPath, function(err) {
										if (err) return callback(err);
										return callback(null, extendsPath);
									});
								});
							});
						}

						return checkIfPackageSymlink(function(err, symlinked) {
							if (err) return callback(err);
							if (symlinked === null) return callback(null);
							if (symlinked) {
								return read(extendsPath, callback);
							}
							console.log(("Downloading '" + locator + "' to '" + extendsPath + "'.").magenta);
			                return REQUEST({
			                    method: "GET",
			                    url: locator
			                }, function(err, response, body) {
			                    if (err) return callback(err);
			                    if (response.statusCode !== 200) {
			                    	return callback(new Error("Did not get statue 200 when downloading '" + locator + "'!"));
			                    }
			                    try {
			                        JSON.parse(body);
			                    } catch(err) {
			                    	console.error("body", body);
			                        console.error("Error parsing JSON!");
			                        return callback(err);
			                    }
			                    return FS.outputFile(extendsPath, body, function(err) {
			                    	if (err) return callback(err);
									return read(extendsPath, callback);
			                    });
			                });
		                });
					});
				}
			});
		});
		return waitfor();
	}
	return callback(null, descriptor);
}

exports.locateUpstreamPackages = function(snapshotDescriptor, options, callback) {
	if (typeof options === "function" && typeof callback === "undefined") {
		callback = options;
		options = null;
	}
	options = options || {};
	var waitfor = WAITFOR[options.debug ? "serial":"parallel"](function(err) {
		if (err) return callback(err);
		return callback(null, packages);
	});
	var packages = {};
	function locatePackage(groupId, locator, callback) {
		var basePath = options.basePath || PATH.dirname(snapshotDescriptor._path);
		function _abspath(_basePath) {
			return PATH.join.apply(null, [basePath].concat(Array.prototype.slice.apply(arguments)));
		}

		// Resolve locator based on path of declaring descriptor.
		// TODO: This should already be resolved before we get here.
		locator = PATH.join(PATH.dirname(snapshotDescriptor._path), locator);
		locator = PATH.relative(basePath, locator);

		return GLOB(locator, {
			cwd: basePath
		}, function (err, paths) {
			if (err) return callback(err);

			var waitfor = WAITFOR[options.debug ? "serial":"parallel"](callback);
			paths.forEach(function(path) {
				var id = groupId + "/" + PATH.basename(path);
				if (!packages[_abspath(path)]) {
					return waitfor(function(callback) {
						return exports.readDescriptor(PATH.join(path, "package.json"), {
								basePath: basePath,
								previousSummary: options.previousSummary,
								resolve: true
							}, function(err, descriptor) {
							if (err) return callback(err);

							// TODO: Control this via pluggable meta data derived from package descriptor.

							var aspects = {};
							if (
								descriptor &&
								descriptor.config &&
								descriptor.config["pio.service"] &&
								descriptor.config["pio.service"].aspects
							) {
								aspects = DEEPCOPY(descriptor.config["pio.service"].aspects);
							}

							var aspectDirectories = {
								scripts: "scripts",
								source: "source"
							};
							if (
								descriptor &&
								descriptor.config &&
								descriptor.config["pio.deploy.converter"]
							) {
								if (descriptor.config["pio.deploy.converter"].name === "nodejs-lib") {
									aspectDirectories.scripts = null;
									aspectDirectories.source = ".";
								} else
								if (descriptor.config["pio.deploy.converter"].name === "nodejs-server") {
									aspectDirectories.scripts = "scripts.pio";
									aspectDirectories.source = ".";
								} else {
									aspectDirectories.scripts = "scripts";
									aspectDirectories.source = "source";
								}
								if (descriptor.config["pio.deploy.converter"].scriptsPath) {
									aspectDirectories.scripts = descriptor.config["pio.deploy.converter"].scriptsPath;
								}
							}
							for (var aspect in aspectDirectories) {
								if (aspectDirectories[aspect]) {	// guard against `null` which should not be recorded.
									if (!aspects[aspect]) {
										aspects[aspect] = {}
									}
									aspects[aspect].basePath = aspects[aspect].basePath || PATH.join(path, aspectDirectories[aspect]);
								}
							}

							var packageInfo = {
								basePath: path,
								aspects: aspects
							};

							if (!packages[_abspath(path)]) {
								packages[_abspath(path)] = packageInfo;
							}
							// TODO: Also record package at realpath of `_abspath(id)`.
							if (!packages[id]) {
								packages[id] = packageInfo;
							}
							var idParts = id.split("/");
							if (!packages[idParts[idParts.length-1]]) {
								packages[idParts[idParts.length-1]] = packageInfo;
							}

							// Match packages we are still extracting.
							// TODO: This should ideally not be needed.
							var m = idParts[idParts.length-1].match(/^([^\/]+?)-[a-zA-Z0-9]{7}(~extracted)?$/);
							if (m) {
								if (!packages[idParts.slice(0, idParts.length-1).concat(m[1]).join("/")]) {
									packages[idParts.slice(0, idParts.length-1).concat(m[1]).join("/")] = packageInfo;
								}
								if (!packages[m[1]]) {
									packages[m[1]] = packageInfo;
								}
							}

							return callback(null);
						});
					});
				}
			});
			return waitfor();
		});
	}
	// TODO: Make these configurable based on schema for `snapshotDescriptor`.
	[
		"upstream"
	].forEach(function(property) {
		if (!snapshotDescriptor[property]) return;
		if (snapshotDescriptor[property].packages) {
			for (var id in snapshotDescriptor[property].packages) {
				if (Array.isArray(snapshotDescriptor[property].packages[id])) {
					snapshotDescriptor[property].packages[id].forEach(function(locator) {
						waitfor(id, locator, locatePackage);
					});
				} else {
					waitfor(id, snapshotDescriptor[property].packages[id], locatePackage);
				}
			}
		}
	});
	return waitfor();
}

exports.install = function (basePath, snapshotDescriptor, installOptions, callback) {

	console.log("[smi] version: " + FS.readJsonSync(PATH.join(__dirname, "../package.json")).version + "; codebase: " + PATH.join(__dirname));

	if (typeof installOptions === "function" && typeof callback === "undefined") {
		callback = installOptions;
		installOptions = null;
	}
	installOptions = installOptions || {};

	ASSERT.equal(typeof basePath, "string");

	var previousSummary = null;

	function ensureDescriptor(callback) {
		if (typeof snapshotDescriptor === "object") {
			return exports.resolveDescriptor(snapshotDescriptor, {
				basePath: basePath,
				previousSummary: previousSummary
			}, callback);
		}
		return exports.readDescriptor(snapshotDescriptor, {
			basePath: basePath,
			previousSummary: previousSummary,
			resolve: true
		}, callback);
	}

	function _abspath() {
		return PATH.join.apply(null, [basePath].concat(Array.prototype.slice.apply(arguments)));
	}

	function prepare(callback) {

		return ensureDescriptor(function(err, snapshotDescriptor) {
			if (err) return callback(err);

			ASSERT.equal(typeof snapshotDescriptor, "object");
			ASSERT.equal(typeof snapshotDescriptor._path, "string");

			var catalogs = {};
			var summary = {};
			var packages = {};

			var packagesDirectory = packagesDirectoryForDescriptor(snapshotDescriptor);

			function ensure(callback) {

				console.log("[smi] ensure".cyan);

				function ensureCatalogs(callback) {
					return exports.locateUpstreamPackages(snapshotDescriptor, {
						basePath: basePath,
						previousSummary: previousSummary
					}, function(err, _packages) {
						if (err) return callback(err);
						packages = _packages;

						var waitfor = WAITFOR[installOptions.debug ? "serial":"parallel"](callback);
						// TODO: Make these configurable based on schema for `snapshotDescriptor`.
						[
							"upstream"
						].forEach(function(property) {
							if (!snapshotDescriptor[property]) return;
							if (snapshotDescriptor[property].catalogs) {
								for (var id in snapshotDescriptor[property].catalogs) {
									waitfor(id, snapshotDescriptor[property].catalogs[id], ensureUpstreamCatalog);
								}
							}
						});
						return waitfor();
					});
				}

				function ensurePackages(callback) {
					var packages = [];
					// TODO: Make these configurable based on schema for `snapshotDescriptor`.
					[
						"mappings"
					].forEach(function(property) {
						if (!snapshotDescriptor[property]) return;						
						for (var id in snapshotDescriptor[property]) {
							var locator = snapshotDescriptor[property][id];
							if (typeof locator === "string") {
								locator = {
									"location": locator
								};
							}
							packages.push({
								provides: [ id ],
								consumes: locator.depends || [],
								id: id,
								locator: locator,
							});
						}
					});
// TODO: Run these in parallel once we have higher resolution into the depends hierarchy.
//       Once all dependent packages are ensured we can proceed ensuring packages in parallel.
//					var waitfor = WAITFOR[installOptions.debug ? "serial":"parallel"](callback);
					var waitfor = WAITFOR.serial(callback);
					orderPackages(packages).forEach(function(_package, i) {
						waitfor(_package.id, _package.locator, ensurePackage);
					});
					return waitfor();
				}

				return ASYNC.series([
					ensureCatalogs,
					ensurePackages
				], callback);
			}

			function ensureUpstreamCatalog(id, locator, callback) {

				return throttle(callback, function(callback) {

					var targetPath = null;
					// `./dependencies/smi`
					if (/^\./.test(id)) {
						targetPath = id;
					} else {
						// TODO: Make default directory configurable.
						targetPath = "./" + packagesDirectory + "/" + id + ".catalog.json";
					}

					if (typeof locator === "string") {
						locator = {
							uri: locator
						};
					}

					console.log(("Ensure upstream catalog: " + id).cyan);

					function ensure(callback, verify) {

						function download(meta, callback) {
			                if (/^\./.test(locator.uri)) {
			                	function etagForPath(path, callback) {
				                	return FS.readFile(path, function(err, data) {
				                		if (err) return callback(err);
										var etag = CRYPTO.createHash("md5");
									    etag.update(data);
									    return callback(null, etag.digest("hex"));
					                });
			                	}
			                	var fromPath = PATH.join(snapshotDescriptor._path, "..", locator.uri);
			                	return etagForPath(fromPath, function(err, etag) {
			                		if (err) return callback(err);
				                	if (meta && meta.etag && meta.etag === etag) {
				                		console.log(("Catalog '" + id + "' not changed based on etag!").yellow);
				                		return FS.readJson(targetPath, callback);
				                	}
					                if (verify) {
					                    return callback(new Error("No catalog descriptor found at '" + targetPath + "' after download!"));
					                }
					                console.log(("Copy catalog for upstream alias '" + id + "' from '" + locator.uri + "'").magenta);
					                return FS.copy(fromPath, targetPath, function(err) {
					                	if (err) return callback(err);
					                	return etagForPath(targetPath, function(err, etag) {
					                		if (err) return callback(err);
						                	return FS.outputFile(targetPath + "~meta", JSON.stringify({
						                		etag: etag
						                	}, null, 4), function(err) {
						                		if (err) return catalog(err);
							                	return ensure(callback, true);
						                	});
					                	});
					                });
			                	});
			                } else
			                if (/^https?:\/\//.test(locator.uri)) {

			                	// TODO: Check if expired and only then send request with etag unless force is set to true.
			                	var force = false;

			                	if (!force && meta && meta.mtime && meta.mtime >= (Date.now()-5*1000)) {
			                		if (!verify) {
				                		console.log(("Catalog '" + id + "' not changed based on mtime!").yellow);
				                	}
			                		return FS.readJson(targetPath, callback);
			                	}
				                console.log(("Download catalog for upstream alias '" + id + "' from '" + locator.uri + "'").magenta);
								var headers = locator.headers || {};
								headers["etag"] = headers["etag"] || (meta && meta.etag) || "";
								headers["User-Agent"] = headers["User-Agent"] || "smi";
				                return REQUEST({
				                    method: "GET",
				                    url: locator.uri,
				                    headers: headers
				                }, function(err, response, body) {
				                    if (err) return callback(err);
				                    if (response.statusCode === 304) {
				                		console.log(("Catalog '" + id + "' not changed based on etag!").yellow);
				                		return FS.readJson(targetPath, callback);
				                    }
				                    try {
				                        JSON.parse(body);
				                    } catch(err) {
				                    	console.error("body", body);
				                        console.error("Error parsing catalog JSON!");
				                        return callback(err);
				                    }
					                if (verify) {
					                    return callback(new Error("No catalog descriptor found at '" + targetPath + "' after download!"));
					                }
				                    return FS.outputFile(targetPath, body, function(err) {
				                        if (err) return callback(err);
					                	return FS.outputFile(targetPath + "~meta", JSON.stringify({
					                		etag: response.headers.etag || null,
					                		expires: (response.headers.expires && MOMENT(response.headers.expires).unix()) || null,
					                	}, null, 4), function(err) {
					                		if (err) return catalog(err);
						                	return ensure(callback, true);
					                	});
				                    });
				                });
				            }
				            return callback(new Error("Cannot determine how to download '" + locator.uri + "'!"));
						}

						return FS.exists(targetPath, function(exists) {
							if (exists) {
								return FS.stat(targetPath, function(err, stat) {
									if (err) return callback(err);
									return FS.readJson(targetPath + "~meta", function(err, meta) {
										if (err) return callback(err);
										meta.mtime = stat.mtime.getTime()
						                return download(meta, callback);
									});
								});
							}
			                return download(null, callback);
			            });
					}

					return ensure(function(err, catalog) {
						if (err) return callback(err);
						return exports.resolveDescriptor(catalog, {
							basePath: basePath,
							previousSummary: previousSummary
						}, function(err, catalog) {
							if (err) return callback(err);
							catalogs[id] = catalog;
							return callback(null);
						});
					});
				});
			}

			var downloads = {};
			var extracts = {};

			function ensurePackage(id, locator, callback) {

				if (snapshotDescriptor._repeatEnsureAfterInstall && id !== snapshotDescriptor._repeatEnsureAfterInstall) {
					return callback(null);
				}

				return throttle(callback, function(callback) {

					try {

						var targetPath = null;
						// `./dependencies/smi`
						if (/^\./.test(id)) {
							targetPath = id;
						} else {
							// TODO: Make default directory configurable.
							targetPath = "./" + packagesDirectory + "/" + id;
						}

						var locatorFilename = ".smi.json";

						// TODO: Use pinf locator resolution logic.
						function resolveLocator(locator) {
							if (typeof locator === "string") {
								locator = {
									location: locator
								};
							}
							if (locator.location) {
								var locatorIdParts = locator.location.split("/");
								if (
									catalogs[locatorIdParts[0]] &&
									catalogs[locatorIdParts[0]].packages &&
									catalogs[locatorIdParts[0]].packages[locatorIdParts[1]]
								) {
									console.log(("Found package '" + locatorIdParts[1] + "' in catalog '" + locatorIdParts[0] + "'!").cyan);
									locator = resolveLocator(catalogs[locatorIdParts[0]].packages[locatorIdParts[1]]);
								} else
								if (packages[locator.location]) {
									console.log(("Found package '" + locator.location + "' in upstream packages!").cyan);
									locator = resolveLocator(packages[locator.location].basePath);
								} else
								if (locatorIdParts.length === 2 && !/^\./.test(locator.location)) {
									// We seem to want to map a package in a catalog but the catalog is not declared.
									console.log("packages", packages);
									throw new Error("Catalog '" + locatorIdParts[0] + "' not declared. Used by locator '" + JSON.stringify(locator) + "' for id '" + id + "'!");
								}
							}
							return locator;
						}
						locator = resolveLocator(locator);

						var packageDescriptor = locator.descriptor || null;

						console.log(("Ensure package '" + id + "' using locator '" + JSON.stringify(locator, null, 4) + "'.").cyan);

						function ensureAspect(targetPath, aspect, locator, options, callback) {

							locator = resolveLocator(locator);

							function _aspectifyPath(path) {
								if (aspect) {
									return path + "/" + aspect;
								}
								return path;
							}

							var desiredLocator = {
								location: locator.location,
								subpath: locator.subpath || null,
								install: (typeof locator.install !== "undefined") ? locator.install : ((aspect === "source") || null),
								descriptor: packageDescriptor,
								smi: {
									revision: options.revision,
									basePath: options.basePath,
									downloadedPath: _aspectifyPath(options.basePath) + ".tgz",
									extractedPath: _aspectifyPath(options.basePath) + "~extracted",
									installedPath: _aspectifyPath(options.basePath),
									livePath: _aspectifyPath(targetPath)
								}
							};
							var actualLocator = null;

							if (!packages[_abspath(packagesDirectory, id)]) {
								packages[_abspath(packagesDirectory, id)] = {
									basePath: options.basePath,
									aspects: options.aspects || []
								};
								desiredLocator.dependsIndex = (Object.keys(packages).length - 1);
							}

							function canSymlink(callback) {

								function symlink(fromPath, callback) {

									function resolveFromPath(fromPath, callback) {
										return FS.exists(PATH.join(fromPath, "package.json"), function(exists) {
											if (!exists) return callback(null, fromPath);
											return exports.readDescriptor(PATH.join(fromPath, "package.json"), {}, function(err, descriptor) {
												if (err) return callback(err);
												if (
													descriptor &&
													descriptor.config &&
													descriptor.config["smi.cli"] &&
													descriptor.config["smi.cli"].aspects &&
													descriptor.config["smi.cli"].aspects.install &&
													descriptor.config["smi.cli"].aspects.install.basePath
												) {
													if (/\//.test(descriptor.config["smi.cli"].aspects.install.basePath)) {
														return callback(null, descriptor.config["smi.cli"].aspects.install.basePath);
													} else {
														return callback(null, PATH.join(fromPath, descriptor.config["smi.cli"].aspects.install.basePath));
													}
												}
												return callback(null, fromPath);
											});
										});
									}

									return resolveFromPath(fromPath, function(err, fromPath) {
										if (err) return callback(err);
										return FS.exists(fromPath, function(exists) {
											if (!exists) {
												return callback(null, "SKIP_SILENT");
											}
											var linkPath = _abspath(desiredLocator.smi.installedPath);
											if (!FS.existsSync(PATH.dirname(linkPath))) {
												FS.mkdirsSync(PATH.dirname(linkPath))
											}
											return FS.exists(linkPath, function(exists) {
												if (exists) {
													return callback(null, linkPath);
												}
							                    console.log(("Linking (canSymlink) '" + fromPath + "' to '" + linkPath + "'").magenta);
												return FS.symlink(PATH.relative(PATH.dirname(linkPath), fromPath), linkPath, function(err) {
													if (err) return callback(err);

													if (!summary[id]) {
														summary[id] = {
															installedPath: options.basePath,
															livePath: options.livePath,
															aspects: {}
														};
													}
													desiredLocator.symlinked = true;
													if (fromPath.substring(0, basePath.length) === basePath) {
														function loadPackageDescriptor(callback) {
															return FS.exists(PATH.join(fromPath, "package.json"), function(exists) {
																if (!exists) return callback(null);
																return exports.readDescriptor(PATH.join(fromPath, "package.json"), {}, callback);
															});
														}
														return loadPackageDescriptor(function(err, descriptor) {
															if (err) return callback(err);
															if (descriptor) {
																desiredLocator.descriptor = descriptor;
															}
															if (desiredLocator.install !== false) {
																desiredLocator.install = true;
															}
															if (!options.aspects) {
																summary[id].aspects["source"] = desiredLocator;
															} else {
																summary[id].aspects[aspect || ""] = desiredLocator;
															}
															return callback(null, linkPath);													
														});
													} else {
														desiredLocator.install = false;
														summary[id].aspects[aspect || ""] = desiredLocator;
													}
													return callback(null, linkPath);
												});
											});
										});
									});
								}

								if (id === "smi.cli" && installOptions.linkSmi === true) {
				                    console.log(("Linking in our smi codebase at '" + PATH.dirname(__dirname) + "'!").cyan);
			                		return symlink(PATH.dirname(__dirname), callback);
								} else
				                if (desiredLocator.location && /^\./.test(desiredLocator.location)) {
				                	return FS.exists(PATH.join(basePath, desiredLocator.location), function(exists) {
				                		if (!exists) {
				                			return callback(new Error("Cannot map package '" + id + "' to '" + PATH.join(basePath, desiredLocator.location) + "' as path does not exist!"));
				                		}
				                		return symlink(PATH.join(basePath, desiredLocator.location), callback);
				                	});
				                } else
				                if (desiredLocator.location && /^\//.test(desiredLocator.location)) {
				                	return FS.exists(desiredLocator.location, function(exists) {
				                		if (!exists) {
				                			return callback(new Error("Cannot map package '" + id + "' to '" + desiredLocator.location + "' as path does not exist!"));
				                		}
				                		return symlink(desiredLocator.location, callback);
				                	});
				                } else
								if (packages[id]) {
									var fromPath = null;
									if (typeof packages[id].aspects === "object") {
										if (
											typeof packages[id].aspects[aspect] === "undefined" ||
											packages[id].aspects[aspect] === null
										) {
											return callback(null, "SKIP_SILENT");
										}
										fromPath = _abspath(packages[id].aspects[aspect].basePath);
									} else {
										fromPath = PATH.join(snapshotDescriptor._path, "..", packages[id].basePath);
									}
									return symlink(fromPath, callback);
								}
								return callback(null, false);
							}

							function getExistingLocator(callback) {
								return FS.exists(_abspath(desiredLocator.smi.livePath), function(exists) {
									if (!exists) {
										// No existing package. We must install it.
										return callback(null, null);
									}
									// If package is symlinked we don't need an smi descriptor.
									return FS.lstat(_abspath(desiredLocator.smi.livePath), function(err, stats) {
										if (err) return callback(err);
										if (stats.isSymbolicLink()) {
											// We have an existing package that is symlinked.
											return callback(null, {});
										}
										return FS.exists(_abspath(desiredLocator.smi.livePath, locatorFilename), function(exists) {
											if (exists) {
												// We have an existing smi descriptor. Read it and compare.
												return FS.readJson(_abspath(desiredLocator.smi.livePath, locatorFilename), callback);
											}
											return callback(new Error("Package found at '" + _abspath(desiredLocator.smi.livePath) + "' but no smi descriptor found at '" + _abspath(desiredLocator.smi.livePath, locatorFilename) + "'. Do not declare package or let smi handle it."));
										});
									});
								});
							}

					        function ensureDownloaded(archivePath, url, callback) {
					            return FS.exists(archivePath, function(exists) {
					                if (exists) return callback(null);
					                if (typeof downloads[url] === "string") {
					                	if (downloads[url] === archivePath) {
					                		return callback(null);
					                	}
					                    console.log(("Linking '" + downloads[url] + "' to '" + archivePath + "'").magenta);
					                    if (!FS.existsSync(PATH.dirname(archivePath))) {
					                    	FS.mkdirs(PATH.dirname(archivePath));
					                    }
					                	return FS.symlink(PATH.relative(PATH.dirname(archivePath), downloads[url]), archivePath, callback);
					                } else
					                if (downloads[url]) {
					                	downloads[url].push([archivePath, callback]);
					                	return;
					                }
					                downloads[url] = [ [ archivePath, callback ] ];
									var tmpPath = archivePath + "~" + Date.now();
					                if (!FS.existsSync(PATH.dirname(tmpPath))) {
					                    FS.mkdirsSync(PATH.dirname(tmpPath));
					                }
					                callback = function(err) {
					                	if (err) {
						                	if (FS.existsSync(tmpPath)) {
						                		FS.removeSync(tmpPath);
						                	}
					                	}
					                	var callbacks = downloads[url];
					                	downloads[url] = archivePath;
					                	callbacks.forEach(function(callback) {
					                		if (err) return callback[1](err);
					                		return ensureDownloaded(callback[0], url, callback[1]);
					                	});
					                }
					                try {
					                    console.log(("Downloading package archive from '" + url + "' to '" + archivePath + "'").magenta);
					                    REQUEST(url, function(err, response) {
					                        if (err) return callback(err);

					                        function success(callback) {
						                        return FS.rename(tmpPath, archivePath, function(err) {
						                        	if (err) {
						                        		if (err.code === "ENOTEMPTY") {
						                        			// Someone beat us to it!
									                        console.log(("Downloaded package archive from '" + url + "' (was already there)").green);
									                        return callback(null);
						                        		}
						                        		return callback(err);
						                        	}
							                        console.log(("Downloaded package archive from '" + url + "'").green);
							                        return callback(null);
						                        });
					                        }

					                        if (response.statusCode === 404) {
					                        	return FS.unlink(tmpPath, function(err) {
					                        		if (err) return callback(err);
						                        	// We assume URL exists but we cannot access it because we are not logged in.
						                        	// So we upgrade our login if we are accessing a known service.
						                        	var urlParts = URL.parse(url);
													// TODO: Use `it.pinf.package` to detect pm.
													if (urlParts.hostname === "github.com") {
														return require.async("./adapters/github", function(api) {
															return api.download(url, tmpPath, function(err) {
																if (err) return callback(err);
										                        return success(callback);
															});
														}, callback);
													}
					                        	});
					                        }

					                        if (response.statusCode !== 200) {
					                        	return callback(new Error("Url '" + url + "' did not return status 200!"));
					                        }
					                        return success(callback);
					                    }).pipe(FS.createWriteStream(tmpPath))
					                } catch(err) {
					                    return callback(err);
					                }
					            });
					        }

					        function ensureExtracted(extractedPath, archivePath, callback) {        	
					            return FS.exists(extractedPath, function(exists) {
					                if (exists) return callback(null);
					                if (typeof extracts[extractedPath] === "string") {
					                	if (extracts[extractedPath] === archivePath) {
					                		return callback(null);
					                	}
					                	return FS.symlink(PATH.relative(PATH.dirname(archivePath), extracts[extractedPath]), archivePath, callback);
					                } else
					                if (extracts[extractedPath]) {
					                	extracts[extractedPath].push([archivePath, callback]);
					                	return;
					                }
					                extracts[extractedPath] = [ [ archivePath, callback ] ];
					                callback = function(err) {
					                	if (err) {
					                		console.error("Error extracting", err.stack, extractedPath, archivePath);
					                	}
					                	var callbacks = extracts[extractedPath];
					                	extracts[extractedPath] = archivePath;
					                	callbacks.forEach(function(callback) {
					                		if (err) return callback[1](err);
					                		return ensureDownloaded(extractedPath, callback[0], callback[1]);
					                	});
					                }
					                return FS.stat(archivePath, function(err, stat) {
					                	if (err) return callback(err);
					                	if (stat.isDirectory()) {
							                console.log(("Store link '" + PATH.relative(PATH.dirname(extractedPath), archivePath) + "' at '" + extractedPath + "'").magenta);
							                return FS.symlink(PATH.relative(PATH.dirname(extractedPath), archivePath), extractedPath, callback);
					                	}
						                console.log(("Extract '" + archivePath + "' to '" + extractedPath + "'").magenta);
										var tmpPath = extractedPath + "~" + Date.now();
						                if (!FS.existsSync(tmpPath)) {
						                    FS.mkdirsSync(tmpPath);
						                }
						                var command = 'tar -xzf "' + PATH.basename(archivePath) + '" --strip 1 -C "' + tmpPath + '/"';
						                if (locator.subpath) {
						                	command += ' "*/' + locator.subpath + '"';
						                }
						                console.log(("Running command: " + command + " (cwd: " + PATH.dirname(archivePath) + ")").magenta);
						                return EXEC(command, {
						                    cwd: PATH.dirname(archivePath)
						                }, function(err, stdout, stderr) {
						                    if (err) {
								                console.error("Error extracting: " + archivePath);
							                	if (FS.existsSync(tmpPath)) {
							                		FS.removeSync(tmpPath);
							                	}
						                    	return callback(err);
						                    }
							                console.log(("Rename '" + tmpPath + "' to '" + extractedPath + "'"));
						                    return FS.rename(tmpPath, extractedPath, function(err) {
						                    	if (err) return callback(err);
							                    console.log(("Archive '" + archivePath + "' extracted to '" + extractedPath + "'").green);
							                    return callback(null);
							                });
						                });
					                });
					            });
					        }

					        function readDescriptor(descriptorPath, callback) {
								return exports.readDescriptor(descriptorPath, {}, callback);
					        }

							function writeLocator(targetPath, callback) {
								return readDescriptor(_abspath(desiredLocator.smi.extractedPath, desiredLocator.subpath || "", "package.json"), function(err, descriptor) {
									if (err) return callback(err);

									actualLocator = DEEPCOPY(desiredLocator);
									actualLocator.descriptor = DEEPMERGE(descriptor || {}, actualLocator.descriptor || {});

									return FS.outputFile(PATH.join(targetPath, locatorFilename), JSON.stringify(actualLocator, null, 4), callback);
								});
							}

							return canSymlink(function(err, symlinkPath) {
								if (err) return callback(err);

								if (symlinkPath) {
									if (symlinkPath !== "SKIP_SILENT") {
										console.log(("Skip provision package '" + id + "'. Symlinked to '" + symlinkPath + "'.").yellow);
									}
									if (desiredLocator.install) {
										return writeLocator(_abspath(desiredLocator.smi.extractedPath), callback);
									}
									return callback(null);
								}

								return getExistingLocator(function(err, existingLocator) {
									if (err) return callback(err);
									if (existingLocator) {
										if (!existingLocator.smi || DEEPEQUAL(existingLocator.smi, desiredLocator.smi)) {
											console.log(("Skip provision package '" + id + "'. Already provision!").yellow);
											return callback(null);
										}
									}

									function finalize(callback) {
										return writeLocator(_abspath(desiredLocator.smi.extractedPath), function(err) {
											if (err) return callback(err);

											if (!summary[id]) {
												summary[id] = {
													installedPath: options.basePath,
													livePath: options.livePath,
													aspects: {}
												};
											}
											summary[id].aspects[aspect || ""] = actualLocator;
											return callback(null);
										});										
									}

									if (!desiredLocator.location) {
										if (err) return callback(err);

										return finalize(callback);
									}

									return ensureDownloaded(_abspath(desiredLocator.smi.downloadedPath), desiredLocator.location, function(err) {
										if (err) return callback(err);

										return ensureExtracted(_abspath(desiredLocator.smi.extractedPath), _abspath(desiredLocator.smi.downloadedPath), function(err) {
											if (err) return callback(err);

											return finalize(callback);
						                });
						            });
								});
							});
						}

						function generateRevision(locator) {

							function deepsort(o) {
								if (typeof o !== "object") {
									return o;
								}
							    var sorted = {},
							    key, a = [];
							    for (key in o) {
							    	if (o.hasOwnProperty(key)) {
							    		a.push(key);
							    	}
							    }
							    a.sort();
							    for (key = 0; key < a.length; key++) {
							    	if (typeof o[a[key]] === "object") {
								    	sorted[a[key]] = deepsort(o[a[key]]);
							    	} else {
								    	sorted[a[key]] = o[a[key]];
							    	}
							    }
							    return sorted;
							}

							// TODO: Take compile flags into account.
							var revision = CRYPTO.createHash("sha1");
						    revision.update(JSON.stringify(deepsort(locator), null, 4));
							return revision.digest("hex");
						}

						function writePackageDescriptor(callback) {
							if (!packageDescriptor) {
								return callback(null);
							}
							var packageDescriptorPath = _abspath(targetPath + "-" + revision.substring(0, 7), "package.json");
							return FS.exists(packageDescriptorPath, function(exists) {
								if (exists) {
									packageDescriptorPath = packageDescriptorPath.replace(/\.json$/, ".1.json");
								}
								// TODO: Indicate source of descriptor. i.e. uri to catalog with pointer within catalog.
								console.log(("Writing package descriptor from catalog to: " + packageDescriptorPath).magenta);
								return FS.outputFile(packageDescriptorPath, JSON.stringify(packageDescriptor, null, 4), callback);
							});
						}

						if (locator.aspects) {
							var waitfor = WAITFOR[installOptions.debug ? "serial":"parallel"](function(err) {
								if (err) return callback(err);
								return writePackageDescriptor(callback);
							});
							var revision = generateRevision(locator.aspects);
							var aspects = {};
							Object.keys(locator.aspects).forEach(function(aspect) {
								aspects[aspect] = {
									basePath: PATH.join(targetPath + "-" + revision.substring(0, 7), aspect)
								};
							});
							for (var aspect in locator.aspects) {
								waitfor(targetPath, aspect, locator.aspects[aspect], {
									basePath: targetPath + "-" + revision.substring(0, 7),
									livePath: targetPath,
									revision: revision,
									aspects: aspects
								}, ensureAspect);
							}
							return waitfor();
						} else
						if (locator.location) {
							var revision = generateRevision(locator);
							return ensureAspect(targetPath, null, locator, {
								basePath: targetPath + "-" + revision.substring(0, 7),
								livePath: targetPath,
								revision: revision
							}, function(err) {
								if (err) return callback(err);
								return writePackageDescriptor(callback);
							});
						} else {
							return callback(new Error("Cannot determine what to do with locator: " + JSON.stringify(locator, null, 4)));
						}
					} catch(err) {
						return callback(err);
					}
				});
			}

			function link(callback) {

				console.log("[smi] link".cyan);

				function doit(id, aspect, locator, callback) {

					if (snapshotDescriptor._repeatEnsureAfterInstall && id !== snapshotDescriptor._repeatEnsureAfterInstall) {
						console.log("Return due to repeat.");
						return callback(null);
					}
/*
// NOTE: `install === false` means we should not call "install" on the package, but we still link it live within smi.
					if (aspect === "source" && locator.install !== true) {
						// TODO: Record reason.
						console.log("Return due to no install for package '" + id + "'.");
						return callback(null);
					}
*/
					function _aspectifyPath(path) {
						return path;
					}

					var installedPath = _abspath(_aspectifyPath(locator.smi.installedPath));

					function linkUsingAdapter(callback) {
						// TODO: Use `it.pinf.package` to detect pm.
						var type = "npm";

						return require.async("./adapters/" + type, function(api) {
							return api.link(_aspectifyPath(basePath), locator, packages, installOptions, callback);
						}, callback);
					}

					return FS.exists(installedPath, function(exists) {
						if (exists && !locator.symlinked) {
							console.log("Return due to exists and not symlinked.");
							return callback(null);
						}

						var extractedPath = _abspath(_aspectifyPath(locator.smi.extractedPath));
						if (locator.subpath) {
							extractedPath = PATH.join(extractedPath, locator.subpath);
						}				

						function copy(callback) {
							console.log(("Copying '" + extractedPath + "' to '" + installedPath + "'.").magenta);
							return FS.copy(extractedPath, installedPath, function(err) {
								if (err) return callback(err);
								if (!locator.subpath) {
									return callback(null);
								}
								return FS.copy(
									PATH.join(_abspath(_aspectifyPath(locator.smi.extractedPath)), ".smi.json"),
									PATH.join(installedPath, ".smi.json"),
									callback
								);
							});
						}

						function error(err) {
			            	if (FS.existsSync(installedPath)) {
			            		FS.removeSync(installedPath);
			            	}
							return callback(err);
						}

						if (locator.symlinked) {
							return linkUsingAdapter(callback);
						} else {
							return copy(function(err) {
								if (err) return error(err);	

								return linkUsingAdapter(function(err) {
									if (err) return error(err);
									return callback(null);
								});
							});
						}
					});
				}

				var waitfor = WAITFOR[installOptions.debug ? "serial":"parallel"](function(err) {
					if (err) return callback(err);
					return callback(null, summary);
				});
				// TODO: Allow for declaring one mapping to be dependent on another
				//       and use `async` NPM module to install?
				for (var id in summary) {
					for (var aspect in summary[id].aspects) {
						waitfor(id, aspect, summary[id].aspects[aspect], doit);
					}
				}
				return waitfor();
			}

			function install(callback) {

				console.log("[smi] install".cyan);

				function doit(id, aspect, locator, callback) {

					if (snapshotDescriptor._repeatEnsureAfterInstall && id !== snapshotDescriptor._repeatEnsureAfterInstall) {
						return callback(null);
					}

					if (locator.install !== true) {
						// TODO: Record reason.
						return callback(null);
					}

					return throttle(callback, function(callback) {

						function _aspectifyPath(path) {
							return path;
						}

						var installedPath = _abspath(_aspectifyPath(locator.smi.installedPath));

						function error(err) {
							err.message += " (while installing '" + installedPath + "')";
							err.stack += "\n(while installing '" + installedPath + "')";
							// TODO: Move directory to `*~failed`.
			            	if (FS.existsSync(installedPath)) {
			            		FS.removeSync(installedPath);
			            	}
							return callback(err);
						}

						return FS.exists(installedPath, function(exists) {
							if (!exists) {
								console.error("Warning: Cannot install package '" + id + "'. No directory found for '" + aspect + "' aspect!");
								return callback(null);
							}

							// TODO: Use `it.pinf.package` to detect pm.
							var type = "npm";

							return require.async("./adapters/" + type, function(api) {
								return api.install(_aspectifyPath(basePath), locator, packages, function(err) {
									if (err) return error(err);
									return callback(null);
								});
							}, error);
						});
					});
				}

// TODO: Change to `parallel` once smi can communicate inter-process to enable shared locking.
//       Currently if running multiple smi installs, resource installations may overlap at the wrong time!
//				var waitfor = WAITFOR.parallel(function(err) {
				var waitfor = WAITFOR.serial(function(err) {
					if (err) return callback(err);
					return callback(null, summary);
				});

				// TODO: Allow for declaring one mapping to be dependent on another
				//       and use `async` NPM module to install?
				for (var id in summary) {
					for (var aspect in summary[id].aspects) {
						if (aspect === "source") {
							waitfor(id, aspect, summary[id].aspects[aspect], doit);
						}
					}
				}
				return waitfor();

				// TODO: Optionally put dependency into read only mode.
	            //'chmod -Rf 0544 _upstream',
	            //'find _upstream -type f -iname "*" -print0 | xargs -I {} -0 chmod 0444 {}',
	            //'find _upstream/* -maxdepth 1 -type d -print0 | xargs -I {} -0 chmod u+w {}'
			}

			return ensure(function(err) {
				if (err) return callback(err);
				return link(function(err) {
					if (err) return callback(err);
					return install(function(err) {
						if (err) return callback(err);
						if (snapshotDescriptor._repeatEnsureAfterInstall) {
							snapshotDescriptor._repeatEnsureAfterInstall = false;
							previousSummary = summary;
							return prepare(callback);
						}
						return callback(null, summary);
					});
				});
			});
		});
	}

	return prepare(function(err, summary) {
		if (err) return callback(err);

		function activate(callback) {

			console.log("[smi] activate".cyan);

			function doit(id, info, callback) {
				function _aspectifyPath(path) {
					return path;
				}
				var livePath = _abspath(_aspectifyPath(info.livePath));
				if (FS.existsSync(livePath)) {
					FS.removeSync(livePath);
				}
	            console.log(("Activating: " + _abspath(_aspectifyPath(info.installedPath))).magenta);
				if (!FS.existsSync(PATH.dirname(livePath))) {
					FS.mkdirsSync(PATH.dirname(livePath));
				}
				return FS.symlink(PATH.relative(PATH.dirname(livePath), _abspath(_aspectifyPath(info.installedPath))), livePath, callback);
			}

			var waitfor = WAITFOR[installOptions.debug ? "serial":"parallel"](function(err) {
				if (err) return callback(err);
				return callback(null, summary);
			});
			// TODO: Allow for declaring one mapping to be dependent on another
			//       and use `async` NPM module to install?
			for (var id in summary) {
				waitfor(id, summary[id], doit);
			}
			return waitfor();
		}

		return activate(callback);
	});
}


// @source https://github.com/c9/architect/blob/567b7c034d7644a2cc0405817493b451b01975fa/architect.js#L332
function orderPackages(plugins) {
    var resolved = {
        hub: true
    };
    var changed = true;
    var sorted = [];

    while(plugins.length && changed) {
        changed = false;

        plugins.concat().forEach(function(plugin) {
            var consumes = plugin.consumes.concat();

            var resolvedAll = true;
            for (var i=0; i<consumes.length; i++) {
                var service = consumes[i];
                if (!resolved[service]) {
                    resolvedAll = false;
                } else {
                    plugin.consumes.splice(plugin.consumes.indexOf(service), 1);
                }
            }

            if (!resolvedAll)
                return;

            plugins.splice(plugins.indexOf(plugin), 1);
            plugin.provides.forEach(function(service) {
                resolved[service] = true;
            });
            sorted.push(plugin);
            changed = true;
        });
    }

    if (plugins.length) {
        var unresolved = {};
        plugins.forEach(function(plugin) {
            delete plugin.config;
            plugin.consumes.forEach(function(name) {
                if (unresolved[name] == false)
                    return;
                if (!unresolved[name])
                    unresolved[name] = [];
                unresolved[name].push(plugin.packagePath);
            });
            plugin.provides.forEach(function(name) {
                unresolved[name] = false;
            });
        });

        Object.keys(unresolved).forEach(function(name) {
            if (unresolved[name] == false)
                delete unresolved[name];
        });

        console.error("Could not resolve dependencies of these plugins:", plugins);
        console.error("Resolved services:", Object.keys(resolved));
        console.error("Missing services:", unresolved);
        throw new Error("Could not resolve dependencies");
    }
    return sorted;
}
