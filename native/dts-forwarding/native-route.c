/* SPDX-License-Identifier: GPL-2.0-only */
/* Private O24 audio interfaces, pinned to the captured 33.31.68 image.
 * Without NATIVE_APPLY the module only audits them; apply builds route a renderer
 * to eARC output 3 under a producer lease. The layout is checked against the stock module. */
#include "target.h"

typedef unsigned long u64;
typedef unsigned int u32;
typedef unsigned char u8;
typedef int (*print_fn)(const char *, ...);
typedef void *(*block_fn)(const char *, unsigned int);
typedef int (*connection_fn)(void *, unsigned int, void *, unsigned int);
typedef int (*disconnect_fn)(void *, unsigned int);
typedef void (*format_fn)(unsigned int, unsigned int);
extern void *kthread_create_on_node(int (*function)(void *), void *data, int node, const char *name, ...);
extern int wake_up_process(void *task);
extern int kthread_stop(void *task);
extern _Bool kthread_should_stop(void);
extern void msleep(unsigned int milliseconds);
extern void mutex_lock(void *mutex);
extern void mutex_unlock(void *mutex);

#ifndef NATIVE_APPLY
#define NATIVE_APPLY 0
#endif
#ifndef NATIVE_SOURCE_INDEX
#define NATIVE_SOURCE_INDEX 0
#endif

#if NATIVE_APPLY
static void *source_block, *old_source_block, *output_block, *watchdog;
static u32 original_nonpcm, original_rate;
static int applied;
static u32 lease = 1;
static u32 restore_pcm;
/* The eARC sample rate for the IEC 61937 carrier: 48000 for the DTS core,
 * 192000 for the eight-channel DTS-HD (HBR) carrier. */
static u32 carrier_rate = 48000;
static u32 hd_ready;
static u32 original_clock_rate, original_clock_flag, original_channels, original_acmod;
static u32 original_audio_mode, original_hal_mute, original_earc_on;
static int hd_saved;

/* Recovered from _bm_disconnect_block_locked and _bm_get_block_port on this
 * exact image: port connections +48, peer port +16, owner +32, port ID +40,
 * public block-info +88. The block-manager operation mutex protects the walk. */
static int output_edge_for(void *output, void **source, u32 *source_port) {
    void *node = ((void *(*)(void *))NATIVE_FIND_BLOCK)(output);
    u8 *port, *head, *entry, *peer, *owner;
    if (!node) return -1;
    port = ((u8 *(*)(void *, u32, u8))NATIVE_GET_PORT)(node, 0, 1);
    if (!port) return -1;
    head = port + 48;
    entry = *(u8 **)head;
    if (entry == head) return 0;
    if (!entry || *(u8 **)entry != head || *(u8 **)(head + 8) != entry) return -1;
    peer = *(u8 **)(entry + 16);
    if (!peer) return -1;
    owner = *(u8 **)(peer + 32);
    if (!owner) return -1;
    *source = *(void **)(owner + 88);
    *source_port = *(u32 *)(peer + 40);
    return 1;
}

static int output_edge(void **source, u32 *source_port) {
    return output_edge_for(output_block, source, source_port);
}

static int valid_output_rate(u32 rate) {
    return rate == 32000 || rate == 44100 || rate == 48000 || rate == 64000 || rate == 88200 ||
        rate == 96000 || rate == 128000 || rate == 176400 || rate == 192000;
}

static int owns_route_locked(void) {
    void *source = (void *)0;
    u32 port = 0;
    return ((block_fn)NATIVE_BM_GET)("renderer", NATIVE_SOURCE_INDEX) == source_block &&
        ((block_fn)NATIVE_BM_GET)("output", 3) == output_block &&
        output_edge(&source, &port) == 1 && source == source_block && port == 0x100;
}

static int owns_route(void) {
    int owned;
    mutex_lock((void *)NATIVE_BM_MUTEX);
    owned = owns_route_locked();
    mutex_unlock((void *)NATIVE_BM_MUTEX);
    return owned;
}

static int output_clock(u32 *rate, u32 *flag) {
    u8 *entry = (u8 *)NATIVE_OUTPUT_CLOCK_ENTRY, *object, *control;
    int result = -19;
    if (!entry[8]) return result;
    mutex_lock(entry + 0x38);
    object = *(u8 **)(entry + 16);
    if (entry[9] && object) {
        control = *(u8 **)(object + 128);
        if (control && *(void **)(control + 32) == (void *)NATIVE_CLOCK_CALLBACK) {
            *rate = *(u32 *)(object + 12);
            *flag = object[16];
            if (valid_output_rate(*rate) && *flag <= 1) result = 0;
        }
    }
    mutex_unlock(entry + 0x38);
    return result;
}

