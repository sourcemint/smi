
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


COLORS.setTheme({
    error: 'red'
});


exports.install = function (basePath, snapshotDescriptor, callback) {

	ASSERT.equal(typeof basePath, "string");
	ASSERT.equal(typeof snapshotDescriptor, "object");

	var summary = {};

	function _abspath() {
		return PATH.join.apply(null, [basePath].concat(Array.prototype.slice.apply(arguments)));
	}

	function ensure(callback) {
		var waitfor = WAITFOR.parallel(function(err) {
			if (err) return callback(err);
			return callback(null, summary);
		});
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

	function ensurePackage(id, locator, callback) {
		var targetPath = null;
		// `./dependencies/smi`
		if (/^\./.test(id)) {
			targetPath = id;
		} else {
			// TODO: Make default directory configurable.
			targetPath = "./_packages/" + id;
		}

		var locatorFilename = ".smi.json";

		// TODO: Use pinf locator resolution logic.
		if (typeof locator === "string") {
			locator = {
				archive: locator
			};
		}

		ASSERT.equal(typeof locator, "object");
		ASSERT.equal(typeof locator.archive, "string");

		// TODO: Take compile flags into account.
		var revision = CRYPTO.createHash("sha1");
	    revision.update(locator.archive);
		revision = revision.digest("hex");

		var desiredLocator = {
			archive: locator.archive,
			smi: {
				revision: revision,
				downloadedPath: targetPath + "-" + revision.substring(0, 7) + ".tgz",
				extractedPath: targetPath + "-" + revision.substring(0, 7) + "~extracted",
				installedPath: targetPath + "-" + revision.substring(0, 7),
				livePath: targetPath
			}
		};
		var actualLocator = null;

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
				var tmpPath = archivePath + "~" + Date.now();
                if (!FS.existsSync(PATH.dirname(tmpPath))) {
                    FS.mkdirsSync(PATH.dirname(tmpPath));
                }
                try {
                    console.log(("Downloading package archive from '" + url + "'").magenta);
                    REQUEST(url, function(err) {
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
                console.log(("Extract '" + archivePath + "' to '" + extractedPath + "'").magenta);
				var tmpPath = extractedPath + "~" + Date.now();
                if (!FS.existsSync(tmpPath)) {
                    FS.mkdirsSync(tmpPath);
                }
                return EXEC('tar -xzf "' + PATH.basename(archivePath) + '" --strip 1 -C "' + tmpPath + '/"', {
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
					return callback(null);
				}
			}

			return ensureDownloaded(_abspath(desiredLocator.smi.downloadedPath), desiredLocator.archive, function(err) {
				if (err) return callback(err);

				return ensureExtracted(_abspath(desiredLocator.smi.extractedPath), _abspath(desiredLocator.smi.downloadedPath), function(err) {
					if (err) return callback(err);

					return readDescriptor(_abspath(desiredLocator.smi.extractedPath, "package.json"), function(err, descriptor) {
						if (err) return callback(err);

						actualLocator = DEEPCOPY(desiredLocator);
						actualLocator.descriptor = DEEPMERGE(descriptor, actualLocator.descriptor || {});

						return writeLocator(_abspath(desiredLocator.smi.extractedPath), function(err) {
							if (err) return callback(err);

							summary[id] = actualLocator;

							return callback(null);
						});
					});
                });
            });
		});
	}

	function install(callback) {

		function doit(id, locator, callback) {
			function error(err) {
            	if (FS.existsSync(_abspath(locator.smi.installedPath))) {
            		FS.removeSync(_abspath(locator.smi.installedPath));
            	}
				return callback(err);
			}

			return FS.exists(_abspath(locator.smi.installedPath), function(exists) {
				if (exists) return callback(null);
				return FS.rename(_abspath(locator.smi.extractedPath), _abspath(locator.smi.installedPath), function(err) {
					if (err) return error(err);

					function linkDependencies(callback) {
		            	if (!locator.descriptor.dependencies) {
		            		return callback(null);
		            	}
		                for (var name in locator.descriptor.dependencies) {
		                	var path = PATH.join(targetPath, "..", name);
		                    if (FS.existsSync(path)) {
		                        var linkPath = _abspath(locator.smi.installedPath, "node_modules", name);
		                        console.log(("Linking '" + PATH.dirname(services[name]._path) + "' to '" + linkPath + "'.").magenta);
		                        if (!FS.existsSync(PATH.dirname(linkPath))) {
		                            FS.mkdirsSync(PATH.dirname(linkPath));
		                        } else
		                        if (FS.existsSync(linkPath)) {
		                            FS.removeSync(linkPath);
		                        }
		                        FS.symlinkSync(path, linkPath);
		                    }
		                }
		                return callback(null);
		            }

					return linkDependencies(function(err) {
						if (err) return error(err);

			            console.log(("Calling `npm install` for: " + _abspath(locator.smi.installedPath)).magenta);
			            var proc = SPAWN("npm", [
			                "install"
			            ], {
			                cwd: _abspath(locator.smi.installedPath)
			            });
			            proc.stdout.on('data', function (data) {
			                process.stdout.write(data);
			            });
			            proc.stderr.on('data', function (data) {
			                process.stderr.write(data);
			            });
			            proc.on('close', function (code) {
			                if (code !== 0) {
			                    console.error("ERROR: `npm install` exited with code '" + code + "'");
			                    return callback(new Error("`npm install` script exited with code '" + code + "'"));
			                }
			                console.log(("`npm install` for '" + _abspath(locator.smi.installedPath) + "' done!").green);
			                return callback(null);
			            });
					});
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
			waitfor(id, summary[id], doit);
		}
		return waitfor();
	}

	function activate(callback) {

		function doit(id, locator, callback) {
			if (FS.existsSync(_abspath(locator.smi.livePath))) {
				FS.removeSync(_abspath(locator.smi.livePath));
			}
            console.log(("Activating: " + _abspath(locator.smi.installedPath)).magenta);
			return FS.symlink(PATH.relative(PATH.dirname(_abspath(locator.smi.livePath)), _abspath(locator.smi.installedPath)), _abspath(locator.smi.livePath), callback);
		}

		var waitfor = WAITFOR.parallel(function(err) {
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

	return ensure(function(err) {
		if (err) return callback(err);
		return install(function(err) {
			if (err) return callback(err);
			return activate(callback);
		});
	});
}

