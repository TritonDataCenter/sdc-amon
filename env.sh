os=`uname`
if [[ "$os" == 'Darwin' ]]; then
    echo -e "\n -+-+-\n"
    echo -e "WARNING: YOU HAVE to run this:\n"
    echo "launchctl limit maxfiles 8192"
fi

ulimit -n 2048
export AMON_MASTER=http://localhost:8080
export PATH=$PWD/deps/node-install/bin:$PWD/bin:$PWD/deps/riak/rel/riak/bin:$PATH
export MANPATH=$PWD/deps/riak/doc/man:$MANPATH