static int hd_format_matches(void) {
    u32 rate = 0, flag = 0;
    return !output_clock(&rate, &flag) && rate == 192000 && flag == original_clock_flag &&
        *(volatile u32 *)NATIVE_HAL_NONPCM == 1 && *(volatile u32 *)NATIVE_HAL_RATE == 192000 &&
        *(volatile u32 *)NATIVE_HAL_CHANNEL_COUNT == 8 &&
        (*(volatile u32 *)NATIVE_HAL_CONTROL & 7) == 6 &&
        ((*(volatile u32 *)NATIVE_HAL_CS0 >> 24) & 15) == 9 &&
        (*(volatile u32 *)NATIVE_HAL_CS0 & 2);
}

/* The clock callback and link reprogramming sleep. Neither block-manager nor
 * clock-table mutex may be held across them. The producer lease owns the UID. */
static int configure_hd(void) {
    u32 uid, format[8] = {192000, 8, 16, 0, 0, 192000, 8, 32};
    int result;
    mutex_lock((void *)NATIVE_BM_MUTEX);
    if (!owns_route_locked() || !*((u8 *)source_block + 77)) {
        mutex_unlock((void *)NATIVE_BM_MUTEX);
        return -16;
    }
    ((void (*)(u32))NATIVE_HAL_MUTE)(1);
    __atomic_store_n(&hd_ready, 0, __ATOMIC_RELEASE);
    uid = *(u32 *)((u8 *)source_block + 52);
    mutex_unlock((void *)NATIVE_BM_MUTEX);
    result = ((int (*)(void *, u32, u32, u32, void *, u32))NATIVE_SEND_COMMAND)
        ((void *)0, 0x50020020, 0, uid, format, sizeof(format));
    if (result < 0) return result;
    msleep(100);
    if (!owns_route()) return -16;
    result = ((int (*)(u32, u32, u32))NATIVE_UPDATE_CLOCK)(3, 192000, original_clock_flag);
    if (result < 0 || !owns_route()) return result < 0 ? result : -16;
    ((void (*)(u32))NATIVE_HAL_MUTE)(1);
    ((format_fn)NATIVE_HAL_CHANNEL)(8, 2);
    ((format_fn)NATIVE_HAL_FORMAT)(1, 192000);
    ((format_fn)NATIVE_HAL_CHANNEL)(8, 2);
    ((void (*)(u32))NATIVE_HAL_SET_ON)(original_earc_on);
    ((print_fn)NATIVE_PRINTK)("\0016gh_dts_native: HD srcbin=%08x, output clock and eARC link configured\n", uid);
    return 0;
}

struct output_state {
    void *output;
    u32 codec, channels, rate, acmod, flag, on;
};

static int same_output_state(const struct output_state *a, const struct output_state *b) {
    return a->output == b->output && a->codec == b->codec && a->channels == b->channels &&
        a->rate == b->rate && a->acmod == b->acmod && a->flag == b->flag && a->on == b->on;
}

static void copy_output_state(void *output, struct output_state *state) {
    volatile u8 *bytes = output;
    state->output = output;
    state->codec = *(volatile u32 *)(bytes + 68);
    state->channels = *(volatile u32 *)(bytes + 72);
    state->rate = *(volatile u32 *)(bytes + 76);
    state->acmod = *(volatile u32 *)(bytes + 80);
    state->flag = *(volatile u32 *)(bytes + 84);
    state->on = bytes[129];
}

