
const ASSERT = require("assert");
const PATH = require("path");
const FS = require("fs-extra");
const SPAWN = require("child_process").spawn;



exports.install = function (basePath, locator, packages, callback) {

	ASSERT.equal(typeof basePath, "string");

	function _abspath() {
		return PATH.join.apply(null, [basePath].concat(Array.prototype.slice.apply(arguments)));
	}

	function linkDependencies(callback) {
    	if (!locator.descriptor.dependencies) {
    		return callback(null);
    	}
        for (var name in locator.descriptor.dependencies) {
        	var path = _abspath(locator.smi.basePath, "..", name);
            if (packages[path]) {
                path = _abspath(packages[path].basePath);
                var linkPath = _abspath(locator.smi.installedPath, "node_modules", name);
                console.log(("Linking '" + path + "' to '" + linkPath + "'.").magenta);
                if (!FS.existsSync(PATH.dirname(linkPath))) {
                    FS.mkdirsSync(PATH.dirname(linkPath));
                } else
                if (FS.existsSync(linkPath)) {
                    FS.removeSync(linkPath);
                }
                FS.symlinkSync(PATH.relative(PATH.dirname(linkPath), path), linkPath);
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
}
