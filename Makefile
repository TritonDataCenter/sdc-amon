#
# Copyright (c) 2012, Joyent, Inc. All rights reserved.
#
# Makefile for Amon
#

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
CLEAN_FILES += agent/node_modules relay/node_modules \
	master/node_modules common/node_modules plugins/node_modules \
	./node_modules test/node_modules build/amon-*.tgz \
	build/amon-*.tar.bz2 lib build/pkg

# The prebuilt sdcnode version we want. See
# "tools/mk/Makefile.node_prebuilt.targ" for details.
NODE_PREBUILT_VERSION=v0.8.22
NODE_PREBUILT_TAG=gz


#
# Included definitions
#
include ./tools/mk/Makefile.defs
ifeq ($(shell uname -s),SunOS)
       include ./tools/mk/Makefile.node_prebuilt.defs
else
       include ./tools/mk/Makefile.node.defs
endif
include ./tools/mk/Makefile.smf.defs


#
# Tools
#
ifeq ($(shell uname -s),SunOS)
	TAR ?= gtar
	MAKE = gmake
else
	# Need to set MAKE to avoid 'gmake: command not found' due to
	# <https://github.com/chrisa/node-dtrace-provider/commit/c4a9231>
	MAKE = make
	TAR ?= tar
endif
NODE_DEV := ./node_modules/.bin/node-dev
TAP := ./node_modules/.bin/tap
JSSTYLE_FLAGS := -f tools/jsstyle.conf

# Need to get our tools/bin on PATH to get our 'python'
# first on the PATH. See RELENG-302.
NPM := PATH=$(TOP)/tools/bin:$(TOP)/$(NODE_INSTALL)/bin:$(PATH) node $(TOP)/$(NODE_INSTALL)/bin/npm --tar=$(TAR)


#
# Repo-specific targets
#

all: common plugins agent testbuild relay master dev


#
# The main amon components
#

.PHONY: common
common: | $(NPM_EXEC)
	(cd common && MAKE=$(MAKE) $(NPM) install && $(NPM) link)

.PHONY: plugins
plugins: | $(NPM_EXEC)
	(cd plugins && $(NPM) install && $(NPM) link)

.PHONY: agent
agent: common plugins | $(NPM_EXEC)
	(cd agent && $(NPM) link amon-common amon-plugins && MAKE=$(MAKE) $(NPM) install)

.PHONY: relay
relay: common plugins testbuild | $(NPM_EXEC)
	(cd relay && $(NPM) link amon-common amon-plugins && MAKE=$(MAKE) $(NPM) install)

.PHONY: master
master: common plugins | $(NPM_EXEC)
	(cd master && $(NPM) link amon-common amon-plugins && MAKE=$(MAKE) $(NPM) install)

# 'testbuild' is the name for building in the 'test' dir. Want 'make test'
# to actually *run* the tests.
.PHONY: testbuild
testbuild: | $(NPM_EXEC)
	(cd test && MAKE=$(MAKE) $(NPM) install)

# "dev" is the name for the top-level dev package
.PHONY: dev
dev: common | $(NPM_EXEC)
	$(NPM) link amon-common
	$(NPM) install


#
# Packaging targets
#

.PHONY: pkg
pkg: pkg_agent pkg_relay pkg_master

.PHONY: pkg_relay
pkg_relay:
	rm -fr $(BUILD)/pkg/amon-relay
	mkdir -p $(BUILD)/pkg/amon-relay/build
	cp -PR $(NODE_INSTALL) $(BUILD)/pkg/amon-relay/build/node
	# '-H' to follow symlink for amon-common and amon-plugins node modules.
	mkdir -p $(BUILD)/pkg/amon-relay/node_modules
	ls -d relay/node_modules/* | xargs -n1 -I{} cp -HR {} $(BUILD)/pkg/amon-relay/node_modules/
	cp -PR relay/lib \
		relay/main.js \
		relay/package.json \
		relay/smf \
		relay/pkg \
		relay/bin \
		relay/.npmignore \
		test \
		$(BUILD)/pkg/amon-relay/

	# tools/amon-relay.exclude contains a list of files and patterns of some
	#  unnecessary, duplicated, or dev-only pieces we don't want in the build.
	(cd $(BUILD)/pkg && $(TAR) --exclude-from=$(TOP)/tools/amon-relay.exclude \
		-zcf ../amon-relay-$(STAMP).tgz amon-relay)
	@echo "Created '$(BUILD)/amon-relay-$(STAMP).tgz'."

.PHONY: pkg_agent
pkg_agent:
	rm -fr $(BUILD)/pkg/amon-agent
	mkdir -p $(BUILD)/pkg/amon-agent/build
	cp -PR $(NODE_INSTALL) $(BUILD)/pkg/amon-agent/build/node
	# '-H' to follow symlink for amon-common and amon-plugins node modules.
	mkdir -p $(BUILD)/pkg/amon-agent/node_modules
	ls -d agent/node_modules/* | xargs -n1 -I{} cp -HR {} $(BUILD)/pkg/amon-agent/node_modules/
	cp -PR agent/lib \
		agent/main.js \
		agent/package.json \
		agent/smf \
		agent/pkg \
		agent/bin \
		agent/.npmignore \
		$(BUILD)/pkg/amon-agent/

	# tools/amon-agent.exclude contains a list of files and patterns of some
	#  unnecessary, duplicated, or dev-only pieces we don't want in the build.
	(cd $(BUILD)/pkg && $(TAR) --exclude-from=$(TOP)/tools/amon-agent.exclude \
	  -zcf ../amon-agent-$(STAMP).tgz amon-agent)
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

	# tools/amon-pkg.exclude contains a list of files and patterns of some
	#  unnecessary, duplicated, or dev-only pieces we don't want in the build.
	(cd $(BUILD)/pkg/master \
		&& $(TAR) --exclude-from=$(TOP)/tools/amon-pkg.exclude -cjf \
		$(shell unset CDPATH; cd $(BUILD); pwd)/amon-pkg-$(STAMP).tar.bz2 *)
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

.PHONY: test
test:
	[ $(shell uname) == "SunOS" ] \
		|| (echo "error: can only run test suite on smartos GZ (perhaps try 'make test-coal'" && exit 1)
	./test/runtests

.PHONY: test-coal
COAL=root@10.99.99.7
test-coal:
	./tools/rsync-master-to-coal
	./tools/rsync-relay-to-coal
	./tools/rsync-agent-to-coal
	ssh $COAL /opt/smartdc/agents/lib/node_modules/amon-relay/test/runtests

# Test on Trent's kvm7.
.PHONY: test-kvm7
test-kvm7:
	./tools/rsync-master-to-kvm7
	./tools/rsync-relay-to-kvm7
	./tools/rsync-agent-to-kvm7
	ssh kvm7 /opt/smartdc/agents/lib/node_modules/amon-relay/test/runtests

tmp:
	mkdir -p tmp

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
ifeq ($(shell uname -s),SunOS)
       include ./tools/mk/Makefile.node_prebuilt.targ
else
       include ./tools/mk/Makefile.node.targ
endif
include ./tools/mk/Makefile.smf.targ
include ./tools/mk/Makefile.targ
