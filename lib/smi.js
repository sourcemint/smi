
require("require.async")(require);

const ASSERT = require("assert");
const PATH = require("path");
const FS = require("fs-extra");
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


COLORS.setTheme({
    error: 'red'
});


exports.readDescriptor = function(path, callback) {
	return FS.readJson(path, function(err, _descriptor) {
		if (err) return callback(err);
		var descriptor = Object.create({
			_path: path
		});
		for (var name in _descriptor) {
			descriptor[name] = _descriptor[name];
		}
		return callback(null, descriptor);
	});
}


exports.install = function (basePath, snapshotDescriptor, callback) {

	ASSERT.equal(typeof basePath, "string");

	function ensureDescriptor(callback) {
		function resolve(descriptor, callback) {
			if (
				descriptor &&
				descriptor.config &&
				descriptor.config["smi.cli"] &&
				descriptor.config["smi.cli"].descriptorPath
			) {
				if (descriptor._path === PATH.join(descriptor._path, "..", descriptor.config["smi.cli"].descriptorPath)) {
					return callback(null, descriptor);
				}
				return exports.readDescriptor(PATH.join(descriptor._path, "..", descriptor.config["smi.cli"].descriptorPath), function(err, _descriptor) {
					if (err) return callback(err);
					_descriptor.config = DEEPMERGE(_descriptor.config, {
						"smi.cli": descriptor.config["smi.cli"]
					});
					return resolve(_descriptor, callback);
				});
			}
			return callback(null, descriptor);
		}
		if (typeof snapshotDescriptor === "object") {
			return resolve(snapshotDescriptor, callback);
		}
		return exports.readDescriptor(snapshotDescriptor, function(err, descriptor) {
			if (err) return callback(err);
			return resolve(descriptor, callback);
		});
	}

	return ensureDescriptor(function(err, snapshotDescriptor) {
		if (err) return callback(err);

		ASSERT.equal(typeof snapshotDescriptor, "object");
		ASSERT.equal(typeof snapshotDescriptor._path, "string");

		var catalogs = {};
		var summary = {};
		var packages = {};

		var packagesDirectory = "_packages";
		if (
			snapshotDescriptor &&
			snapshotDescriptor.config &&
			snapshotDescriptor.config["smi.cli"] &&
			snapshotDescriptor.config["smi.cli"].packagesDirectory
		) {
			packagesDirectory = snapshotDescriptor.config["smi.cli"].packagesDirectory;
		}

		function _abspath() {
			return PATH.join.apply(null, [basePath].concat(Array.prototype.slice.apply(arguments)));
		}

		function ensure(callback) {

			console.log("[smi] ensure".cyan);

			function ensureCatalogs(callback) {
				var waitfor = WAITFOR.parallel(callback);
				// TODO: Make these configurable based on schema for `snapshotDescriptor`.
				[
					"upstream"
				].forEach(function(property) {
					if (!snapshotDescriptor[property]) return;
					if (snapshotDescriptor[property].packages) {
						for (var id in snapshotDescriptor[property].packages) {
							waitfor(id, snapshotDescriptor[property].packages[id], ensureUpstreamPackage);
						}
					}
					if (snapshotDescriptor[property].catalogs) {
						for (var id in snapshotDescriptor[property].catalogs) {
							waitfor(id, snapshotDescriptor[property].catalogs[id], ensureUpstreamCatalog);
						}
					}
				});
				return waitfor();
			}

			function ensurePackages(callback) {
				var waitfor = WAITFOR.parallel(callback);
				// TODO: Make these configurable based on schema for `snapshotDescriptor`.
				[
					"mappings"
				].forEach(function(property) {
					if (!snapshotDescriptor[property]) return;
					for (var id in snapshotDescriptor[property]) {
						waitfor(id, snapshotDescriptor[property][id], ensurePackage);
					}
				});
				return waitfor();
			}

			return ASYNC.series([
				ensureCatalogs,
				ensurePackages
			], callback);
		}

		function ensureUpstreamPackage(id, locator, callback) {
			if (typeof locator === "string") {
				locator = {
					uri: locator
				};
			}
			if (id === "*" && /^\./.test(locator.uri)) {
				var packagesPath = PATH.join(snapshotDescriptor._path, "..", locator.uri);
				return FS.readdir(packagesPath, function(err, filenames) {
					if (err) return callback(err);
					var waitfor = WAITFOR.parallel(callback);
					filenames.forEach(function(filename) {
						return waitfor(filename, PATH.join(packagesPath, filename), ensureUpstreamPackage);
					});
					return waitfor();
				});
			}
			ASSERT.equal(typeof locator.uri, "string");
			if (!packages[_abspath(id)]) {
				packages[_abspath(id)] = {
					basePath: locator.uri
				};
				// TODO: Also record package at realpath of `_abspath(id)`.
				packages[id] = {
					basePath: locator.uri
				};
				packages[id.split("/").pop()] = {
					basePath: locator.uri
				};
			}
			return callback(null);
		}

		function ensureUpstreamCatalog(id, locator, callback) {
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
				catalogs[id] = catalog;
				return callback(null);
			});
		}

		var downloads = {};
		var extracts = {};

		function ensurePackage(id, locator, callback) {

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
						var locatorIdParts = locator.split("/");
						if (
							catalogs[locatorIdParts[0]] &&
							catalogs[locatorIdParts[0]].packages &&
							catalogs[locatorIdParts[0]].packages[locatorIdParts[1]]
						) {
							console.log(("Found package '" + locatorIdParts[1] + "' in catalog '" + locatorIdParts[0] + "'!").cyan);
							locator = resolveLocator(catalogs[locatorIdParts[0]].packages[locatorIdParts[1]]);
						} else
						if (locatorIdParts.length === 2 && !/^\./.test(locator)) {
							// We seem to want to map a package in a catalog but the catalog is not declared.
							throw new Error("Catalog '" + locatorIdParts[0] + "' not declared. Used by locator '" + locator + "' for id '" + id + "'!");
						} else {
							locator = {
								location: locator
							};
						}
					}
					return locator;
				}
				locator = resolveLocator(locator);

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
					}

					function getExistingLocator(callback) {
						return FS.exists(_abspath(desiredLocator.smi.livePath, locatorFilename), function(exists) {
							if (exists) {
								return FS.readJson(_abspath(desiredLocator.smi.livePath, locatorFilename), callback);
							}
							return callback(null, null);
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
			                callback = function(err) {
			                	var callbacks = downloads[url];
			                	downloads[url] = archivePath;
			                	callbacks.forEach(function(callback) {
			                		if (err) return callback[1](err);
			                		return ensureDownloaded(callback[0], url, callback[1]);
			                	});
			                }
							var tmpPath = archivePath + "~" + Date.now();
			                if (!FS.existsSync(PATH.dirname(tmpPath))) {
			                    FS.mkdirsSync(PATH.dirname(tmpPath));
			                }
			                try {
			                    console.log(("Downloading package archive from '" + url + "' to '" + archivePath + "'").magenta);
			                    REQUEST(url, function(err, response) {
			                        if (err) return callback(err);
			                        return FS.rename(tmpPath, archivePath, function(err) {
			                        	if (err) return callback(err);
				                        console.log(("Downloaded package archive from '" + url + "'").green);
				                        return callback(null);
			                        });
			                    }).pipe(FS.createWriteStream(tmpPath))
			                } catch(err) {
			                	if (FS.existsSync(tmpPath)) {
			                		FS.removeSync(tmpPath);
			                	}
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
			                console.log(("Extract '" + archivePath + "' to '" + extractedPath + "'").magenta);
							var tmpPath = extractedPath + "~" + Date.now();
			                if (!FS.existsSync(tmpPath)) {
			                    FS.mkdirsSync(tmpPath);
			                }
			                return EXEC('tar -xzf "' + PATH.basename(archivePath) + '" --strip 1 -C "' + tmpPath + '/"' + ((locator.subpath)?' */' + locator.subpath:''), {
			                    cwd: PATH.dirname(archivePath)
			                }, function(err, stdout, stderr) {
			                    if (err) {
				                	if (FS.existsSync(tmpPath)) {
				                		FS.removeSync(tmpPath);
				                	}
			                    	return callback(err);
			                    }
			                    return FS.rename(tmpPath, extractedPath, function(err) {
			                    	if (err) return callback(err);
				                    console.log(("Archive '" + archivePath + "' extracted to '" + extractedPath + "'").green);
				                    return callback(null);
				                });
			                });
			            });
			        }

			        function readDescriptor(descriptorPath, callback) {
			        	return FS.exists(descriptorPath, function(exists) {
			        		if (!exists) return callback(null, null);
			        		return FS.readJson(descriptorPath, callback);
			        	});
			        }

					function writeLocator(targetPath, callback) {
						return FS.outputFile(PATH.join(targetPath, locatorFilename), JSON.stringify(actualLocator, null, 4), callback);
					}

					return getExistingLocator(function(err, existingLocator) {
						if (err) return callback(err);
						if (existingLocator) {
							if (DEEPEQUAL(existingLocator.smi, desiredLocator.smi)) {
								console.log(("Skip install package '" + id + "'. Already installed!").yellow);
								if (!summary[id]) {
									summary[id] = {};
								}
								summary[id][aspect || ""] = existingLocator;
								return callback(null);
							}
						}
						return ensureDownloaded(_abspath(desiredLocator.smi.downloadedPath), desiredLocator.location, function(err) {
							if (err) return callback(err);

							return ensureExtracted(_abspath(desiredLocator.smi.extractedPath), _abspath(desiredLocator.smi.downloadedPath), function(err) {
								if (err) return callback(err);

								return readDescriptor(_abspath(desiredLocator.smi.extractedPath, desiredLocator.subpath || "", "package.json"), function(err, descriptor) {
									if (err) return callback(err);

									actualLocator = DEEPCOPY(desiredLocator);
									actualLocator.descriptor = DEEPMERGE(descriptor, actualLocator.descriptor || {});

									return writeLocator(_abspath(desiredLocator.smi.extractedPath), function(err) {
										if (err) return callback(err);

										if (!summary[id]) {
											summary[id] = {};
										}
										summary[id][aspect || ""] = actualLocator;
										return callback(null);
									});
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

				if (locator.aspects) {
					var waitfor = WAITFOR.parallel(callback);
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
						revision: revision
					}, callback);
				} else {
					return callback(new Error("Cannot determine what to do with locator: " + JSON.stringify(locator, null, 4)));
				}
			} catch(err) {
				return callback(err);
			}
		}

		function link(callback) {

			console.log("[smi] link".cyan);

			function doit(id, aspect, locator, callback) {

				function _aspectifyPath(path) {
					return path;
				}

				var installedPath = _abspath(_aspectifyPath(locator.smi.installedPath));

				function error(err) {
	            	if (FS.existsSync(installedPath)) {
	            		FS.removeSync(installedPath);
	            	}
					return callback(err);
				}

				return FS.exists(installedPath, function(exists) {
					if (exists) return callback(null);

					var extractedPath = _abspath(_aspectifyPath(locator.smi.extractedPath));
					if (locator.subpath) {
						extractedPath = PATH.join(extractedPath, locator.subpath);
					}				
					console.log(("Copying '" + extractedPath + "' to '" + installedPath + "'.").magenta);
					function copy(callback) {
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
					return copy(function(err) {
						if (err) return error(err);	

						// TODO: Use `it.pinf.package` to detect pm.
						var type = "npm";

						return require.async("./adapters/" + type, function(api) {
							return api.link(_aspectifyPath(basePath), locator, packages, function(err) {
								if (err) return error(err);
								return callback(null);
							});
						}, error);
					});
				});
			}

			var waitfor = WAITFOR.parallel(function(err) {
				if (err) return callback(err);
				return callback(null, summary);
			});
			// TODO: Allow for declaring one mapping to be dependent on another
			//       and use `async` NPM module to install?
			for (var id in summary) {
				for (var aspect in summary[id]) {
					waitfor(id, aspect, summary[id][aspect], doit);
				}
			}
			return waitfor();
		}

		function install(callback) {

			console.log("[smi] install".cyan);

			function doit(id, aspect, locator, callback) {

				function _aspectifyPath(path) {
					return path;
				}

				var installedPath = _abspath(_aspectifyPath(locator.smi.installedPath));

				function error(err) {
	            	if (FS.existsSync(installedPath)) {
	            		FS.removeSync(installedPath);
	            	}
					return callback(err);
				}

				// TODO: Use `it.pinf.package` to detect pm.
				var type = "npm";

				return require.async("./adapters/" + type, function(api) {
					return api.install(_aspectifyPath(basePath), locator, packages, function(err) {
						if (err) return error(err);
						return callback(null);
					});
				}, error);
			}

			var waitfor = WAITFOR.parallel(function(err) {
				if (err) return callback(err);
				return callback(null, summary);
			});

			// TODO: Allow for declaring one mapping to be dependent on another
			//       and use `async` NPM module to install?
			for (var id in summary) {
				for (var aspect in summary[id]) {
					waitfor(id, aspect, summary[id][aspect], doit);
				}
			}
			return waitfor();
		}

		function activate(callback) {

			console.log("[smi] activate".cyan);

			function doit(id, aspect, locator, callback) {
				function _aspectifyPath(path) {
					return path;
				}
				var livePath = _abspath(_aspectifyPath(locator.smi.livePath));
				if (FS.existsSync(livePath)) {
					FS.removeSync(livePath);
				}
	            console.log(("Activating: " + _abspath(_aspectifyPath(locator.smi.installedPath))).magenta);
				if (!FS.existsSync(PATH.dirname(livePath))) {
					FS.mkdirsSync(PATH.dirname(livePath));
				}
				return FS.symlink(PATH.relative(PATH.dirname(livePath), _abspath(_aspectifyPath(locator.smi.installedPath))), livePath, callback);
			}

			var waitfor = WAITFOR.parallel(function(err) {
				if (err) return callback(err);
				return callback(null, summary);
			});
			// TODO: Allow for declaring one mapping to be dependent on another
			//       and use `async` NPM module to install?
			for (var id in summary) {
				for (var aspect in summary[id]) {
					waitfor(id, aspect, summary[id][aspect], doit);
				}
			}
			return waitfor();
		}

		return ensure(function(err) {
			if (err) return callback(err);
			return link(function(err) {
				if (err) return callback(err);
				return install(function(err) {
					if (err) return callback(err);
					return activate(callback);
				});
			});
		});
	});		
}

