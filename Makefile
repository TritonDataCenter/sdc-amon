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
NODE := $(NODEDIR)/bin/node
NODE_WAF := $(NODEDIR)/bin/node-waf
NPM := npm_config_tar=$(TAR) PATH=$(NODEDIR)/bin:$$PATH npm
DOC_CMD = restdown
GLINT = gjslint
GLINT_ARGS = --nojsdoc -e deps,node_modules,node-install -x common/sprintf.js -r .
LINT = ./node_modules/jshint/bin/jshint
LINT_ARGS =
TEST_CMD = ./node_modules/whiskey/bin/whiskey



#
# Targets
#

all:: node

.PHONY: deps agent relay master


deps: $(NODEDIR)/bin/node $(NODEDIR)/bin/npm

$(NODEDIR)/bin/node:
	(GIT_SSL_NO_VERIFY=1 git submodule update --init)
	(cd deps/node && ./configure --prefix=$(NODEDIR) && $(MAKE) -j 4 && $(MAKE) install)

$(NODEDIR)/bin/npm: $(NODEDIR)/bin/node
	(cd deps/npm && npm_config_tar=$(TAR) PATH=$(NODEDIR)/bin:$$PATH $(MAKE) install)


agent: deps
	(cd agent && $(NPM) install)
relay: deps
	(cd relay && $(NPM) install)
master: deps
	(cd master && $(NPM) install)



#TODO: test targets
test:
	(PATH=$(NODEDIR)/bin:$$PATH $(TEST_CMD) --tests tst/checks.test.js)