static int foreign_output_state(struct output_state *state, int *foreign) {
    struct output_state repeated;
    void *output, *source = (void *)0;
    u32 port = 0;
    int edge, valid = 0;
    *foreign = 0;
    mutex_lock((void *)NATIVE_BM_MUTEX);
    output = ((block_fn)NATIVE_BM_GET)("output", 3);
    if (output && *(u32 *)((u8 *)output + 44) == 3) {
        edge = output_edge_for(output, &source, &port);
        /* An ambiguous input must stay muted: it could still mix our carrier
         * with another source. A single foreign edge belongs entirely to LG. */
        if (edge == 0 || (edge == 1 && (source != source_block || port != 0x100))) {
            *foreign = 1;
            copy_output_state(output, state);
            __atomic_thread_fence(__ATOMIC_ACQUIRE);
            copy_output_state(output, &repeated);
            valid = same_output_state(state, &repeated) && state->codec <= 4 &&
                state->channels > 0 && state->channels <= 8 && valid_output_rate(state->rate) &&
                state->acmod <= 7 && state->flag <= 1 && state->on <= 1;
        }
    }
    mutex_unlock((void *)NATIVE_BM_MUTEX);
    return valid;
}

/* LG suppresses an output status equal to its cache. Replaying its current
 * tuple returns global clock/mute state even when the new source is PCM48
 * like the old one; the foreign connection itself is never changed. */
static void hand_back_output(void) {
    struct output_state state, current;
    u32 rate = 0, flag = 0;
    unsigned int attempt;
    int foreign = 0;
    for (attempt = 0; attempt < 3; attempt++) {
        if (!foreign_output_state(&state, &foreign) || output_clock(&rate, &flag)) {
            msleep(50);
            continue;
        }
        ((int (*)(u32, u32, u32))NATIVE_UPDATE_CLOCK)(3, state.rate, state.flag);
        ((void (*)(u32))NATIVE_HAL_MUTE)(1);
        ((format_fn)NATIVE_HAL_CHANNEL)(state.channels, state.acmod);
        ((format_fn)NATIVE_HAL_FORMAT)(state.codec != 0, state.rate);
        ((format_fn)NATIVE_HAL_CHANNEL)(state.channels, state.acmod);
        if (!foreign_output_state(&current, &foreign) || !same_output_state(&state, &current)) continue;
        ((void (*)(u32))NATIVE_HAL_MUTE)(0);
        ((void (*)(u32))NATIVE_HAL_SET_ON)(state.on);
        if (foreign_output_state(&current, &foreign) && same_output_state(&state, &current)) {
            ((print_fn)NATIVE_PRINTK)("\0016gh_dts_native: returned output to LG codec=%u channels=%u rate=%u\n",
                state.codec, state.channels, state.rate);
            return;
        }
    }
    if (foreign && (*(volatile u32 *)NATIVE_HAL_CS2 & (1U << 18)))
        ((void (*)(u32))NATIVE_HAL_MUTE)(0);
    ((print_fn)NATIVE_PRINTK)("\0013gh_dts_native: LG output handback did not settle; foreign=%d\n", foreign);
}

static void restore_route(void) {
    block_fn block = (block_fn)NATIVE_BM_GET;
    void *current_source = (void *)0, *restored_source = (void *)0;
    u32 current_port = 0;
    int edge, restored = 0, restore_format = 0;
    if (!__atomic_exchange_n(&applied, 0, __ATOMIC_SEQ_CST)) return;
    __atomic_store_n(&hd_ready, 0, __ATOMIC_RELEASE);
    mutex_lock((void *)NATIVE_BM_MUTEX);
    if (block("output", 3) == output_block) {
        edge = output_edge(&current_source, &current_port);
        /* A removed renderer leaves an empty input. A foreign connection
         * belongs to LG's new source and must survive module cleanup. */
        if (edge == 0 || (edge == 1 && current_source == source_block && current_port == 0x100)) {
            void *current_baseline = block(restore_pcm ? "mixer" : "encoder", restore_pcm ? 0 : 3);
            int disconnected = edge == 0 || ((disconnect_fn)NATIVE_DISCONNECT_LOCKED)(output_block, 0) >= 0;
            if (disconnected) {
                restore_format = 1;
                if (hd_saved) ((void (*)(u32))NATIVE_HAL_MUTE)(1);
                if (current_baseline)
                    restored = ((connection_fn)NATIVE_CONNECT_LOCKED)(current_baseline, 0, output_block, 0) >= 0;
                if (restored) restored_source = current_baseline;
            }
        }
    }
    if (restore_format) {
        if (hd_saved) ((format_fn)NATIVE_HAL_CHANNEL)(original_channels, original_acmod);
        ((format_fn)NATIVE_HAL_FORMAT)(original_nonpcm, original_rate);
        if (hd_saved) {
            ((format_fn)NATIVE_HAL_CHANNEL)(original_channels, original_acmod);
            ((void (*)(u32))NATIVE_HAL_AUDIO_MODE)(original_audio_mode);
        }
    }
    mutex_unlock((void *)NATIVE_BM_MUTEX);
    if (restore_format && hd_saved) {
        u32 rate = 0, flag = 0;
        int still_owned, result;
        current_source = (void *)0;
        current_port = 0;
        mutex_lock((void *)NATIVE_BM_MUTEX);
        edge = block("output", 3) == output_block ? output_edge(&current_source, &current_port) : -1;
        still_owned = edge == 0 || (edge == 1 && restored_source && current_source == restored_source && current_port == 0);
        mutex_unlock((void *)NATIVE_BM_MUTEX);
        if (!still_owned) {
            hand_back_output();
            return;
        }
        result = ((int (*)(u32, u32, u32))NATIVE_UPDATE_CLOCK)(3, original_clock_rate, original_clock_flag);
        ((void (*)(u32))NATIVE_HAL_MUTE)(original_hal_mute);
        ((void (*)(u32))NATIVE_HAL_SET_ON)(original_earc_on);
        msleep(100);
        ((print_fn)NATIVE_PRINTK)("\0016gh_dts_native: HD restore clock=%u flag=%u result=%d readback=%d\n",
            original_clock_rate, original_clock_flag, result,
            !output_clock(&rate, &flag) && rate == original_clock_rate && flag == original_clock_flag);
    } else if (hd_saved) {
        hand_back_output();
    }
    ((print_fn)NATIVE_PRINTK)(restored ? "\0016gh_dts_native: original output route restored\n" :
        restore_format ? "\0013gh_dts_native: carrier disconnected and format restored; baseline source unavailable\n" :
        "\0016gh_dts_native: output ownership changed; preserving current route\n");
}

