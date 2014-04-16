smi
===

*Package Installation. Evolved.*

**Status: DEV**

The `smi` command installs packages and assets mapped in a `package.json` file into the directory structure of the declaring package.

It addresses the package installation features needed by a modern development workflow and can be thought of as building on top of [npm](https://www.npmjs.org/).

Most notably; `smi` adds an abstraction layer allowing the mapping of arbitrary external resources into arbitrary aliased namespeces within the package. This divorces the dependency implementation from the use of the dependency which is the foundation for supporting recomposable applications and systems.

At any time you should be able to *overlay* the package descriptor (`package.json`) and set a different dependency implementation for a given environment the package will run in. Assuming the alternate implementation exposes the same API, the declaring package should function as before.

`smi` embodies these principles and thus is a package installer suitable for use in a distributed system with diverse deployment requirements.

Features:

  * Declare dependencies using JSON
  * Install dependencies using command-line call
  * Idempotent operation for easy scripting integration
  * Compatible with `npm` ecosystem
  * Takes *npm dependencies* to another level
  * Reference assets using URIs
  * Reference assets using catalogs
  * Embeddable into NodeJS apps


Install
-------

	npm install smi.cli

Usage:

	smi -h


Docs
====

Declaring dependencies
----------------------

`package.json`

	{
		"upstream": {
			"catalogs": {
				"<id>": "<locator>",
				"archiveA": "./catalog.json"
			}
		},
		"mappings": {
			"<id>": "<locator>",
			// Place extracted archive anywhere
			"./local/archive1": "http://remote.com/archiveA.tar.gz",
			// or into `_packages` by default
			"archive1": "http://remote.com/archiveA.tar.gz",
			// Map packages using a catalog
			"archive2": "catalog1/archiveA"
		}
	}

`catalog.json`

	{
		"packages": {
			"archiveA": "http://remote.com/archiveA.tar.gz"
		}
	}

For a complete resource of supported *locators* see [./test/assets](https://github.com/sourcemint/smi/tree/master/test/assets).


Installing Dependencies
-----------------------

	smi install


TODO
====

  * Wrap various third party installers (e.g. `bower`, `composer`)
  * Write install history
  * Write more meta data
  * Cleanup
  * Refactor to run on *pinf* program prototype


License
=======

Copyright (c) 2014 Christoph Dorn

MIT License
