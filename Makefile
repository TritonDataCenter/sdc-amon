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
NPM_FLAGS = --tar=$(TAR) --cache=$(shell pwd)/tmp/npm-cache

#
# Files
#
DOC_FILES = index.restdown design.restdown
JS_FILES = $(shell ls master/*.js relay/*.js agent/*.js) \
	$(shell find master relay agent common plugins test -name '*.js' \
	| grep -v node_modules | grep -v '/tmp/')
JSL_CONF_NODE    = tools/jsl.node.conf
JSL_FILES_NODE   = $(JS_FILES)
JSSTYLE_FILES    = $(JS_FILES)
SMF_MANIFESTS_IN = agent/smf/manifests/amon-agent.xml.in \
	relay/smf/manifests/amon-relay.xml.in \
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

all: common plugins agent testbuild relay master dev


#
# The main amon components
#

.PHONY: common
common: | $(NPM_EXEC)
	(cd common && $(NPM) update && $(NPM) link)

.PHONY: plugins
plugins: | $(NPM_EXEC)
	(cd plugins && $(NPM) update && $(NPM) link)

.PHONY: agent
agent: common plugins | $(NPM_EXEC)
	(cd agent && $(NPM) update && $(NPM) link amon-common amon-plugins)

.PHONY: relay
relay: common testbuild | $(NPM_EXEC) deps/node-sdc-clients/.git
	(cd relay && $(NPM) update && $(NPM) install ../deps/node-sdc-clients && $(NPM) link amon-common amon-plugins)
	# Workaround https://github.com/isaacs/npm/issues/2144#issuecomment-4062165
	(cd relay && rm -rf node_modules/zutil/build && $(NPM) rebuild zutil)

.PHONY: master
master: common plugins | $(NPM_EXEC) deps/node-sdc-clients/.git
	(cd master && $(NPM) update && $(NPM) install ../deps/node-sdc-clients && $(NPM) link amon-common amon-plugins)

# 'testbuild' is the name for building in the 'test' dir. Want 'make test'
# to actually *run* the tests.
.PHONY: testbuild
testbuild: | $(NPM_EXEC) deps/node-sdc-clients/.git
	(cd test && $(NPM) update && $(NPM) install ../deps/node-sdc-clients)

# "dev" is the name for the top-level dev package
.PHONY: dev
dev: common | $(NPM_EXEC) deps/node-sdc-clients/.git
	$(NPM) install deps/node-sdc-clients
	$(NPM) link amon-common
	$(NPM) install

deps/node-sdc-clients/.git:
	GIT_SSL_NO_VERIFY=1 git submodule update --init deps/node-sdc-clients


#
# Packaging targets
#

.PHONY: pkg
pkg: pkg_agent pkg_relay pkg_master

.PHONY: pkg_relay
pkg_relay:
	rm -fr $(BUILD)/pkg/relay
	mkdir -p $(BUILD)/pkg/relay/build
	cp -PR $(NODE_INSTALL) $(BUILD)/pkg/relay/build/node
	# '-H' to follow symlink for amon-common and amon-plugins node modules.
	mkdir -p $(BUILD)/pkg/relay/node_modules
	ls -d relay/node_modules/* | xargs -n1 -I{} cp -HR {} $(BUILD)/pkg/relay/node_modules/
	cp -PR relay/lib \
		relay/main.js \
		relay/package.json \
		relay/smf \
		relay/pkg \
		relay/bin \
		relay/.npmignore \
		test \
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
	mkdir -p $(BUILD)/pkg/agent/build
	cp -PR $(NODE_INSTALL) $(BUILD)/pkg/agent/build/node
	# '-H' to follow symlink for amon-common and amon-plugins node modules.
	mkdir -p $(BUILD)/pkg/agent/node_modules
	ls -d agent/node_modules/* | xargs -n1 -I{} cp -HR {} $(BUILD)/pkg/agent/node_modules/
	cp -PR agent/lib \
		agent/main.js \
		agent/package.json \
		agent/smf \
		agent/pkg \
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
	rm -fr $(BUILD)/pkg/master
	mkdir -p $(BUILD)/pkg/master/root/opt/smartdc/amon/build
	cp -PR $(NODE_INSTALL) $(BUILD)/pkg/master/root/opt/smartdc/amon/build/node
	mkdir -p $(BUILD)/pkg/master/root/opt/smartdc/amon/node_modules
	# '-H' to follow symlink for amon-common and amon-plugins node modules.
	ls -d master/node_modules/* master/node_modules/.bin \
		| xargs -n1 -I{} cp -HR {} $(BUILD)/pkg/master/root/opt/smartdc/amon/node_modules/
	cp -PR master/bin \
		master/lib \
		master/smf \
		master/test \
		master/factory-settings.json \
		master/main.js \
		master/package.json \
		$(BUILD)/pkg/master/root/opt/smartdc/amon/

	# Trim out some unnecessary, duplicated, or dev-only pieces.
	find $(BUILD)/pkg/master -name "*.pyc" | xargs rm -f
	find $(BUILD)/pkg/master -name "*.o" | xargs rm -f
	find $(BUILD)/pkg/master -name c4che | xargs rm -rf   # waf build file
	find $(BUILD)/pkg/master -name .wafpickle* | xargs rm -rf   # waf build file
	find $(BUILD)/pkg/master -name .lock-wscript | xargs rm -rf   # waf build file
	find $(BUILD)/pkg/master -name config.log | xargs rm -rf   # waf build file

	(cd $(BUILD)/pkg/master \
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
	$(JSHINT) common/lib \
		plugins/lib plugins/test \
		master/main.js master/lib master/test \
		relay/main.js relay/lib \
		agent/main.js agent/lib \
		test

.PHONY: test
test:
	[ $(shell uname) == "SunOS" ] \
		|| (echo "error: can only run test suite on smartos GZ (perhaps try 'make test-coal'" && exit 1)
	./test/runtests.sh

.PHONY: test-coal
COAL=root@10.99.99.7
test-coal:
	./tools/rsync-master-to-coal
	./tools/rsync-relay-to-coal
	./tools/rsync-agent-to-coal
	ssh $COAL /opt/smartdc/agents/lib/node_modules/amon-relay/test/runtests.sh

# Test on Trent's kvm7.
.PHONY: test-kvm7
test-kvm7:
	./tools/rsync-master-to-kvm7
	./tools/rsync-relay-to-kvm7
	./tools/rsync-agent-to-kvm7
	ssh kvm7 /opt/smartdc/agents/lib/node_modules/amon-relay/test/runtests.sh

# Test on Trent's kvm7.
.PHONY: test-kvm7
test-kvm7:
	./tools/rsync-master-to-kvm7
	./tools/rsync-relay-to-kvm7
	./tools/rsync-agent-to-kvm7
	ssh kvm7 /opt/smartdc/agents/lib/node_modules/amon-relay/test/runtests.sh

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
