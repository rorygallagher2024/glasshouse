/* SPDX-License-Identifier: GPL-2.0-only */
/* File-only DTS-core packetiser used to compare the forwarder with FFmpeg. */
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include "iec61937.h"

int main(int argc, char **argv) {
    unsigned char data[8192], burst[8192];
    struct dts_core_frame frame;
    FILE *input, *output;
    unsigned long frames = 0;
    size_t bytes;
    int descriptor, status = 1;
    if (argc != 4 || strcmp(argv[1], "--pack")) {
        fprintf(stderr, "Usage: %s --pack INPUT.dts NEW_OUTPUT.spdif\n", argv[0]);
        return 2;
    }
    input = fopen(argv[2], "rb");
    if (!input) { perror("DTS input"); return 1; }
    descriptor = open(argv[3], O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (descriptor < 0) { perror("New packed output"); fclose(input); return 1; }
    output = fdopen(descriptor, "wb");
    if (!output) { perror("Packed output"); close(descriptor); fclose(input); return 1; }
    for (;;) {
        bytes = fread(data, 1, 10, input);
        if (!bytes && feof(input)) { status = frames ? 0 : 1; break; }
        if (bytes != 10 || dts_core_header(data, bytes, &frame) != 1) {
            fprintf(stderr, "Expected 16-bit DTS core at 48 kHz; extract its core first\n");
            break;
        }
        if (fread(data + 10, 1, frame.bytes - 10, input) != frame.bytes - 10) {
            fprintf(stderr, "Truncated DTS core frame\n");
            break;
        }
        dts_core_burst(data, &frame, burst);
        if (fwrite(burst, 1, frame.samples * 4, output) != frame.samples * 4) {
            perror("Packed output");
            break;
        }
        frames++;
    }
    if (fclose(input)) status = 1;
    if (fclose(output)) status = 1;
    if (status) unlink(argv[3]);
    fprintf(stderr, "bursts=%lu status=%d\n", frames, status);
    return status;
}
