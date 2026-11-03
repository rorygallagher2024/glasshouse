/* SPDX-License-Identifier: GPL-2.0-only */
#ifndef GH_DTS_IEC61937_H
#define GH_DTS_IEC61937_H
#include <stddef.h>
#include <string.h>

struct dts_core_frame { unsigned int bytes, samples; int little; };

static int dts_core_header(const unsigned char *data, size_t length, struct dts_core_frame *frame) {
    unsigned char header[10];
    unsigned int index, blocks;
    if (length < 10) return 0;
    frame->little = !memcmp(data, "\xfe\x7f\x01\x80", 4);
    if (!frame->little && memcmp(data, "\x7f\xfe\x80\x01", 4)) return -1;
    for (index = 0; index < 10; index++) header[index] = data[frame->little ? index ^ 1 : index];
    blocks = ((header[4] & 1u) << 6) | (header[5] >> 2);
    frame->samples = (blocks + 1) * 32;
    frame->bytes = (((header[5] & 3u) << 12) | (header[6] << 4) | (header[7] >> 4)) + 1;
    if (((header[8] >> 2) & 15u) != 13 ||
        (frame->samples != 512 && frame->samples != 1024 && frame->samples != 2048) ||
        frame->bytes < 10 || ((frame->bytes + 1) & ~1u) > frame->samples * 4 - 8) return -1;
    return 1;
}

/* Odd core sizes are swapped as a final
 * word whose missing byte is zero, and Pd counts that padded word, as
 * ffmpeg's spdif muxer does. */
static void dts_core_burst(const unsigned char *data, const struct dts_core_frame *frame, unsigned char *burst) {
    unsigned int index, source, padded = (frame->bytes + 1) & ~1u;
    unsigned int type = frame->samples == 512 ? 11 : frame->samples == 1024 ? 12 : 13;
    memset(burst, 0, frame->samples * 4);
    burst[0] = 0x72; burst[1] = 0xf8; burst[2] = 0x1f; burst[3] = 0x4e;
    burst[4] = type; burst[6] = (padded * 8) & 255; burst[7] = (padded * 8) >> 8;
    for (index = 0; index < padded; index++) {
        source = frame->little ? index : index ^ 1;
        burst[8 + index] = source < frame->bytes ? data[source] : 0;
    }
}

/* DTS-HD extension substream following a core: its total size, 0 when none
 * starts here, -1 when malformed. Sizes are big-endian bit fields after the
 * 8 user bits, 2 index bits and the header-size-type bit. */
static inline int dts_exss_size(const unsigned char *data, size_t length) {
    unsigned long long bits = 0;
    unsigned int index, size;
    if (length < 12 || memcmp(data, "\x64\x58\x20\x25", 4)) return 0;
    for (index = 4; index < 12; index++) bits = bits << 8 | data[index];
    size = (bits >> 53) & 1 ? ((bits >> 21) & 0xfffff) + 1 : ((bits >> 29) & 0xffff) + 1;
    return size < 16 ? -1 : (int)size;
}

/* Wait for the next sync word unless EOS proves the final frame complete.
 * Extension headers and payloads can cross input-buffer boundaries. */
static inline int dts_hd_frame_size(const unsigned char *data, size_t length,
                                    const struct dts_core_frame *core, int eos, unsigned int *total) {
    static const unsigned char sync[4] = {0x64, 0x58, 0x20, 0x25};
    unsigned int extensions = 0;
    size_t at = core->bytes;
    *total = core->bytes;
    if (length < at) return eos ? -2 : 0;
    for (;;) {
        size_t remaining = length - at;
        int size;
        if (!remaining) return eos ? 1 : 0;
        if (remaining < 4) {
            if (!memcmp(data + at, sync, remaining)) return eos ? -2 : 0;
            return 1;
        }
        if (memcmp(data + at, sync, 4)) return 1;
        if (remaining < 12) return eos ? -2 : 0;
        size = dts_exss_size(data + at, remaining);
        if (size < 0 || ++extensions > 4) return -1;
        *total = (unsigned int)at + size;
        if (remaining < (unsigned int)size) return eos ? -2 : 0;
        at += size;
    }
}

/* An IEC 61937 type 17 (DTS-HD) burst, as ffmpeg's spdif muxer builds it:
 * the DTS-HD start code and big-endian payload size precede the core and its
 * extension substream, and the repetition period follows the carrier rate
 * (192000 for two-channel 192 kHz, 768000 for eight-channel HBR).
 * Returns 0 for an unsupported rate or core byte order, or a payload too large
 * for the burst; extensions are never silently replaced by a core-only fallback. */
static inline unsigned int dts_hd_burst(const unsigned char *data, unsigned int total, const struct dts_core_frame *core,
                                        unsigned int rate, unsigned char *burst) {
    static const unsigned char start[10] = {1, 0, 0, 0, 0, 0, 0, 0, 0xfe, 0xfe};
    unsigned int period = rate / 48000 * core->samples, subtype, payload, length, index, source;
    unsigned char head[12];
    for (subtype = 0; subtype < 6 && (512u << subtype) != period; subtype++) {}
    if ((rate != 192000 && rate != 768000) || subtype == 6 || core->little ||
        total < core->bytes || total > period * 4 - 20) return 0;
    payload = total;
    length = ((12 + payload + 8 + 15) & ~15u) - 8;
    memcpy(head, start, 10);
    head[10] = payload >> 8; head[11] = payload & 255;
    memset(burst, 0, period * 4);
    burst[0] = 0x72; burst[1] = 0xf8; burst[2] = 0x1f; burst[3] = 0x4e;
    burst[4] = 17; burst[5] = subtype; burst[6] = length & 255; burst[7] = length >> 8;
    for (index = 0; index < ((12 + payload + 1) & ~1u); index++) {
        source = index ^ 1;
        burst[8 + index] = source < 12 ? head[source] : source < 12 + payload ? data[source - 12] : 0;
    }
    return period * 4;
}
#endif
