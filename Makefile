#
# Copyright (c) 2012, Joyent, Inc. All rights reserved.
#
# Makefile for Amon
#


#
# Tools
#
NODE_DEV := ./node_modules/.bin/node-dev
TAP := ./node_modules/.bin/tap
JSHINT := node_modules/.bin/jshint
JSSTYLE_FLAGS := -f tools/jsstyle.conf
NPM_FLAGS := --cache=$(shell pwd)/tmp/npm-cache

#
# Files
#
DOC_FILES = index.restdown
JS_FILES = $(shell ls master/*.js relay/*.js agent/*.js) \
       $(shell find master relay agent common plugins test -name '*.js')
JSL_CONF_NODE    = tools/jsl.node.conf
JSL_FILES_NODE   = $(JS_FILES)
JSSTYLE_FILES    = $(JS_FILES)
SMF_MANIFESTS_IN = agent/smf/amon-agent.smf.in relay/smf/amon-relay.smf.in \
	master/smf/amon-relay.smf.in
CLEAN_FILES += agent/node_modules relay/node_modules \
	master/node_modules common/node_modules plugins/node_modules \
	./node_modules build/amon-*.tgz \
	tmp/npm-cache build/amon-*.tar.bz2 \
	lib

#
# Included definitions
#
include ./tools/mk/Makefile.defs
include ./tools/mk/Makefile.node.defs
include ./tools/mk/Makefile.smf.defs


#
# Repo-specific targets
#

all: common plugins agent relay master dev


#
# deps
#

deps/node-sdc-clients/.git:
	([[ ! -d deps/node-sdc-clients ]] && GIT_SSL_NO_VERIFY=1 git submodule update --init deps/node-sdc-clients || true)

lib/node_modules/sdc-clients: | deps/node-sdc-clients/.git $(NPM_EXEC)
	cd deps/node-sdc-clients && $(NPM) install
	cd deps/node-sdc-clients && $(NPM) link   # make available for linking in 'dev' target



#
# The main amon components
#

.PHONY: common
common: $(NPM_EXEC)
	(cd common && $(NPM) update && $(NPM) link)


.PHONY: plugins
plugins: $(NPM_EXEC)
	(cd plugins && $(NPM) update && $(NPM) link)

.PHONY: agent
agent: $(NPM_EXEC) common plugins
	(cd agent && $(NPM) update && $(NPM) link amon-common amon-plugins)

.PHONY: relay
relay: $(NPM_EXEC) deps/node-sdc-clients/.git common plugins
	(cd relay && $(NPM) update && $(NPM) install ../deps/node-sdc-clients && $(NPM) link amon-common amon-plugins)
	# Workaround https://github.com/isaacs/npm/issues/2144#issuecomment-4062165
	(cd relay && rm -rf node_modules/zutil/build && $(NPM) rebuild zutil)

.PHONY: master
master: $(NPM_EXEC) deps/node-sdc-clients/.git common plugins
	(cd master && $(NPM) update && $(NPM) install ../deps/node-sdc-clients && $(NPM) link amon-common amon-plugins)

# "dev" is the name for the top-level test/dev package
.PHONY: dev
dev: $(NPM_EXEC) lib/node_modules/sdc-clients common
	$(NPM) install
	$(NPM) link amon-common
	$(NPM) link sdc-clients


#
# Packaging targets
#

.PHONY: pkg
pkg: pkg_agent pkg_relay pkg_master

.PHONY: pkg_relay
pkg_relay:
	rm -fr $(BUILD)/pkg/relay
	mkdir -p $(BUILD)/pkg/relay
	cp -PR $(NODE_INSTALL) $(BUILD)/pkg/relay/node
	# '-H' to follow symlink for amon-common and amon-plugins node modules.
	mkdir -p $(BUILD)/pkg/relay/node_modules
	ls -d relay/node_modules/* | xargs -n1 -I{} cp -HR {} $(BUILD)/pkg/relay/node_modules/
	cp -PR relay/lib		\
		relay/main.js		\
		relay/package.json	\
		relay/smf		\
		relay/npm \
		relay/bin \
		$(BUILD)/pkg/relay/

	# Trim out some unnecessary, duplicated, or dev-only pieces.
	rm -rf $(BUILD)/pkg/relay/node/lib/node_modules/amon-common \
		$(BUILD)/pkg/relay/node/lib/node_modules/amon-plugins
	find $(BUILD)/pkg/relay -name "*.pyc" | xargs rm -f
	find $(BUILD)/pkg/relay -name "*.o" | xargs rm -f
	find $(BUILD)/pkg/relay -name c4che | xargs rm -rf   # waf build file
	find $(BUILD)/pkg/relay -name .wafpickle* | xargs rm -rf   # waf build file
	find $(BUILD)/pkg/relay -name .lock-wscript | xargs rm -rf   # waf build file
	find $(BUILD)/pkg/relay -name config.log | xargs rm -rf   # waf build file

	(cd $(BUILD)/pkg && $(TAR) zcf ../amon-relay-$(STAMP).tgz relay)
	@echo "Created '$(BUILD)/amon-relay-$(STAMP).tgz'."

.PHONY: pkg_agent
pkg_agent:
	rm -fr $(BUILD)/pkg/agent
	mkdir -p $(BUILD)/pkg/agent
	cp -PR $(NODE_INSTALL) $(BUILD)/pkg/agent/node
	# '-H' to follow symlink for amon-common and amon-plugins node modules.
	mkdir -p $(BUILD)/pkg/agent/node_modules
	ls -d agent/node_modules/* | xargs -n1 -I{} cp -HR {} $(BUILD)/pkg/agent/node_modules/
	cp -PR agent/lib \
		agent/main.js \
		agent/package.json \
		agent/smf \
		agent/npm \
		agent/bin \
		agent/.npmignore \
		$(BUILD)/pkg/agent

	# Trim out some unnecessary, duplicated, or dev-only pieces.
	rm -rf $(BUILD)/pkg/agent/node/lib/node_modules/amon-common \
		$(BUILD)/pkg/agent/node/lib/node_modules/amon-plugins
	find $(BUILD)/pkg/agent -name "*.pyc" | xargs rm -f
	find $(BUILD)/pkg/agent -name .lock-wscript | xargs rm -rf   # waf build file

	(cd $(BUILD)/pkg && $(TAR) zcf ../amon-agent-$(STAMP).tgz agent)
	@echo "Created '$(BUILD)/amon-agent-$(STAMP).tgz'."

.PHONY: pkg_master
pkg_master:
	rm -fr $(BUILD)/pkg/pkg_master
	mkdir -p $(BUILD)/pkg/pkg_master/root/opt/smartdc/amon
	cp -PR $(NODE_INSTALL) $(BUILD)/pkg/pkg_master/root/opt/smartdc/amon/node
	mkdir -p $(BUILD)/pkg/pkg_master/root/opt/smartdc/amon/node_modules
	# '-H' to follow symlink for amon-common and amon-plugins node modules.
	ls -d master/node_modules/* \
		| xargs -n1 -I{} cp -HR {} $(BUILD)/pkg/pkg_master/root/opt/smartdc/amon/node_modules/
	cp -PR master/bin \
		master/lib \
		master/smf \
		master/factory-settings.json \
		master/main.js \
		master/package.json \
		$(BUILD)/pkg/pkg_master/root/opt/smartdc/amon/

	# Trim out some unnecessary, duplicated, or dev-only pieces.
	find $(BUILD)/pkg/pkg_master -name "*.pyc" | xargs rm -f
	find $(BUILD)/pkg/pkg_master -name "*.o" | xargs rm -f
	find $(BUILD)/pkg/pkg_master -name c4che | xargs rm -rf   # waf build file
	find $(BUILD)/pkg/pkg_master -name .wafpickle* | xargs rm -rf   # waf build file
	find $(BUILD)/pkg/pkg_master -name .lock-wscript | xargs rm -rf   # waf build file
	find $(BUILD)/pkg/pkg_master -name config.log | xargs rm -rf   # waf build file

	(cd $(BUILD)/pkg/pkg_master \
		&& $(TAR) cjf $(shell unset CDPATH; cd $(BUILD); pwd)/amon-pkg-$(STAMP).tar.bz2 *)
	@echo "Created '$(BUILD)/amon-pkg-$(STAMP).tar.bz2'."


# The "publish" target requires that "BITS_DIR" be defined.
# Used by Mountain Gorilla.
.PHONY: publish
publish: $(BITS_DIR)
	@if [[ -z "$(BITS_DIR)" ]]; then \
		echo "error: 'BITS_DIR' must be set for 'publish' target"; \
		exit 1; \
	fi
	mkdir -p $(BITS_DIR)/amon
	cp $(BUILD)/amon-pkg-$(STAMP).tar.bz2 \
		$(BUILD)/amon-relay-$(STAMP).tgz \
		$(BUILD)/amon-agent-$(STAMP).tgz \
		$(BITS_DIR)/amon/


#
# Lint, test and miscellaneous targets
#

.PHONY: dumpvar
dumpvar:
	@if [[ -z "$(VAR)" ]]; then \
		echo "error: set 'VAR' to dump a var"; \
		exit 1; \
	fi
	@echo "$(VAR) is '$($(VAR))'"

#XXX Add to check:: target as check-jshint
.PHONY: jshint
jshint:
	$(JSHINT) common/lib plugins/lib master/main.js master/lib relay/main.js relay/lib agent/main.js agent/lib

.PHONY: test
test:
	[ -f test/config.json ] \
		|| (echo "error: no 'test/config.json', use 'test/config.json.in'" && exit 1)
	[ -f test/prep.json ] \
		|| (echo "error: no 'test/prep.json', run 'cd test && node prep.js'" && exit 1)
	./test/clean-test-data.sh
	PATH=$(NODE_INSTALL)/bin:$(PATH) TAP=1 $(TAP) test/*.test.js

tmp:
	mkdir -p tmp

.PHONY: devrun
devrun: tmp $(NODE_DEV)
	tools/devrun.sh

.PHONY: install_agent_pkg
install_agent_pkg:
	/opt/smartdc/agents/bin/apm --no-registry install ./`ls -1 amon-agent*.tgz | tail -1`
.PHONY: install_relay_pkg
install_relay_pkg:
	/opt/smartdc/agents/bin/apm --no-registry install ./`ls -1 amon-relay*.tgz | tail -1`


#
# Includes
#

include ./tools/mk/Makefile.deps
include ./tools/mk/Makefile.node.targ
include ./tools/mk/Makefile.smf.targ
include ./tools/mk/Makefile.targ