static int watch_route(void *unused) {
    unsigned int tick = 0, previous = lease, phase = 0, stable = 0, attempts = 0;
    (void)unused;
    while (tick < 200 && !kthread_should_stop()) {
        msleep(100);
        tick++;
        if (__atomic_load_n(&lease, __ATOMIC_ACQUIRE) != previous) {
            previous = __atomic_load_n(&lease, __ATOMIC_ACQUIRE);
            tick = 0;
        }
        if (!owns_route()) {
            ((print_fn)NATIVE_PRINTK)("\0016gh_dts_native: output ownership lost\n");
            break;
        }
        if (carrier_rate == 48000) {
            if (*(volatile u32 *)NATIVE_HAL_NONPCM != 1 || *(volatile u32 *)NATIVE_HAL_RATE != 48000) break;
            continue;
        }
        if (phase && !hd_format_matches()) {
            u32 rate = 0, flag = 0;
            ((void (*)(u32))NATIVE_HAL_MUTE)(1);
            __atomic_store_n(&hd_ready, 0, __ATOMIC_RELEASE);
            output_clock(&rate, &flag);
            ((print_fn)NATIVE_PRINTK)("\0016gh_dts_native: HD format changed mode=%u CS0=%08x clock=%u flag=%u\n",
                *(volatile u32 *)NATIVE_HAL_CONTROL & 7, *(volatile u32 *)NATIVE_HAL_CS0, rate, flag);
            phase = stable = 0;
        }
        if (!phase) {
            if (++stable < 2) continue;
            if (++attempts > 8) {
                ((print_fn)NATIVE_PRINTK)("\0013gh_dts_native: HD format recovery attempts exhausted\n");
                break;
            }
            if (configure_hd() < 0) {
                ((print_fn)NATIVE_PRINTK)("\0013gh_dts_native: HD setup lost its route or clock\n");
                break;
            }
            phase = 1;
            stable = 0;
        } else if (phase == 1 && ++stable >= 2) {
            if (!owns_route() || !hd_format_matches()) continue;
            ((void (*)(u32))NATIVE_HAL_MUTE)(original_hal_mute);
            __atomic_store_n(&hd_ready, 1, __ATOMIC_RELEASE);
            phase = 2;
            stable = 0;
            ((print_fn)NATIVE_PRINTK)("\0016gh_dts_native: HD ready after stable output format\n");
        } else if (phase == 2 && ++stable >= 50) {
            attempts = 0;
            stable = 0;
        }
    }
    restore_route();
    /* Keep the task alive until module removal owns kthread_stop(). */
    while (!kthread_should_stop()) msleep(100);
    return 0;
}
#endif

