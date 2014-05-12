
const ASSERT = require("assert");
const PATH = require("path");
const FS = require("fs-extra");
const WAITFOR = require("waitfor");
const SPAWN = require("child_process").spawn;



exports.link = function(basePath, locator, packages, installOptions, callback) {

    try {

        ASSERT.equal(typeof basePath, "string");

        function _abspath() {
            return PATH.join.apply(null, [basePath].concat(Array.prototype.slice.apply(arguments)));
        }

        var declaredPackages = {};

        [
            "dependencies",
            "devDependencies",
            "mappings",
            "devMappings",
        ].forEach(function(property) {
            if (!locator.descriptor || !locator.descriptor[property]) return;
            Object.keys(locator.descriptor[property]).forEach(function(name) {
                declaredPackages[name] = true;
            });
        });
        declaredPackages = Object.keys(declaredPackages);

        if (declaredPackages.length === 0) {
            return callback(null);
        }

        var waitfor = WAITFOR.parallel(callback);
        declaredPackages.forEach(function(name) {

            waitfor(name, function(name, callback) {

                var linkPath = _abspath(locator.smi.installedPath, "node_modules", name);
                if (!FS.existsSync(PATH.dirname(linkPath))) {
                    FS.mkdirsSync(PATH.dirname(linkPath));
                } else
                if (FS.existsSync(linkPath)) {
                    FS.removeSync(linkPath);
                }

                var path = null;
                var symlinkValue = null;
                if (name === "smi.cli" && installOptions.linkSmi === true) {
                    symlinkValue = path = PATH.dirname(PATH.dirname(__dirname));
                    console.log(("Linking in our smi codebase at '" + path + "'!").cyan);
                } else {
                    path = _abspath(locator.smi.basePath, "..", name);
                    function obtainPath(locator) {
                        if (locator.aspects && locator.aspects.source && locator.aspects.source.basePath) {
                            path = _abspath(locator.aspects.source.basePath);
                        } else {
                            path = _abspath(locator.basePath);
                        }
                        return path;
                    }
                    if (packages[path]) {
                        path = obtainPath(packages[path]);
                    } else
                    if (packages[name]) {
                        path = obtainPath(packages[name]);
                    } else {
                        return callback(null);
                    }
                    if (locator.symlinked) {
                        path = FS.realpathSync(path);
                        linkPath = PATH.join(FS.realpathSync(PATH.dirname(linkPath)), PATH.basename(linkPath));
                    }
                    symlinkValue = PATH.relative(PATH.dirname(linkPath), path);
                }

                console.log(("Linking '" + path + "' to '" + linkPath + "' by storing '" + symlinkValue + "'.").magenta);
                FS.symlinkSync(symlinkValue, linkPath);

                function linkCommands(callback) {
                    var descriptorPath = PATH.join(path, "package.json");
                    var binBasePath = PATH.join(linkPath, "../.bin");
                    return FS.readJson(descriptorPath, function(err, descriptor) {
                        if (err) return callback(err);
                        if (!descriptor.bin) {
                            return callback(null);
                        }
                        for (var command in descriptor.bin) {

                            var linkPath = PATH.join(binBasePath, command);
                            var fromPath = PATH.join(descriptorPath, "..", descriptor.bin[command]);

                            console.log(("Linking '" + fromPath + "' to '" + linkPath + "'.").magenta);

                            if (!FS.existsSync(linkPath)) {
                                if (!FS.existsSync(fromPath)) {
                                    return callback(new Error("Command declared as '" + command + "' in '" + descriptorPath + "' not found at '" + fromPath + "'!"));
                                }
                                if (!FS.existsSync(PATH.dirname(linkPath))) {
                                    FS.mkdirsSync(PATH.dirname(linkPath));
                                }
                                FS.symlinkSync(PATH.relative(PATH.dirname(linkPath), fromPath), linkPath);
                            }
                        }
                        return callback(null);
                    });
                }

                return linkCommands(callback);
            });
        });
        return waitfor();
    } catch(err) {
        return callback(err);
    }
}


exports.install = function (basePath, locator, packages, callback) {

	ASSERT.equal(typeof basePath, "string");

	function _abspath() {
		return PATH.join.apply(null, [basePath].concat(Array.prototype.slice.apply(arguments)));
	}

    var command = "npm install";

    return FS.realpath(_abspath(locator.smi.installedPath), function(err, installedPath) {
        if (err) return callback(err);

        return FS.exists(PATH.join(installedPath, "Makefile"), function(exists) {
            if (exists) {
                command = "make";
            }

            console.log(("Calling `" + command + "` for: " + installedPath).magenta);
            // TODO: Show on debug only.
            //console.log("NOTE: If there are symlinked packages with links to targets that do not exist, npm will replace these symlinks with downloaded packages!");
            var proc = SPAWN(command.split(" ").shift(), command.split(" ").slice(1), {
                cwd: installedPath
            });
            proc.on('error', function (err) {
                console.error(err.stack);
                return callback(new Error("Spawn error while calling: " + command + " (cwd: " + installedPath + ")"));
            });
            proc.stdout.on('data', function (data) {
                process.stdout.write(data);
            });
            proc.stderr.on('data', function (data) {
                process.stderr.write(data);
            });
            return proc.on('close', function (code) {
                if (code !== 0) {
                    console.error("ERROR: `" + command + "` exited with code '" + code + "'");
                    return callback(new Error("`" + command + "` script exited with code '" + code + "'"));
                }
                console.log(("`npm install` for '" + installedPath + "' done!").green);
                return callback(null);
            });
        });
    });
}
