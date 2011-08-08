ifeq ($(VERSION), "")
	@echo "Use gmake"
endif


#
# Config
#

REVISION=$(shell git describe --contains --all HEAD)-$(shell git describe --tags)

# Directories
TOP := $(shell pwd)
NODEDIR = $(TOP)/deps/node-install
NODE_PATH = $(NODEDIR)

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
NPM_ENV := npm_config_cache=$(shell echo $(TOP)/tmp/npm-cache) npm_config_tar=$(TAR) PATH=$(NODEDIR)/bin:$$PATH
NPM := $(NPM_ENV) $(NODEDIR)/bin/npm
NODE_DEV := PATH=$(NODEDIR)/bin:$$PATH node-dev
PKG_DIR := .pkg
RIAK := deps/riak/rel/riak/bin/riak
WHISKEY = bin/whiskey


#
# Targets
#

all:: common plugins agent relay bin/amon-zwatch master

.PHONY: deps agent relay master common plugins test lint gjslint jshint pkg pkg_agent pkg_relay pkg_master upload


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
	(cd deps/npm && $(NPM_ENV) $(MAKE) install)

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

common: $(NODEDIR)/bin/npm
	(cd common && $(NPM) install && $(NPM) link)

plugins: $(NODEDIR)/bin/npm
	(cd plugins && $(NPM) install && $(NPM) link)

agent: $(NODEDIR)/bin/npm common plugins
	(cd agent && $(NPM) install && $(NPM) link amon-common amon-plugins)

relay: $(NODEDIR)/bin/npm common plugins
	(cd relay && $(NPM) install && $(NPM) link amon-common amon-plugins)

bin/amon-zwatch:
ifeq ($(UNAME), SunOS)
	${CC} ${CCFLAGS} ${LDFLAGS} -o bin/amon-zwatch $^ zwatch/zwatch.c ${LIBS}
endif

master: $(NODEDIR)/bin/npm common plugins $(RIAK)
	(cd master && $(NPM) install && $(NPM) link amon-common amon-plugins)

#
# Packaging targets
#

pkg: pkg_agent pkg_relay pkg_master
	echo "$(REVISION)" >$(PKG_DIR)/REVISION   # used by bamboo build

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

	# Trim out some unnecessary, duplicated, or dev-only pieces.
	rm -rf \
		$(PKG_DIR)/relay/deps/node-install/lib/node_modules/amon-common \
		$(PKG_DIR)/relay/deps/node-install/lib/node_modules/amon-plugins
	find $(PKG_DIR)/relay -name "*.pyc" | xargs rm
	find $(PKG_DIR)/relay -type d | grep 'node_modules\/jshint$$' | xargs rm -rf
	find $(PKG_DIR)/relay -type d | grep 'node_modules\/whiskey$$' | xargs rm -rf
	find $(PKG_DIR)/relay -type d | grep 'dirsum\/tst$$' | xargs rm -rf

	# For 'devrun' to work with a package install.
	@mkdir $(PKG_DIR)/relay/relay
	@(cd $(PKG_DIR)/relay/relay && ln -s ../main.js main.js)

	(cd $(PKG_DIR) && $(TAR) zcf ../amon-relay-$(REVISION).tar.gz relay)
	@echo "Created 'amon-relay-$(REVISION).tar.gz'."

pkg_agent:
	@rm -fr $(PKG_DIR)/agent
	@mkdir -p $(PKG_DIR)/agent/bin
	@mkdir -p $(PKG_DIR)/agent/deps
	@mkdir -p $(PKG_DIR)/agent

	cp -r	bin/amon-agent		\
		$(PKG_DIR)/agent/bin

	cp -r 	deps/node-install	\
		$(PKG_DIR)/agent/deps

	cp -r 	agent/lib		\
		agent/main.js		\
		agent/node_modules	\
		agent/package.json	\
		agent/smf		\
		agent/smf_scripts	\
		$(PKG_DIR)/agent

	# Trim out some unnecessary, duplicated, or dev-only pieces.
	rm -rf \
		$(PKG_DIR)/agent/deps/node-install/lib/node_modules/amon-common \
		$(PKG_DIR)/agent/deps/node-install/lib/node_modules/amon-plugins
	find $(PKG_DIR)/agent -name "*.pyc" | xargs rm
	find $(PKG_DIR)/agent -type d | grep 'node_modules\/jshint$$' | xargs rm -rf
	find $(PKG_DIR)/agent -type d | grep 'node_modules\/whiskey$$' | xargs rm -rf
	find $(PKG_DIR)/agent -type d | grep 'dirsum\/tst$$' | xargs rm -rf

	# For 'devrun' to work with a package install.
	@mkdir $(PKG_DIR)/agent/agent
	@(cd $(PKG_DIR)/agent/agent && ln -s ../main.js main.js)

	(cd $(PKG_DIR) && $(TAR) zcf ../amon-agent-$(REVISION).tar.gz agent)
	@echo "Created 'amon-agent-$(REVISION).tar.gz'."

