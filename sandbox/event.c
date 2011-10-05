/*
 * A simple little program to print off ireports from FMA.
 * To compile:
 * gcc -m64 -Wall -pedantic -std=c99 -L/lib/fm/amd64 -L/lib/amd64
 * -R/lib/fm/amd64 -R/lib/amd64 -lfmevent -o event event.c -lnvpair
 */
#include <stdio.h>
#include <stdlib.h>
#include <fm/libfmevent.h>
#include <libnvpair.h>
#include <unistd.h>

static void print_nvlist(nvlist_t *);
static int indent = 0;

static void
print_pair(nvlist_t *nvl, nvpair_t *pair)
{
	char *sval;
	nvlist_t *nvval;
	uint8_t u8val;
	uint32_t u32val;
	int64_t i64val;
	int ii;
	const char *name = nvpair_name(pair);

	for (ii = 0; ii < indent; ii++)
		printf("\t");

	switch(nvpair_type(pair)) {
	case DATA_TYPE_STRING:
		if (nvlist_lookup_string(nvl, name, &sval) != 0) {
			printf("failed to get string for key: %s\n", name);
			break;
		}
		printf("string %s: %s\n", name, sval);
		break;
	case DATA_TYPE_NVLIST:
		if (nvlist_lookup_nvlist(nvl, name, &nvval) != 0) {
			printf("Failed to get nvlist for key: %s\n", name);
			break;
		}	
		printf("nvlist: %s\n", name);
		indent++;
		print_nvlist(nvval);
		indent--;
		break;
	case DATA_TYPE_UINT8:
		if (nvlist_lookup_uint8(nvl, name, &u8val) != 0) {
			printf("failed to get uint8 for key: %s\n", name);
			break;
		}
		printf("uint8 %s: %d\n", name, u8val);
		break;
	case DATA_TYPE_INT64:
		if(nvlist_lookup_int64(nvl, name, &i64val) != 0) {
			printf("failed to get int64 for key: %s\n", name);
			break;
		}
		printf("int64 %s: %ld\n", name, i64val);
		break;
	case DATA_TYPE_UINT32:
		if (nvlist_lookup_uint32(nvl, name, &u32val) != 0) {
			printf("failed to get uint32 for key: %s\n", name);	
			break;
		}
		printf("uint32 %s: %u\n", name, u32val);
		break;
	default:
		printf("key %s - type not yet supported: %d\n",
		    name, nvpair_type(pair));
	}
}

static void
print_nvlist(nvlist_t *nvl)
{
	nvpair_t *pair;
	for (pair = nvlist_next_nvpair(nvl, NULL); pair != NULL;
	    pair = nvlist_next_nvpair(nvl, pair))
		print_pair(nvl, pair);
}

static void
irpt_cbfunc(fmev_t ev, const char *class, nvlist_t *nvl, void *arg)
{
	printf("Got a notification from: %s\n", class);
	print_nvlist(nvl);
	printf("---\n");
}

int
main(void)
{
	fmev_shdl_t hdl;

	hdl = fmev_shdl_init(LIBFMEVENT_VERSION_2, NULL, NULL, NULL);
	if (hdl == NULL) {
		fprintf(stderr, "Failed to create fm handle\n");
		return (1);
	}
	if (fmev_shdl_subscribe(hdl, "ireport.*", irpt_cbfunc, NULL) != FMEV_SUCCESS) {
		fprintf(stderr, "Failed to subscribe\n");
		return (1);
	}

	while (1)
		(void) pause();

	return (0);
}
