<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2014, Joyent, Inc.
-->

A bin dir for the build that requires (because of gyp in one of its deps) that
the first `python` on the PATH be Python 2.6 or greater.  This is a pain with a
smartos zone with both python24 and python26 installed, with `pkg_alternatives`
installed /opt/local/bin/python might be python2.4 or python2.6 depending on
install order.

We already require "python2.6" to be on the PATH somewhere (but not first),
so we use this bindir to reduce the former requirement to the latter.
