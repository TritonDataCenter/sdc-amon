#!/usr/bin/env python
#
# Massage the given Javascript file as liked by jsstyle -- at least by
# the jsstyle configured in amon's jsstyle.conf.
#

from os.path import *
import os
import sys
import re
import codecs
import difflib

INDENT = '  '


def jsstyle_it_mommy(path, dry_run=False):
    before = codecs.open(path, 'r', 'utf-8').read()
    after = before

    after = change_quotes(after)
    after = space_keyword_and_paren(after)
    after = if_test_return_oneliner(after)

    if after == before:
        print "jsstyle-it-mommy '%s' (no change)" % path
    elif dry_run:
        print "jsstyle-it-mommy '%s' (would be updated, dry-run)" % path
        print ''.join(difflib.unified_diff(before.splitlines(True),
            after.splitlines(True), 'before', 'after'))
    else:
        codecs.open(path, 'w', 'utf-8').write(after)
        print "jsstyle-it-mommy '%s' (updated)" % path

def change_quotes(text):
    """Change string literal quotes in JS files from double to single."""
    # "foo" ... "bar" -> 'foo' ... 'bar'
    text = re.compile(r'''^([^'"\n]*?)"([^'\n]*?)"([^'"\n]*?)"([^'\n]*?)"''', re.M) \
        .sub(r"""\1'\2'\3'\4'""", text)

    # "foo" -> 'foo'
    text = re.compile(r'''^([^'"\n]*?)"([^'\n]*?)"''', re.M) \
        .sub(r"\1'\2'", text)

    # "foo'd" -> 'foo\'d'
    text = re.compile(r'''^([^'"\n]*?)"([^'\n]*?)'([^'\n]*?)"''', re.M) \
        .sub(r"""\1'\2\\'\3'""", text)

    # "foo 'bar' baz" -> 'foo "bar" baz'
    text = re.compile(r'''^([^'"\n]*?)"([^'\n]*?)'([^'\n]*?)'([^'\n]*?)"''', re.M) \
        .sub(r"""\1'\2"\3"\4'""", text)

    # "foo 'bar' baz 'blah'" -> 'foo "bar" baz "blah"'
    text = re.compile(r'''^([^'"\n]*?)"([^'\n]*?)'([^'\n]*?)'([^'\n]*?)'([^'\n]*?)'([^'\n]*?)"''', re.M) \
        .sub(r"""\1'\2"\3"\4"\5"\6'""", text)
    return text

def space_keyword_and_paren(text):
    """Put a space btwn keywords and open paren."""
    text = re.compile(r'function\(').sub(r'function (', text)
    text = re.compile(r'catch\(').sub(r'catch (', text)
    text = re.compile(r'typeof\(').sub(r'typeof (', text)
    return text

def if_test_return_oneliner(text):
    """`if (test) return foo;` -> `if (test)\n<INDENT>return foo;`

    Ditto for `if (test) throw ...;`
    """
    text = re.compile(r'''^(\s*)(if \(.*?\)) return''', re.M) \
        .sub(r"\1\2\n\1%sreturn" % INDENT, text)
    text = re.compile(r'''^(\s*)(if \(.*?\)) throw''', re.M) \
        .sub(r"\1\2\n\1%sthrow" % INDENT, text)
    return text



#---- mainline

def main(argv):
    args = argv[1:]
    dry_run = False
    if args and args[0] in ('-n', '--dry-run'):
        dry_run = True
        args = args[1:]
    for path in args:
        jsstyle_it_mommy(path, dry_run)


sys.exit(main(sys.argv))
