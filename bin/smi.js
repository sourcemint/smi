
const PATH = require("path");
const FS = require("fs-extra");
const Q = require("q");
const COMMANDER = require("commander");
const COLORS = require("colors");
const SMI = require("../lib/smi");


COLORS.setTheme({
    error: 'red'
});


if (require.main === module) {

    function error(err) {
        if (typeof err === "string") {
            console.error((""+err).red);
        } else
        if (typeof err === "object" && err.stack) {
            console.error((""+err.stack).red);
        }
        process.exit(1);
    }

    try {

        return Q.denodeify(function(callback) {

            var program = new COMMANDER.Command();

            program
                .version(JSON.parse(FS.readFileSync(PATH.join(__dirname, "../package.json"))).version)
                .option("-v, --verbose", "Show verbose progress")
                .option("--debug", "Show debug output")
                .option("-f, --force", "Force an operation when it would normally be skipped");

            var acted = false;

            program
                .command("install")
                .description("Install packages")
                .action(function(path) {
                    acted = true;
                    var basePath = process.cwd();
                    var descriptorPath = PATH.join(basePath, "package.json");
                    return Q.denodeify(function(callback) {
                    	return FS.exists(descriptorPath, function(exists) {
                    		if (!exists) {
                    			return callback("No descriptor found at: " + descriptorPath);
                    		}
							return SMI.install(basePath, descriptorPath, function(err, info) {
								if (err) return callback(err);
								process.stdout.write('<wf id="info">' + JSON.stringify(info, null, 4) + '</wf>' + "\n");
                                console.log("smi install success!".green);
								return callback(null);
							});
                    	});
                    })().then(function() {
                        return callback(null);
                    }).fail(callback);
                });

            program.parse(process.argv);

            if (!acted) {
                var command = process.argv.slice(2).join(" ");
                if (command) {
                    console.error(("ERROR: Command '" + process.argv.slice(2).join(" ") + "' not found!").error);
                }
                program.outputHelp();
                return callback(null);
            }
        })().then(function() {
            return process.exit(0);
        }).fail(error);
    } catch(err) {
        return error(err);
    }
}
