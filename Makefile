ifeq ($(VERSION), "")
	@echo "Use gmake"
endif


#
# Config
#

# Mountain Gorilla-spec'd versioning.
# Need GNU awk for multi-char arg to "-F".
AWK=$(shell (which gawk 2>/dev/null | grep -v "^no ") || (which nawk 2>/dev/null | grep -v "^no ") || which awk)
BRANCH=$(shell git symbolic-ref HEAD | $(AWK) -F/ '{print $$3}')
ifeq ($(TIMESTAMP),)
	TIMESTAMP=$(shell date -u "+%Y%m%dT%H%M%SZ")
endif
DIRTY_ARG=--dirty
ifeq ($(IGNORE_DIRTY), 1)
	DIRTY_ARG=
endif
GITDESCRIBE=g$(shell git describe --all --long $(DIRTY_ARG) | $(AWK) -F'-g' '{print $$NF}')
STAMP=$(BRANCH)-$(TIMESTAMP)-$(GITDESCRIBE)


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
endif

HAVE_GJSLINT := $(shell which gjslint >/dev/null && echo yes || echo no)
NODE := $(NODEDIR)/bin/node
NODE_WAF := $(NODEDIR)/bin/node-waf
NPM_ENV := npm_config_cache=$(shell echo $(TOP)/tmp/npm-cache) npm_config_tar=$(TAR) PATH=$(NODEDIR)/bin:$$PATH
NPM := $(NPM_ENV) $(NODEDIR)/bin/npm
PKG_DIR := .pkg
RESTDOWN := python2.6 $(TOP)/deps/restdown/bin/restdown
NODE_DEV := $(TOP)/node_modules/.bin/node-dev
TAP := $(TOP)/node_modules/.bin/tap
JSHINT := $(TOP)/node_modules/.bin/jshint


#
# Targets
#

all:: common plugins agent relay master dev

.PHONY: common agent relay master common plugins test lint gjslint jshint pkg pkg_agent pkg_relay pkg_master publish


#
# deps
#

$(NODEDIR)/bin/node:
	(GIT_SSL_NO_VERIFY=1 git submodule update --init deps/node)
	(cd deps/node && ./configure --prefix=$(NODEDIR) && $(MAKE) -j 4 && $(MAKE) install)

$(NODEDIR)/bin/npm: $(NODEDIR)/bin/node
	(GIT_SSL_NO_VERIFY=1 git submodule update --init deps/npm)
	(cd deps/npm && $(NPM_ENV) $(MAKE) install)

deps/node-sdc-clients/package.json:
	(GIT_SSL_NO_VERIFY=1 git submodule update --init deps/node-sdc-clients)

deps/restdown/bin/restdown:
	(GIT_SSL_NO_VERIFY=1 git submodule update --init deps/restdown)



#
# The main amon components
#

common: $(NODEDIR)/bin/npm
	(cd common && $(NPM) update && $(NPM) link)

plugins: $(NODEDIR)/bin/npm
	(cd plugins && $(NPM) update && $(NPM) link)

agent: $(NODEDIR)/bin/npm common plugins
	(cd agent && $(NPM) update && $(NPM) link amon-common amon-plugins)

relay: $(NODEDIR)/bin/npm deps/node-sdc-clients/package.json common plugins
	(cd relay && $(NPM) update && $(NPM) install ../deps/node-sdc-clients && $(NPM) link amon-common amon-plugins)
	# Workaround https://github.com/isaacs/npm/issues/2144#issuecomment-4062165
	(cd relay && rm -rf node_modules/zutil/build && $(NPM) rebuild zutil)

master: $(NODEDIR)/bin/npm deps/node-sdc-clients/package.json common plugins
	(cd master && $(NPM) update && $(NPM) install ../deps/node-sdc-clients && $(NPM) link amon-common amon-plugins)

# "dev" is the name for the top-level test/dev package
.PHONY: dev
dev: $(NODEDIR)/bin/npm deps/node-sdc-clients/package.json common
	$(NPM) install
	$(NPM) link amon-common
	$(NPM) link deps/node-sdc-clients


#
# Packaging targets
#

pkg: pkg_agent pkg_relay pkg_master

