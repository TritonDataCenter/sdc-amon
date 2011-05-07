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
REDIS_SERVER := deps/redis/src/redis-server
DOC_CMD = restdown
GLINT = gjslint
GLINT_ARGS = --nojsdoc -e deps,node_modules,node-install -x common/sprintf.js -r .
LINT = ./node_modules/jshint/bin/jshint
LINT_ARGS =
TEST_CMD = ./node_modules/whiskey/bin/whiskey



#
# Targets
#

all:: agent relay bin/amon-zwatch master

.PHONY: deps agent relay master


deps: $(NODEDIR)/bin/node $(NODEDIR)/bin/npm $(REDIS_SERVER)

# Use 'Makefile' landmarks instead of the dir itself, because dir mtime
# is that of the most recent file: results in unnecessary rebuilds.
deps/redis/Makefile deps/node/Makefile deps/npm/Makefile:
	(GIT_SSL_NO_VERIFY=1 git submodule update --init)

$(NODEDIR)/bin/node: deps/node/Makefile
	(cd deps/node && ./configure --prefix=$(NODEDIR) && $(MAKE) -j 4 && $(MAKE) install)

$(NODEDIR)/bin/npm: $(NODEDIR)/bin/node deps/npm/Makefile
	(cd deps/npm && npm_config_tar=$(TAR) PATH=$(NODEDIR)/bin:$$PATH $(MAKE) install)

$(REDIS_SERVER): deps/redis/Makefile
	(cd deps/redis && make)



agent: deps
	(cd agent && $(NPM) install)

relay: deps
	(cd relay && $(NPM) install)

bin/amon-zwatch:
ifeq ($(UNAME), SunOS)
	${CC} ${CCFLAGS} ${LDFLAGS} -o bin/amon-zwatch $^ zwatch/zwatch.c ${LIBS}
endif

master: deps
	(cd master && $(NPM) install)


master_devrun:
	bin/amon-master -d -f support/dev/amon-master.json


#TODO: test targets
test:
	(PATH=$(NODEDIR)/bin:$$PATH $(TEST_CMD) --tests tst/checks.test.js)


clean:
	(cd deps/npm && $(MAKE) clean)
	(cd deps/node && $(MAKE) distclean)
	(cd deps/redis && $(MAKE) clean)
	rm -rf $(NODEDIR) agent/node_modules relay/node_modules \
		master/node_modules bin/amon-zwatch