static int fingerprints_match(void) {
    unsigned int check, byte;
    for (check = 0; check < sizeof(native_checks) / sizeof(native_checks[0]); check++) {
        const volatile u8 *actual = (const volatile u8 *)native_checks[check].address;
        for (byte = 0; byte < sizeof(native_checks[check].bytes); byte++)
            if (actual[byte] != native_checks[check].bytes[byte]) return 0;
    }
    return 1;
}

int init_module(void) {
    print_fn print = (print_fn)NATIVE_PRINTK;
    block_fn block = (block_fn)NATIVE_BM_GET;
    if (!fingerprints_match()) return -22;
    print("\0016gh_dts_native: matched 33.31.68 code fingerprints\n");
    print("\0016gh_dts_native: renderer0=%px renderer1=%px output3=%px encoder3=%px\n",
          block("renderer", 0), block("renderer", 1), block("output", 3), block("encoder", 3));
    print("\0016gh_dts_native: initial eARC nonpcm=%u rate=%u\n",
          *(volatile u32 *)NATIVE_HAL_NONPCM, *(volatile u32 *)NATIVE_HAL_RATE);
#if NATIVE_APPLY
    int connected;
    void *current_source = (void *)0;
    u32 current_port = 0;
    if (restore_pcm > 1 || (carrier_rate != 48000 && carrier_rate != 192000)) return -22;
    __atomic_store_n(&hd_ready, 0, __ATOMIC_RELEASE);
    source_block = block("renderer", NATIVE_SOURCE_INDEX);
    old_source_block = block(restore_pcm ? "mixer" : "encoder", restore_pcm ? 0 : 3);
    output_block = block("output", 3);
    if (!source_block || !old_source_block || !output_block) return -19;
    if (carrier_rate == 192000 && (output_clock(&original_clock_rate, &original_clock_flag) ||
        (original_clock_rate != 48000 && original_clock_rate != 192000))) return -19;
    print("\0016gh_dts_native: native PCM bypass head=%08x\n",
          ((u32 (*)(void *))NATIVE_PCM_HEAD)(source_block));
    mutex_lock((void *)NATIVE_BM_MUTEX);
    if (block("renderer", NATIVE_SOURCE_INDEX) != source_block || block("output", 3) != output_block ||
        block(restore_pcm ? "mixer" : "encoder", restore_pcm ? 0 : 3) != old_source_block ||
        output_edge(&current_source, &current_port) != 1 || current_source != old_source_block || current_port != 0) {
        mutex_unlock((void *)NATIVE_BM_MUTEX);
        print("\0013gh_dts_native: refused; the eARC output route changed during start\n");
        return -16;
    }
    original_nonpcm = *(volatile u32 *)NATIVE_HAL_NONPCM;
    original_rate = *(volatile u32 *)NATIVE_HAL_RATE;
    if (original_nonpcm > 1 || (original_rate != 48000 && original_rate != 192000)) {
        mutex_unlock((void *)NATIVE_BM_MUTEX);
        print("\0013gh_dts_native: refused; unexpected eARC baseline nonpcm=%u rate=%u\n", original_nonpcm, original_rate);
        return -22;
    }
    if (carrier_rate == 192000) {
        original_channels = *(volatile u32 *)NATIVE_HAL_CHANNEL_COUNT;
        original_acmod = *(volatile u32 *)NATIVE_HAL_CHANNEL_ACMOD;
        original_audio_mode = *(volatile u32 *)NATIVE_HAL_CONTROL & 7;
        original_hal_mute = (*(volatile u32 *)NATIVE_HAL_CS2 >> 18) & 1;
        original_earc_on = *((u8 *)output_block + 129);
        if (*(u32 *)((u8 *)output_block + 44) != 3 || !*((u8 *)source_block + 77) ||
            (original_channels != 2 && original_channels != 6 && original_channels != 8) ||
            original_acmod > 7 || original_hal_mute != 0 || original_earc_on != 1) {
            mutex_unlock((void *)NATIVE_BM_MUTEX);
            print("\0013gh_dts_native: refused HD baseline channels=%u acmod=%u mute=%u earc=%u\n",
                  original_channels, original_acmod, original_hal_mute, original_earc_on);
            return -22;
        }
        hd_saved = 1;
        ((void (*)(u32))NATIVE_HAL_MUTE)(1);
        print("\0016gh_dts_native: HD baseline clock=%u flag=%u channels=%u acmod=%u mode=%u\n",
            original_clock_rate, original_clock_flag, original_channels, original_acmod, original_audio_mode);
    }
    applied = 1;
    ((disconnect_fn)NATIVE_DISCONNECT_LOCKED)(output_block, 0);
    connected = ((connection_fn)NATIVE_CONNECT_LOCKED)(source_block, 0x100, output_block, 0);
    mutex_unlock((void *)NATIVE_BM_MUTEX);
    print("\0016gh_dts_native: native PCM carrier route result=%d\n", connected);
    if (connected < 0) { restore_route(); return connected; }
    ((format_fn)NATIVE_HAL_FORMAT)(1, carrier_rate);
    watchdog = kthread_create_on_node(watch_route, (void *)0, -1, "gh-dts-guard");
    if ((u64)watchdog >= (u64)-4095) { watchdog = (void *)0; restore_route(); return -12; }
    wake_up_process(watchdog);
    print("\0016gh_dts_native: renderer%d PCM-bypass -> eARC at %u; 20-second producer lease\n", NATIVE_SOURCE_INDEX, carrier_rate);
#endif
    return 0;
}

