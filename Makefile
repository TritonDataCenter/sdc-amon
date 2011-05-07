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
HAVE_GJSLINT := $(shell which gjslint >/dev/null && echo yes || echo no)
WHISKEY = bin/whiskey



#
# Targets
#

all:: common plugins agent relay bin/amon-zwatch master

.PHONY: deps agent relay master common plugins test lint gjslint jshint


#
# deps
#

deps:	$(NODEDIR)/bin/node $(NODEDIR)/bin/npm $(REDIS_SERVER) \
	$(NODEDIR)/lib/node_modules/whiskey $(NODEDIR)/lib/node_modules/jshint

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
	(cd relay && $(NPM) install)

bin/amon-zwatch:
ifeq ($(UNAME), SunOS)
	${CC} ${CCFLAGS} ${LDFLAGS} -o bin/amon-zwatch $^ zwatch/zwatch.c ${LIBS}
endif

master: deps
	(cd master && $(NPM) install && $(NPM) link amon-common amon-plugins)

master_devrun:
	bin/amon-master -d -f support/dev/amon-master.json


#
# Lint, test and miscellaneous targets
#

jshint: deps
	bin/node $(NODEDIR)/lib/node_modules/jshint/bin/jshint common/lib plugins/lib master/main.js master/lib relay/main.js relay/lib agent/main.js agent/lib

gjslint:
	gjslint --nojsdoc -e deps,node_modules -x common/lib/sprintf.js -r .

ifeq ($(HAVE_GJSLINT), yes)
lint: jshint gjslint
else
lint: jshint
	@echo "* * *"
	@echo "* Warning: Cannot lint with gjslint. Install it from:"
	@echo "*    http://code.google.com/closure/utilities/docs/linter_howto.html"
	@echo "* * *"
endif


test:
	PATH=$(NODEDIR)/bin:$$PATH $(WHISKEY) --timeout 1000 --tests "$(shell find . -name "*.test.js" | grep -v 'node_modules/' | xargs)"



clean:
	(cd deps/npm && $(MAKE) clean)
	(cd deps/node && $(MAKE) distclean)
	(cd deps/redis && $(MAKE) clean)
	rm -rf $(NODEDIR) agent/node_modules relay/node_modules \
		master/node_modules bin/amon-zwatch


