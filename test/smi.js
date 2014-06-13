
const ASSERT = require("assert");
const PATH = require("path");
const FS = require("fs-extra");
const DIRSUM = require("dirsum");
const SMI = require("../lib/smi");
const UTIL = require("./_util");

//const MODE = "test";
const MODE = "write";

const DEBUG = false;


describe('smi', function() {

	this.timeout(30 * 1000);
	var tmpPath = PATH.join(__dirname, ".tmp");
	if (FS.existsSync(tmpPath)) {
		FS.removeSync(tmpPath);
	}

	var assetBasePath = PATH.join(__dirname, "assets");

	FS.readdirSync(assetBasePath).forEach(function(filename) {
		if (!/^\d+-([^\.]+)\.smi\.json$/.test(filename)) return;

		var testName = filename.replace(/\.smi\.json$/, "");

//if (!/^15/.test(testName)) return;

    	it(testName, function(callback) {

			var resultPath = PATH.join(tmpPath, testName);

    		function run(expectPath, callback) {
	    		return SMI.install(resultPath, PATH.join(assetBasePath, filename), {
	    			verbose: false,
	    			debug: false
	    		}, function(err, info) {
	    			if (err) return callback(err);
					return DIRSUM.digest(resultPath, function(err, hashes) {
						if (err) return callback(err);
						var expectInfo = UTIL.normalizeInfo({
							hashes: hashes,
							info: info
						});
						if (MODE === "write") {
							FS.outputFileSync(expectPath, JSON.stringify(expectInfo, null, 4));
						} else {
							ASSERT.deepEqual(expectInfo, FS.readJsonSync(expectPath));
						}
						return callback(null);
					});
	    		});
    		}

    		return run(PATH.join(assetBasePath, testName + ".expect.1.json"), function(err) {
    			if (err) return callback(err);
	    		return run(PATH.join(assetBasePath, testName + ".expect.2.json"), callback);
    		});
	    });
	});

});