pkg_relay:
	rm -fr $(PKG_DIR)/relay
	mkdir -p $(PKG_DIR)/relay/deps
	cp -PR deps/node-install $(PKG_DIR)/relay/deps
	# '-H' to follow symlink for amon-common and amon-plugins node modules.
	mkdir -p $(PKG_DIR)/relay/node_modules
	ls -d relay/node_modules/* | xargs -n1 -I{} cp -HR {} $(PKG_DIR)/relay/node_modules/
	cp -PR relay/lib		\
		relay/main.js		\
		relay/package.json	\
		relay/smf		\
		relay/npm \
		relay/bin \
		$(PKG_DIR)/relay/

	# Need .npmignore in each node module to explictly keep prebuilt
	# parts of it. Last time I checked this was only needed for the
	# 'buffertools' and 'dtrace-provider' modules.
	find $(PKG_DIR)/relay/node_modules -name node_modules \
		| xargs -n1 -I{} bash -c "ls -d {}/*" \
		| xargs -n1 -I{} touch {}/.npmignore
	find $(PKG_DIR)/relay/node_modules -name node_modules \
		| xargs -n1 -I{} bash -c "ls -d {}/*" \
		| xargs -n1 -I{} bash -c "cat $(TOP)/tools/keepbuildbits.npmignore >> {}/.npmignore"

	# Trim out some unnecessary, duplicated, or dev-only pieces.
	rm -rf $(PKG_DIR)/relay/deps/node-install/lib/node_modules/amon-common \
		$(PKG_DIR)/relay/deps/node-install/lib/node_modules/amon-plugins
	find $(PKG_DIR)/relay -name "*.pyc" | xargs rm -f
	find $(PKG_DIR)/relay -name "*.o" | xargs rm -f
	find $(PKG_DIR)/relay -name c4che | xargs rm -rf   # waf build file
	find $(PKG_DIR)/relay -name .wafpickle* | xargs rm -rf   # waf build file
	find $(PKG_DIR)/relay -name .lock-wscript | xargs rm -rf   # waf build file
	find $(PKG_DIR)/relay -name config.log | xargs rm -rf   # waf build file

	(cd $(PKG_DIR) && $(TAR) zcf ../amon-relay-$(STAMP).tgz relay)
	@echo "Created 'amon-relay-$(STAMP).tgz'."

pkg_agent:
	rm -fr $(PKG_DIR)/agent
	mkdir -p $(PKG_DIR)/agent/deps
	cp -PR deps/node-install $(PKG_DIR)/agent/deps
	# '-H' to follow symlink for amon-common and amon-plugins node modules.
	mkdir -p $(PKG_DIR)/agent/node_modules
	ls -d agent/node_modules/* | xargs -n1 -I{} cp -HR {} $(PKG_DIR)/agent/node_modules/
	cp -PR agent/main.js \
		agent/package.json \
		agent/smf \
		agent/npm \
		agent/bin \
		agent/.npmignore \
		$(PKG_DIR)/agent

	# Need .npmignore in each node module to explictly keep prebuilt
	# parts of it.
	ls -d $(PKG_DIR)/agent/node_modules/* \
		| xargs -n1 -I{} bash -c "touch {}/.npmignore; cat $(PKG_DIR)/agent/.npmignore >> {}/.npmignore"

	# Trim out some unnecessary, duplicated, or dev-only pieces.
	rm -rf $(PKG_DIR)/agent/deps/node-install/lib/node_modules/amon-common \
		$(PKG_DIR)/agent/deps/node-install/lib/node_modules/amon-plugins
	find $(PKG_DIR)/agent -name "*.pyc" | xargs rm -f
	find $(PKG_DIR)/agent -name .lock-wscript | xargs rm -rf   # waf build file

	(cd $(PKG_DIR) && $(TAR) zcf ../amon-agent-$(STAMP).tgz agent)
	@echo "Created 'amon-agent-$(STAMP).tgz'."

pkg_master:
	rm -fr $(PKG_DIR)/pkg_master
	mkdir -p $(PKG_DIR)/pkg_master/root/opt/smartdc/amon/deps
	cp -PR deps/node-install $(PKG_DIR)/pkg_master/root/opt/smartdc/amon/deps/
	mkdir -p $(PKG_DIR)/pkg_master/root/opt/smartdc/amon/master/node_modules
	# '-H' to follow symlink for amon-common and amon-plugins node modules.
	ls -d master/node_modules/* \
		| xargs -n1 -I{} cp -HR {} $(PKG_DIR)/pkg_master/root/opt/smartdc/amon/master/node_modules/
	cp -PR master/bin \
		master/lib \
		master/smf \
		master/factory-settings.json \
		master/main.js \
		master/package.json \
		$(PKG_DIR)/pkg_master/root/opt/smartdc/amon/master/

	# Trim out some unnecessary, duplicated, or dev-only pieces.
	find $(PKG_DIR)/pkg_master -name "*.pyc" | xargs rm -f
	find $(PKG_DIR)/pkg_master -name "*.o" | xargs rm -f
	find $(PKG_DIR)/pkg_master -name c4che | xargs rm -rf   # waf build file
	find $(PKG_DIR)/pkg_master -name .wafpickle* | xargs rm -rf   # waf build file
	find $(PKG_DIR)/pkg_master -name .lock-wscript | xargs rm -rf   # waf build file
	find $(PKG_DIR)/pkg_master -name config.log | xargs rm -rf   # waf build file

	(cd $(PKG_DIR)/pkg_master && $(TAR) cjf $(TOP)/amon-master-$(STAMP).tar.bz2 *)
	@echo "Created 'amon-master-$(STAMP).tar.bz2'."


# The "publish" target requires that "BITS_DIR" be defined.
# Used by Mountain Gorilla.
publish: $(BITS_DIR)
	@if [[ -z "$(BITS_DIR)" ]]; then \
		echo "error: 'BITS_DIR' must be set for 'publish' target"; \
		exit 1; \
	fi
	mkdir -p $(BITS_DIR)/amon
	cp amon-master-$(STAMP).tar.bz2 amon-relay-$(STAMP).tgz amon-agent-$(STAMP).tgz \
		$(BITS_DIR)/amon/


#
# Lint, test and miscellaneous targets
#



jshint:
	$(JSHINT) common/lib plugins/lib master/main.js master/lib relay/main.js relay/lib agent/main.js agent/lib

gjslint:
	gjslint --nojsdoc -e deps,node_modules,tmp -r .

ifeq ($(HAVE_GJSLINT), yes)
lint: jshint gjslint
else
lint: jshint
	@echo "* * *"
	@echo "* Warning: Cannot lint with gjslint. Install it from:"
	@echo "*    http://code.google.com/closure/utilities/docs/linter_howto.html"
	@echo "* * *"
endif

doc: deps/restdown/bin/restdown
	$(RESTDOWN) -v -m docs docs/index.md
apisummary:
	@grep '^\(## \)' docs/index.md

tmp:
	mkdir -p tmp

test:
	[ -f test/config.json ] \
		|| (echo "error: no 'test/config.json', use 'test/config.json.in'" && exit 1)
	[ -f test/prep.json ] \
		|| (echo "error: no 'test/prep.json', run 'cd test && node prep.js'" && exit 1)
	./test/clean-test-data.sh
	PATH=$(NODEDIR)/bin:$(PATH) TAP=1 $(TAP) test/*.test.js

devrun: tmp $(NODEDIR)/bin/node-dev
	tools/devrun.sh

install_agent_pkg:
	/opt/smartdc/agents/bin/agents-npm --no-registry install ./`ls -1 amon-agent*.tgz | tail -1`
install_relay_pkg:
	/opt/smartdc/agents/bin/agents-npm --no-registry install ./`ls -1 amon-relay*.tgz | tail -1`

clean:
	([[ -d deps/node ]] && cd deps/node && $(MAKE) distclean || true)
	rm -rf $(NODEDIR) agent/node_modules relay/node_modules \
		master/node_modules common/node_modules plugins/node_modules \
		./node_modules .pkg amon-*.tgz \
		tmp/npm-cache amon-*.tar.bz2
	rm -rf bin/amon-zwatch     # recently removed bits
