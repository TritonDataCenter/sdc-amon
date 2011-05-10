/* Copyright 2011 Joyent, Inc. */

#include <alloca.h>
#include <errno.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <sys/un.h>

#define DEFAULT_SOCKET_PATH "/var/run/.joyent_amon_zwatch.sock"
#define MAX_ATTEMPTS 2
#define WAIT_PERIOD 1
#define LOG_BUF_SZ 27
#define LOG_PREFIX "%s GMT T(%d) %s: "

extern void * zonecfg_notify_bind(int (*func) (const char *zonename,
					       zoneid_t zid,
					       const char *newstate,
					       const char *oldstate,
					       hrtime_t when,
					       void *p),
				  void *p);

extern void zonecfg_notify_unbind(void *);

static void *g_zonecfg_handle = NULL;
static char *g_socket = NULL;

static void chomp(char *s) {
  while (*s && *s != '\n' && *s != '\r')
    s++;
  *s = 0;
}

static void prefix_buffer(char **buffer) {
  struct tm tm = {};
  time_t now;

  now = time(0);
  gmtime_r(&now, &tm);
  asctime_r(&tm, *buffer, LOG_BUF_SZ);
  chomp(*buffer);
}

static void info(const char *fmt, ...) {
  char *buf = NULL;
  va_list alist;

  if ((buf = (char *)alloca(LOG_BUF_SZ)) == NULL)
    return;

  prefix_buffer(&buf);
  va_start(alist, fmt);
  fprintf(stderr, LOG_PREFIX, buf, pthread_self(), "INFO");
  vfprintf(stderr, fmt, alist);
  va_end(alist);
}

static void error(const char *fmt, ...) {
  char *buf = NULL;
  va_list alist;

  if ((buf = (char *)alloca(LOG_BUF_SZ)) == NULL)
    return;

  prefix_buffer(&buf);
  va_start(alist, fmt);
  fprintf(stderr, LOG_PREFIX, buf, pthread_self(), "ERROR");
  vfprintf(stderr, fmt, alist);
  va_end(alist);
}


static boolean_t send_command(const char *zone, const char *command) {
  boolean_t success = B_TRUE;
  int sockfd = -1;
  int addr_len = 0;
  int msg_len = 0;
  char *message = NULL;
  struct sockaddr_un addr;

  msg_len = snprintf(NULL, 0, "%s:%s", zone, command) + 1;
  message = (char *)calloc(1, msg_len);
  if (message == NULL) {
    error("Out of Memory (requested allocation size of %d)\n", msg_len);
    return B_FALSE;
  }
  snprintf(message, msg_len, "%s:%s", zone, command);

  sockfd = socket(PF_UNIX, SOCK_STREAM, 0);
  if (sockfd < 0) {
    error("socket call failed: %s\n", strerror(errno));
    success = B_FALSE;
    goto out;
  }

  addr.sun_family = AF_UNIX;
  addr_len = sizeof (addr.sun_family) + sprintf(addr.sun_path, g_socket);

  if(connect(sockfd, (struct sockaddr *) &addr, addr_len) != 0) {
    error("connect call failed: %s\n", strerror(errno));
    success = B_FALSE;
    goto out;
  }

  write(sockfd, message, msg_len - 1);
  close(sockfd);

out:
  if (message != NULL) {
    free(message);
  }

  return success;
}


static int zone_monitor(const char *zonename,
                        zoneid_t zid,
                        const char *newstate,
                        const char *oldstate,
                        hrtime_t when,
                        void *p) {

  const char *cmd = NULL;
  int attempts = 0;

  if (strcmp("running", newstate) == 0) {
    if (strcmp("ready", oldstate) == 0) {
      cmd = "start";
    }
  } else if (strcmp("shutting_down", newstate) == 0) {
    if (strcmp("running", oldstate) == 0) {
      cmd = "stop";
    }
  }

  if (cmd) {
    do {
      if (!send_command(zonename, cmd)) {
        error("failed to issue command %s for zone %s\n", cmd, zonename);
        sleep(WAIT_PERIOD);
      } else {
        info("command %s issued for zone %s\n", cmd, zonename);
        break;
      }
    } while (++attempts < MAX_ATTEMPTS);
  }

  return 0;
}


int main(int argc, char **argv) {
  int c = 0;
  opterr = 0;

  while ((c = getopt(argc, argv, "sf:d:")) != -1) {
    switch (c) {

      case 's':
        g_socket = strdup(optarg);
        break;
      default:
        (void) fprintf(stderr, "USAGE: %s [OPTION]\n", argv[0]);
        (void) fprintf(stderr, "\t-s=[SOCKET]\n");
        break;
    }
  }
  if (g_socket == NULL) {
    g_socket = strdup(DEFAULT_SOCKET_PATH);
    if (g_socket == NULL) {
      fprintf(stderr, "Out of Memory!\n");
      exit(1);
    }
  }

  g_zonecfg_handle = zonecfg_notify_bind(zone_monitor, NULL);
  if (g_zonecfg_handle == NULL) {
    perror("zonecfg_notify_bind");
    exit(1);
  }

  info("%s started\n", argv[0]);
  pause();

  zonecfg_notify_unbind(g_zonecfg_handle);
  if (g_socket) {
    free(g_socket);
  }

  return 0;
}