void cleanup_module(void) {
#if NATIVE_APPLY
    if (watchdog) kthread_stop(watchdog);
    restore_route();
#endif
    ((print_fn)NATIVE_PRINTK)("\0016gh_dts_native: unloaded\n");
}

/* Linux's loader initialises the remaining fields. These offsets and the
 * complete 0x380-byte layout are audited against aspectratiodrv.ko, rather
 * than borrowing headers from a different configured vendor kernel. */
struct target_module {
    u8 prefix[24];
    char name[56];
    u8 before_init[0x150 - 80];
    int (*initialise)(void);
    u8 before_exit[0x338 - 0x158];
    void (*finish)(void);
    u8 suffix[0x380 - 0x340];
};
_Static_assert(sizeof(struct target_module) == 0x380, "module size");
_Static_assert(__builtin_offsetof(struct target_module, initialise) == 0x150, "module init");
_Static_assert(__builtin_offsetof(struct target_module, finish) == 0x338, "module exit");
struct target_module __this_module __attribute__((section(".gnu.linkonce.this_module"), aligned(64), used)) = {
    .name = "gh_dts_native", .initialise = init_module, .finish = cleanup_module
};
#if NATIVE_APPLY
/* Linux 5.4 moduleparam.h: three pointers, u16/s8/u8, then pointer union. */
extern int param_set_uint(const char *value, const void *parameter);
extern int param_get_uint(char *value, const void *parameter);
static const struct {
    unsigned int flags;
    int (*set)(const char *, const void *);
    int (*get)(char *, const void *);
    void (*free)(void *);
} uint_operations = {0, param_set_uint, param_get_uint, (void *)0};
struct target_parameter {
    const char *name;
    struct target_module *module;
    const void *operations;
    unsigned short permissions;
    signed char level;
    unsigned char flags;
    void *argument;
};
_Static_assert(sizeof(struct target_parameter) == 40, "parameter size");
static const struct target_parameter parameters[] __attribute__((section("__param"), aligned(8), used)) = {
    {"lease", &__this_module, &uint_operations, 0600, -1, 0, &lease},
    {"active", &__this_module, &uint_operations, 0400, -1, 0, &applied},
    {"restore_pcm", &__this_module, &uint_operations, 0400, -1, 0, &restore_pcm},
    {"carrier_rate", &__this_module, &uint_operations, 0400, -1, 0, &carrier_rate},
    {"hd_ready", &__this_module, &uint_operations, 0400, -1, 0, &hd_ready}
};
#endif
static const char module_license[] __attribute__((section(".modinfo"), used)) = "license=GPL";
static const char module_vermagic[] __attribute__((section(".modinfo"), used)) = NATIVE_VERMAGIC;
static const char module_description[] __attribute__((section(".modinfo"), used)) = "description=Glasshouse native DTS exact-target eARC forwarding route";
__asm__(".pushsection .plt,\"ax\",%progbits\n.byte 0\n.popsection\n"
        ".pushsection .init.plt,\"a\",%progbits\n.byte 0\n.popsection\n"
        ".pushsection .text.ftrace_trampoline,\"ax\",%progbits\n.byte 0\n.popsection\n");
