ifeq ($(VERSION), "")
	@echo "Use gmake"
endif


#
# Config
#

# Directories
SRC := $(shell pwd)
NODEDIR = $(SRC)/deps/node-install

# Tools
MAKE = make
TAR = tar
UNAME := $(shell uname)
ifeq ($(UNAME), SunOS)
	MAKE = gmake
	TAR = gtar
	CC = gcc
	CCFLAGS	= -fPIC -g -Wall
	LDFLAGS	= -static-libgcc
	LIBS = -lpthread -lzonecfg -L/lib -lnsl -lsocket
endif

DOC_CMD = restdown
HAVE_GJSLINT := $(shell which gjslint >/dev/null && echo yes || echo no)
NODE := $(NODEDIR)/bin/node
NODE_WAF := $(NODEDIR)/bin/node-waf
NPM := npm_config_tar=$(TAR) PATH=$(NODEDIR)/bin:$$PATH npm
NODE_DEV := PATH=$(NODEDIR)/bin:$$PATH node-dev
PKG_DIR := .pkg
RIAK := deps/riak/rel/riak/bin/riak
WHISKEY = bin/whiskey

#
# Targets
#

all:: pkg
.PHONY: deps agent relay master common plugins test lint gjslint jshint pkg


#
# deps
#

deps:	$(NODEDIR)/bin/node $(NODEDIR)/bin/npm $(RIAK) \
	$(NODEDIR)/lib/node_modules/whiskey $(NODEDIR)/lib/node_modules/jshint

# Use 'Makefile' landmarks instead of the dir itself, because dir mtime
# is that of the most recent file: results in unnecessary rebuilds.
deps/riak/Makefile deps/node/Makefile deps/npm/Makefile:
	(GIT_SSL_NO_VERIFY=1 git submodule update --init)

$(NODEDIR)/bin/node: deps/node/Makefile
	(cd deps/node && ./configure --prefix=$(NODEDIR) && $(MAKE) -j 4 && $(MAKE) install)

$(NODEDIR)/bin/npm: $(NODEDIR)/bin/node deps/npm/Makefile
	(cd deps/npm && npm_config_tar=$(TAR) PATH=$(NODEDIR)/bin:$$PATH $(MAKE) install)

# `touch` to ensure built product is newer than the Makefile dep.
$(RIAK): deps/riak/Makefile
	(cd deps/riak && make rel && touch rel/riak/bin/riak)

# Global npm module deps (currently just test/lint stuff used by every amon
# package). We install globally instead of 'npm install --dev' in every package
# and having duplicated.
$(NODEDIR)/lib/node_modules/whiskey: $(NODEDIR)/bin/npm
	$(NPM) install -g whiskey
$(NODEDIR)/lib/node_modules/jshint: $(NODEDIR)/bin/npm
	$(NPM) install -g jshint@0.1.9


#
# The main amon components
#

common: deps
	(cd common && $(NPM) install && $(NPM) link)

plugins: deps
	(cd plugins && $(NPM) install && $(NPM) link)

agent: deps
	(cd agent && $(NPM) install && $(NPM) link amon-common amon-plugins)

relay: deps
	(cd relay && $(NPM) install && $(NPM) link amon-common amon-plugins)

bin/amon-zwatch:
ifeq ($(UNAME), SunOS)
	${CC} ${CCFLAGS} ${LDFLAGS} -o bin/amon-zwatch $^ zwatch/zwatch.c ${LIBS}
endif

master: deps
	(cd master && $(NPM) install && $(NPM) link amon-common amon-plugins)


#
# Lint, test and miscellaneous targets
#

jshint: deps
	bin/node $(NODEDIR)/lib/node_modules/jshint/bin/jshint common/lib plugins/lib master/main.js master/lib relay/main.js relay/lib agent/main.js agent/lib

gjslint:
	gjslint --nojsdoc -e deps,node_modules,tmp -x common/lib/sprintf.js -r .

ifeq ($(HAVE_GJSLINT), yes)
lint: jshint gjslint
else
lint: jshint
	@echo "* * *"
	@echo "* Warning: Cannot lint with gjslint. Install it from:"
	@echo "*    http://code.google.com/closure/utilities/docs/linter_howto.html"
	@echo "* * *"
endif

#TODO(trent): add deps/restdown submodule
docs:
	restdown -v -m doc doc/api.md
apisummary:
	@grep '^\(# \| *\(POST\|GET\|DELETE\|HEAD\|PUT\)\)' doc/api.md

tmp:
	mkdir -p tmp
test: tmp
	support/test.sh

# A supervisor for restarting node processes when relevant files change.
$(NODEDIR)/bin/node-dev: $(NODEDIR)/bin/npm
	$(NPM) install -g node-dev

devrun: tmp $(NODEDIR)/bin/node-dev
	support/devrun.sh
devwipedb:
	rm -rf deps/riak/rel/riak/data/bitcask

pkg_relay:
	@rm -fr $(PKG_DIR)/relay
	@mkdir -p $(PKG_DIR)/relay/bin
	@mkdir -p $(PKG_DIR)/relay/deps
	@mkdir -p $(PKG_DIR)/relay

	cp -r	bin/amon-relay		\
		bin/amon-zwatch		\
		$(PKG_DIR)/relay/bin

	cp -r 	deps/node-install	\
		$(PKG_DIR)/relay/deps

	cp -r 	relay/lib		\
		relay/main.js		\
		relay/node_modules	\
		relay/package.json	\
		relay/smf		\
		relay/smf_scripts	\
		$(PKG_DIR)/relay

	@mkdir $(PKG_DIR)/relay/relay
	@(cd $(PKG_DIR)/relay/relay && ln -s ../main.js main.js)

	(cd $(PKG_DIR) && $(TAR) zcf ../amon-relay.tar.gz relay)


pkg: common plugins agent relay bin/amon-zwatch master

clean:
	(cd deps/npm && $(MAKE) clean)
	(cd deps/node && $(MAKE) distclean)
	(cd deps/riak && $(MAKE) clean)
	@rm -rf $(NODEDIR) agent/node_modules relay/node_modules \
		master/node_modules bin/amon-zwatch .pkg *.tar.gz
