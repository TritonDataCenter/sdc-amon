#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright 2021 Joyent, Inc.
#

#
# Makefile for Amon
#

#
# Files
#
DOC_FILES = index.md design.md
EXTRA_DOC_DEPS += deps/restdown-brand-remora/.git
RESTDOWN_FLAGS   = --brand-dir=deps/restdown-brand-remora
JS_FILES = $(shell ls master/*.js relay/*.js agent/*.js) \
	$(shell find master relay agent common plugins test -name '*.js' \
	| grep -v node_modules | grep -v '/tmp/')
JSL_CONF_NODE    = tools/jsl.node.conf
JSL_FILES_NODE   = $(JS_FILES)
JSSTYLE_FILES    = $(JS_FILES)
CLEAN_FILES += agent/node_modules relay/node_modules \
	master/node_modules common/node_modules plugins/node_modules \
	./node_modules test/node_modules build/amon-*.tgz \
	build/amon-*.tar.gz lib build/pkg build/agent-python

# These files are transformed during setup/configure. We're
# listing them here just so that check-manifests can be run
# on the pre-converted versions, which are still valid xml.
SMF_MANIFESTS	= \
	agent/smf/manifests/amon-agent.xml.in \
	relay/smf/manifests/amon-relay.xml.in \
	relay/smf/manifests/amon-zoneevents.xml.in \
	master/smf/amon-master.smf.in


# The prebuilt sdcnode version we want. See
# "tools/mk/Makefile.node_prebuilt.targ" for details.
NODE_PREBUILT_VERSION=v0.10.48
NODE_PREBUILT_TAG=gz
ifeq ($(shell uname -s),SunOS)
    NODE_PREBUILT_IMAGE=18b094b0-eb01-11e5-80c1-175dac7ddf02
endif

#
# Stuff used for buildimage
#
# our base image is sdc-minimal-multiarch-lts 15.4.1
BASE_IMAGE_UUID		= 04a48d7d-6bb5-4e83-8c3b-e60a99e0f48f
BUILDIMAGE_NAME		= amon
NAME			= amon
BUILDIMAGE_DESC		= SDC AMON
BUILDIMAGE_DO_PKGSRC_UPGRADE = true
BUILDIMAGE_PKGSRC	= postfix-3.0.2nb3
BUILDIMAGE_PKG		= $(TOP)/$(BUILD)/amon-pkg-$(STAMP).tar.gz
AGENTS = registrar config

#
# Included definitions
#
ENGBLD_USE_BUILDIMAGE	= true
ENGBLD_REQUIRE		:= $(shell git submodule update --init deps/eng)
include deps/eng/tools/mk/Makefile.defs
TOP ?= $(error Unable to access eng.git submodule Makefiles.)


ifeq ($(shell uname -s),SunOS)
       include deps/eng/tools/mk/Makefile.node_prebuilt.defs
       include deps/eng/tools/mk/Makefile.agent_prebuilt.defs
else
       include deps/eng/tools/mk/Makefile.node.defs
endif
include deps/eng/tools/mk/Makefile.smf.defs


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

#
# Due to the unfortunate nature of npm, the Node Package Manager, there appears
# to be no way to assemble our dependencies without running the lifecycle
# scripts.  These lifecycle scripts should not be run except in the context of
# an agent installation or uninstallation, so we provide a magic environment
# varible to disable them here.
#
NPM_ENV = npm_config_cache=$(TOP)/$(BUILD)/.npm SDC_AGENT_SKIP_LIFECYCLE=yes MAKE=$(MAKE)

NODE_DEV := ./node_modules/.bin/node-dev
TAP := ./node_modules/.bin/tap
JSSTYLE_FLAGS := -f tools/jsstyle.conf

#
# Repo-specific targets
#
# We include validate-buildenv here rather than getting
# that dependency added by Makefile.targ so that it explicitly
# gets built first.
#
all: validate-buildenv common plugins agent testbuild relay master dev sdc-scripts


#
# The main amon components
#

.PHONY: common
common: | $(NPM_EXEC) python2-symlink
	(cd common && $(NPM_ENV) $(NPM) install && $(NPM) link)

.PHONY: plugins
plugins: | $(NPM_EXEC)
	(cd plugins && $(NPM_ENV) $(NPM) install && $(NPM) link)

.PHONY: agent
agent: common plugins | $(NPM_EXEC)
	(cd agent && $(NPM) link amon-common amon-plugins && \
	$(NPM_ENV) $(NPM) install)

.PHONY: relay
relay: common plugins testbuild | $(NPM_EXEC)
	(cd relay && $(NPM) link amon-common amon-plugins && \
	$(NPM_ENV) $(NPM) install)

.PHONY: master
master: common plugins | $(NPM_EXEC)
	(cd master && $(NPM) link amon-common amon-plugins && \
	$(NPM_ENV) $(NPM) install)

# 'testbuild' is the name for building in the 'test' dir. Want 'make test'
# to actually *run* the tests.
.PHONY: testbuild
testbuild: | $(NPM_EXEC)
	(cd test && $(NPM_ENV) $(NPM) install)

# "dev" is the name for the top-level dev package
.PHONY: dev
dev: common | $(NPM_EXEC)
	$(NPM) link amon-common
	$(NPM_ENV) $(NPM) install


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
	uuid -v4 > $(BUILD)/pkg/amon-relay/image_uuid
	(cd $(BUILD)/pkg && $(TAR) -I pigz --exclude-from=$(TOP)/tools/amon-relay.exclude \
		-cf ../amon-relay-$(STAMP).tgz amon-relay)
	cat $(TOP)/relay/manifest.tmpl | sed \
		-e "s/UUID/$$(cat $(BUILD)/pkg/amon-relay/image_uuid)/" \
		-e "s/NAME/$$(json name < $(TOP)/relay/package.json)/" \
		-e "s/VERSION/$$(json version < $(TOP)/relay/package.json)/" \
		-e "s/DESCRIPTION/$$(json description < $(TOP)/relay/package.json)/" \
		-e "s/BUILDSTAMP/$(STAMP)/" \
		-e "s/SIZE/$$(stat --printf="%s" $(BUILD)/amon-relay-$(STAMP).tgz)/" \
		-e "s/SHA/$$(openssl sha1 $(BUILD)/amon-relay-$(STAMP).tgz \
		     | cut -d ' ' -f2)/" \
		> $(BUILD)/amon-relay-$(STAMP).manifest
	@echo "Created '$(BUILD)/amon-relay-$(STAMP).{tgz,manifest}'."

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
	uuid -v4 > $(BUILD)/pkg/amon-agent/image_uuid
	(cd $(BUILD)/pkg && $(TAR) --exclude-from=$(TOP)/tools/amon-agent.exclude \
	  -I pigz -cf ../amon-agent-$(STAMP).tgz amon-agent)
	cat $(TOP)/agent/manifest.tmpl | sed \
		-e "s/UUID/$$(cat $(BUILD)/pkg/amon-agent/image_uuid)/" \
		-e "s/NAME/$$(json name < $(TOP)/agent/package.json)/" \
		-e "s/VERSION/$$(json version < $(TOP)/agent/package.json)/" \
		-e "s/DESCRIPTION/$$(json description < $(TOP)/agent/package.json)/" \
		-e "s/BUILDSTAMP/$(STAMP)/" \
		-e "s/SIZE/$$(stat --printf="%s" $(BUILD)/amon-agent-$(STAMP).tgz)/" \
		-e "s/SHA/$$(openssl sha1 $(BUILD)/amon-agent-$(STAMP).tgz \
		     | cut -d ' ' -f2)/" \
		> $(BUILD)/amon-agent-$(STAMP).manifest
	@echo "Created '$(BUILD)/amon-agent-$(STAMP).{tgz,manifest}'."

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
		master/sapi_manifests \
		master/test \
		master/factory-settings.json \
		master/main.js \
		master/package.json \
		$(BUILD)/pkg/master/root/opt/smartdc/amon/
	mkdir -p $(BUILD)/pkg/master/root/opt/smartdc/amon/tools
	cp tools/add-xmpp-notification-type.sh \
	    $(BUILD)/pkg/master/root/opt/smartdc/amon/tools/
	mkdir -p $(BUILD)/pkg/master/root/opt/smartdc/boot
	cp -R deps/sdc-scripts/* $(BUILD)/pkg/master/root/opt/smartdc/boot/
	cp -R boot/* $(BUILD)/pkg/master/root/opt/smartdc/boot/

	# tools/amon-pkg.exclude contains a list of files and patterns of some
	#  unnecessary, duplicated, or dev-only pieces we don't want in the build.
	(cd $(BUILD)/pkg/master \
		&& $(TAR) -I pigz --exclude-from=$(TOP)/tools/amon-pkg.exclude -cf \
		$(shell unset CDPATH; cd $(BUILD); pwd)/amon-pkg-$(STAMP).tar.gz *)
	@echo "Created '$(BUILD)/amon-pkg-$(STAMP).tar.gz'."

# buildimage requires a release target, this is effectively a no-op here.
.PHONY: release
release: pkg_master

# The "publish" target requires that "ENGBLD_BITS_DIR" be defined.
.PHONY: publish
publish: pkg
	@if [[ -z "$(ENGBLD_BITS_DIR)" ]]; then \
		echo "error: 'ENGBLD_BITS_DIR' must be set for 'publish' target"; \
		exit 1; \
	fi
	mkdir -p $(ENGBLD_BITS_DIR)/amon
	cp $(BUILD)/amon-pkg-$(STAMP).tar.gz \
		$(BUILD)/amon-relay-$(STAMP).tgz \
		$(BUILD)/amon-relay-$(STAMP).manifest \
		$(BUILD)/amon-agent-$(STAMP).tgz \
		$(BUILD)/amon-agent-$(STAMP).manifest \
		$(ENGBLD_BITS_DIR)/amon/


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
	ssh $(COAL) /opt/smartdc/agents/lib/node_modules/amon-relay/test/runtests

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
# Amon needs to build with python2, but has "#!/bin/env python" scripts
# that will otherwise find the default python on the build machine.
# Since modern pkgsrc installations have the default as python3, this
# will break the build, so work around that. In cases where the default
# is already python2, this is harmless.
# This all occurs because amon uses an old node, which has an old version
# of gyp. If we move to more modern node, we can probably drop this hack.
#
.PHONY: python2-symlink
python2-symlink:
	mkdir -p $(TOP)/build/agent-python
	if [ -f /opt/local/bin/python2 ]; then \
	    rm -f $(TOP)/build/agent-python/python; \
	    ln -s /opt/local/bin/python2 $(TOP)/build/agent-python/python; \
	fi

#
# Includes
#

include deps/eng/tools/mk/Makefile.deps
include deps/eng/tools/mk/Makefile.targ
ifeq ($(shell uname -s),SunOS)
       include deps/eng/tools/mk/Makefile.node_prebuilt.targ
       include deps/eng/tools/mk/Makefile.agent_prebuilt.targ
else
       include deps/eng/tools/mk/Makefile.node.targ
endif
include deps/eng/tools/mk/Makefile.smf.targ

sdc-scripts: deps/sdc-scripts/.git