pkg_master:
	@rm -fr $(PKG_DIR)/pkg_master
	@mkdir -p $(PKG_DIR)/pkg_master/root/opt/smartdc/amon/bin
	@mkdir -p $(PKG_DIR)/pkg_master/root/opt/smartdc/amon/deps

	cp -r bin/amon-master \
		$(PKG_DIR)/pkg_master/root/opt/smartdc/amon/bin

	cp -r deps/node-install \
		$(PKG_DIR)/pkg_master/root/opt/smartdc/amon/deps

	cp -r master \
		$(PKG_DIR)/pkg_master/root/opt/smartdc/amon/

	# Trim out some unnecessary, duplicated, or dev-only pieces.
	rm -rf \
		$(PKG_DIR)/pkg_master/root/opt/smartdc/amon/deps/node-install/lib/node_modules/amon-common \
		$(PKG_DIR)/pkg_master/root/opt/smartdc/amon/deps/node-install/lib/node_modules/amon-plugins
	find $(PKG_DIR)/pkg_master -name "*.pyc" | xargs rm
	find $(PKG_DIR)/pkg_master -type d | grep 'node_modules\/jshint$$' | xargs rm -rf
	find $(PKG_DIR)/pkg_master -type d | grep 'node_modules\/whiskey$$' | xargs rm -rf
	find $(PKG_DIR)/pkg_master -type d | grep 'dirsum\/tst$$' | xargs rm -rf

	(cd $(PKG_DIR)/pkg_master && $(TAR) cjf $(TOP)/amon-master-$(REVISION).tar.bz2 *)
	@echo "Created 'amon-master-$(REVISION).tar.bz2'."

# This presumes the running user has ssh keys setup for jill@assets.joyent.us.
upload:
	@echo "# https://assets.joyent.us/datasets/liveimg/"
	scp amon-agent-$(REVISION).tar.gz jill@assets.joyent.us:/data/assets/datasets/liveimg/.amon-agent-$(REVISION).tar.gz.partial
	ssh jill@assets.joyent.us "cd /data/assets/datasets/liveimg && mv .amon-agent-$(REVISION).tar.gz.partial amon-agent-$(REVISION).tar.gz"
	scp amon-relay-$(REVISION).tar.gz jill@assets.joyent.us:/data/assets/datasets/liveimg/.amon-relay-$(REVISION).tar.gz.partial
	ssh jill@assets.joyent.us "cd /data/assets/datasets/liveimg && mv .amon-relay-$(REVISION).tar.gz.partial amon-relay-$(REVISION).tar.gz"
	scp amon-master-$(REVISION).tar.gz jill@assets.joyent.us:/data/assets/datasets/liveimg/.amon-master-$(REVISION).tar.gz.partial
	ssh jill@assets.joyent.us "cd /data/assets/datasets/liveimg && mv .amon-master-$(REVISION).tar.gz.partial amon-master-$(REVISION).tar.gz"


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

clean:
	([[ -d deps/node ]] && cd deps/node && $(MAKE) distclean || true)
	([[ -d deps/riak ]] && cd deps/riak && $(MAKE) clean || true)
	@rm -rf $(NODEDIR) agent/node_modules relay/node_modules \
		master/node_modules bin/amon-zwatch .pkg amon-*.tar.gz \
		tmp/npm-cache
